import {t as message} from '../src/i18n.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {atomicJson,readJson} from '../src/storage.mjs';
import {startHandoff,runJob,bindSession,reconcileJobs,saveConfig,getStatus} from '../src/bridge.mjs';

async function fixture() {
  const stateDir=await mkdtemp(join(tmpdir(),'bridge-job-'));
  const source={provider:'claude',id:'abc',cwd:'/tmp/project',terminalId:'t1',trustedBinding:true,updatedAt:Date.now()};
  await atomicJson(join(stateDir,'sessions','claude-abc.json'),source);
  await atomicJson(join(stateDir,'terminals','t1.json'),source);
  const terminals=async()=>[{address:'t1',cwd:'/tmp/project',agent:'claude-code',status:'idle',state:'live'}];
  const spaces=async()=>[{id:'space1',machine:null,tabs:[{id:'tab1',terminals:[{terminal:'t1'}]}]}];
  return {stateDir,source,terminals,spaces,installed:()=>true,spawnWorker:()=>{}};
}
test('automatic request cannot bypass default approval setting',async()=>{
  const options=await fixture();
  await assert.rejects(startHandoff({sourceKey:'claude:abc',target:'codex',automatic:true},options),error=>error.message.startsWith(message('자동 인계 불가: {reason}',{reason:''})));
});
test('working source cannot be handed off and original is never sent input',async()=>{
  const options=await fixture();
  options.terminals=async()=>[{address:'t1',cwd:'/tmp/project',agent:'claude-code',status:'working',state:'live'}];
  await assert.rejects(startHandoff({sourceKey:'claude:abc',target:'codex'},options),{message:message('원본 작업이 진행 중이거나 승인을 기다립니다. 작업이 멈춘 뒤 인계해 주세요.')});
});
test('concurrent approvals create one job and reject a duplicate',async()=>{
  const options=await fixture();
  const results=await Promise.allSettled([1,2].map(()=>startHandoff({sourceKey:'claude:abc',target:'codex',space:'space1'},options)));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(results.filter(x=>x.status==='rejected').length,1);
});
test('job launches a new tab in the source directory with ordinary permissions',async()=>{
  const options=await fixture();
  const {jobId}=await startHandoff({sourceKey:'claude:abc',target:'codex',space:'space1'},options);
  let launch;
  await runJob(jobId,{...options,createBundle:async()=>({directory:'/tmp/bundle',manifest:{},prompt:'Read /tmp/bundle/START_HERE.md'}),launch:async(args)=>{launch=args;return {terminal:'t2',tab:'tab2'};}});
  const job=await readJson(join(options.stateDir,'jobs',jobId+'.json'));
  assert.equal(job.status,'launched');
  assert.equal(launch.folder,'/tmp/project');
  assert.equal(launch.space,'space1');
  assert.equal(launch.argv.at(-1),'Read /tmp/bundle/START_HERE.md');
  assert.ok(launch.argv.includes('--no-daemon'));
  assert.ok(!JSON.stringify(launch).includes('--yolo'));
  assert.deepEqual(await readJson(join(options.stateDir,'sessions','claude-abc.json')),options.source);
});
test('launch failure after dispatch stays uncertain and prevents a duplicate target',async()=>{
  const options=await fixture();
  const {jobId}=await startHandoff({sourceKey:'claude:abc',target:'codex'},options);
  await runJob(jobId,{...options,createBundle:async()=>({directory:'/tmp/bundle',manifest:{},prompt:'read'}),launch:async()=>{throw new Error('launch failed');}});
  assert.equal((await readJson(join(options.stateDir,'jobs',jobId+'.json'))).status,'failed');
  assert.equal((await readJson(join(options.stateDir,'sessions','claude-abc.json'))).id,'abc');
  assert.equal((await readJson(join(options.stateDir,'jobs',jobId+'.json'))).launchUncertain,true);
  await assert.rejects(startHandoff({sourceKey:'claude:abc',target:'codex'},options),{message:message('이미 이 세션의 인계가 진행 중이거나 완료되었습니다.')});
});
test('manual binding validates an actual candidate and live cwd',async()=>{
  const options=await fixture();
  options.listSessions=async()=>[{provider:'claude',id:'new',cwd:'/tmp/project',updatedAt:1}];
  await assert.rejects(bindSession({terminalId:'t1',provider:'claude',id:'wrong',cwd:'/tmp/project'},options),{message:message('현재 폴더에서 선택한 세션을 확인할 수 없습니다.')});
  const binding=await bindSession({terminalId:'t1',provider:'claude',id:'new',cwd:'/tmp/project'},options);
  assert.equal(binding.id,'new');
  assert.equal(binding.trustedBinding,true);
});
test('a crashed worker becomes failed and releases the source for a manual retry',async()=>{
  const options=await fixture();
  const {jobId}=await startHandoff({sourceKey:'claude:abc',target:'codex'},options);
  const path=join(options.stateDir,'jobs',jobId+'.json');
  await atomicJson(path,{...await readJson(path),workerPid:12345,createdAt:Date.now()-60000});
  await reconcileJobs({...options,isAlive:()=>false});
  assert.equal((await readJson(path)).status,'failed');
  assert.ok((await startHandoff({sourceKey:'claude:abc',target:'codex'},options)).jobId);
});
test('a crash after launch starts stays ambiguous and does not permit a duplicate target',async()=>{
  const options=await fixture();
  const {jobId}=await startHandoff({sourceKey:'claude:abc',target:'codex'},options);
  const path=join(options.stateDir,'jobs',jobId+'.json');
  await atomicJson(path,{...await readJson(path),workerPid:12345,launchStartedAt:Date.now()-50000,createdAt:Date.now()-60000});
  await reconcileJobs({...options,isAlive:()=>false});
  assert.equal((await readJson(path)).launchUncertain,true);
  await assert.rejects(startHandoff({sourceKey:'claude:abc',target:'codex'},options),{message:message('이미 이 세션의 인계가 진행 중이거나 완료되었습니다.')});
});

async function arm(options) {
  const now=Date.now();
  await atomicJson(join(options.stateDir,'config.json'),{mode:'auto',threshold:10,autoSessions:['claude:abc']});
  for(const [provider,remainingPercent] of [['claude',5],['codex',80]]) await atomicJson(join(options.stateDir,`quota-${provider}.json`),{provider,observedAt:now,windows:[{id:'session',remainingPercent,resetsAt:now+60000}]});
}
test('ambiguous discovery candidate cannot be promoted to a trusted binding',async()=>{
  const options=await fixture();
  options.listSessions=async()=>[{...options.source,discoveryWarnings:['latest cwd is unknown'],trustedBinding:false}];
  await assert.rejects(bindSession({terminalId:'t1',provider:'claude',id:'abc',cwd:'/tmp/project'},options),{message:message('최신 세션 정보가 불명확합니다. 원본의 hook과 cwd를 새로 확인한 뒤 연결해 주세요.')});
  assert.deepEqual(await readJson(join(options.stateDir,'sessions','claude-abc.json')),options.source);
});
test('manual rebinding preserves session lifecycle and automatic origin',async()=>{
  const options=await fixture();
  const original={...options.source,autoOrigin:true,error:'rate_limit',transcriptPath:'/profile/abc.jsonl',event:'Stop',observedAt:123};
  await atomicJson(join(options.stateDir,'sessions','claude-abc.json'),original);
  await atomicJson(join(options.stateDir,'terminals','t1.json'),original);
  options.listSessions=async()=>[{provider:'claude',id:'abc',cwd:'/tmp/project',updatedAt:5}];
  const rebound=await bindSession({terminalId:'t1',provider:'claude',id:'abc',cwd:'/tmp/project'},options);
  assert.equal(rebound.autoOrigin,true);
  assert.equal(rebound.error,'rate_limit');
  assert.equal(rebound.transcriptPath,'/profile/abc.jsonl');
  assert.equal(rebound.event,'Stop');
  await assert.rejects(saveConfig({mode:'auto',autoSessions:['claude:abc']},options),{message:message('연결된 원본 세션만 자동 인계에 등록할 수 있습니다.')});
});
test('manual binding cannot erase an origin recorded only by target terminal id',async()=>{
  const options=await fixture();
  await atomicJson(join(options.stateDir,'origins','t1.json'),{autoOrigin:true,jobId:'old-job'});
  options.listSessions=async()=>[{provider:'claude',id:'abc',cwd:'/tmp/project',updatedAt:5,autoOrigin:false}];
  const rebound=await bindSession({terminalId:'t1',provider:'claude',id:'abc',cwd:'/tmp/project'},options);
  assert.equal(rebound.autoOrigin,true);
  await assert.rejects(saveConfig({mode:'auto',autoSessions:['claude:abc']},options),{message:message('연결된 원본 세션만 자동 인계에 등록할 수 있습니다.')});
});
test('origin guard protects config and automatic handoff without prior manual rebind',async()=>{
  const options=await fixture();
  await atomicJson(join(options.stateDir,'origins','t1.json'),{autoOrigin:true,jobId:'old-job'});
  await assert.rejects(saveConfig({mode:'auto',autoSessions:['claude:abc']},options),{message:message('연결된 원본 세션만 자동 인계에 등록할 수 있습니다.')});
  await arm(options);
  await assert.rejects(startHandoff({sourceKey:'claude:abc',target:'codex',automatic:true},options),error=>error.message.startsWith(message('자동 인계 불가: {reason}',{reason:''})));
});
test('automatic handoff targets the source terminal space even without input.space',async()=>{
  const options=await fixture();
  await arm(options);
  const {jobId}=await startHandoff({sourceKey:'claude:abc',target:'codex',automatic:true},options);
  let launch;
  await runJob(jobId,{...options,createBundle:async()=>({directory:'/tmp/bundle',prompt:'read'}),launch:async(args)=>{launch=args;return {terminal:'t2'};}});
  assert.equal(launch.space,'space1');
  assert.equal((await readJson(join(options.stateDir,'jobs',jobId+'.json'))).space,'space1');
});
test('stale or forged space cannot redirect the new target to another space',async()=>{
  const options=await fixture();
  await assert.rejects(startHandoff({sourceKey:'claude:abc',target:'codex',space:'different-space'},options),{message:message('선택한 공간(space)이 원본 터미널의 현재 공간과 다릅니다.')});
});
test('source moving spaces during snapshot prevents a stale-space target launch',async()=>{
  const options=await fixture();
  const {jobId}=await startHandoff({sourceKey:'claude:abc',target:'codex'},options);
  let launched=false;
  await runJob(jobId,{...options,createBundle:async()=>{options.spaces=async()=>[{id:'moved-space',machine:null,tabs:[{terminals:[{terminal:'t1'}]}]}];return {directory:'/tmp/bundle',prompt:'read'};},spaces:()=>options.spaces(),launch:async()=>{launched=true;return {terminal:'t2'};}});
  assert.equal(launched,false);
  assert.equal((await readJson(join(options.stateDir,'jobs',jobId+'.json'))).status,'failed');
});
test('a known Codex account change disarms automatic session registrations',async()=>{
  const options=await fixture();
  await arm(options);
  const quota=await readJson(join(options.stateDir,'quota-codex.json'));
  await atomicJson(join(options.stateDir,'quota-codex.json'),{...quota,accountId:'previous',observedAt:Date.now()-61000});
  let spawned=false;
  const status=await getStatus({...options,readCodexQuota:async()=>({...quota,accountId:'new',observedAt:Date.now()}),spawnWorker:()=>{spawned=true;}});
  assert.deepEqual(status.config.autoSessions,[]);
  assert.deepEqual((await readJson(join(options.stateDir,'config.json'))).autoSessions,[]);
  assert.equal(spawned,false);
});
test('first known Codex account observation does not masquerade as an account change',async()=>{
  const options=await fixture();
  await arm(options);
  const quota=await readJson(join(options.stateDir,'quota-codex.json'));
  await atomicJson(join(options.stateDir,'quota-codex.json'),{...quota,observedAt:Date.now()-61000});
  await atomicJson(join(options.stateDir,'quota-claude.json'),{provider:'claude',observedAt:Date.now(),windows:[]});
  const status=await getStatus({...options,readCodexQuota:async()=>({...quota,accountId:'first-known',observedAt:Date.now()})});
  assert.deepEqual(status.config.autoSessions,['claude:abc']);
});

test('pre-launch snapshot failure releases the source for a manual retry',async()=>{
  const options=await fixture();
  const {jobId}=await startHandoff({sourceKey:'claude:abc',target:'codex'},options);
  await runJob(jobId,{...options,createBundle:async()=>{throw new Error('snapshot failed');}});
  const failed=await readJson(join(options.stateDir,'jobs',jobId+'.json'));
  assert.equal(failed.status,'failed');
  assert.ok(!failed.launchUncertain);
  assert.ok((await startHandoff({sourceKey:'claude:abc',target:'codex'},options)).jobId);
});
test('a reused auto-origin terminal cannot lose its lineage by selecting another session',async()=>{
  const options=await fixture();
  await atomicJson(join(options.stateDir,'terminals','t1.json'),{...options.source,autoOrigin:true});
  options.listSessions=async()=>[{provider:'claude',id:'new',cwd:'/tmp/project',updatedAt:5}];
  const rebound=await bindSession({terminalId:'t1',provider:'claude',id:'new',cwd:'/tmp/project'},options);
  assert.equal(rebound.autoOrigin,true);
  await assert.rejects(saveConfig({mode:'auto',autoSessions:['claude:new']},options),{message:message('연결된 원본 세션만 자동 인계에 등록할 수 있습니다.')});
});
test('approval mode can always be restored after an armed binding becomes stale',async()=>{
  const options=await fixture();
  await arm(options);
  await atomicJson(join(options.stateDir,'terminals','t1.json'),{...options.source,id:'other-session'});
  const config=await saveConfig({mode:'ask'},options);
  assert.equal(config.mode,'ask');
  await assert.rejects(saveConfig({mode:'auto'},options),{message:message('터미널의 세션이 바뀌었습니다. 다시 연결해 주세요.')});
});
