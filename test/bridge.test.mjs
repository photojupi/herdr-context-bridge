import {t as message} from '../src/i18n.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {atomicJson,readJson} from '../src/storage.mjs';
import {startHandoff,runJob,bindSession,reconcileJobs,saveConfig,getStatus} from '../src/bridge.mjs';
import {capture} from '../src/capture.mjs';

async function fixture(provider='claude') {
  const stateDir=await mkdtemp(join(tmpdir(),'bridge-job-'));
  const source={provider,id:'abc',cwd:'/tmp/project',terminalId:'t1',trustedBinding:true,updatedAt:Date.now(),...(provider==='agy'?{observationSource:'statusline',agentIdle:true}:{})};
  await atomicJson(join(stateDir,'sessions',`${provider}-abc.json`),source);
  await atomicJson(join(stateDir,'terminals','t1.json'),source);
  const terminals=async()=>[{address:'t1',cwd:'/tmp/project',agent:provider==='claude'?'claude-code':provider==='agy'?'antigravity':provider,status:'idle',state:'live'}];
  const spaces=async()=>[{id:'space1',machine:null,tabs:[{id:'tab1',terminals:[{terminal:'t1'}]}]}];
  return {stateDir,source,terminals,spaces,installed:()=>true,spawnWorker:()=>{}};
}
test('all six provider handoff routes preserve the source directory and selected target',async()=>{
  for(const provider of ['claude','codex','agy']) for(const target of ['claude','codex','agy'].filter(value=>value!==provider)) {
    const options=await fixture(provider);
    const {jobId}=await startHandoff({sourceKey:`${provider}:abc`,target},options);
    let launch;
    await runJob(jobId,{...options,createBundle:async()=>({directory:'/tmp/bundle',prompt:'read'}),launch:async args=>{launch=args;return {terminal:'t2'};}});
    assert.deepEqual(launch.argv.slice(2),['launch',target,jobId,'0','read']);
    assert.equal(launch.folder,options.source.cwd);
  }
});
test('AGY handoff requires fresh idle statusLine state before and after export',async()=>{
  for(const change of [{agentIdle:false},{updatedAt:Date.now()-600001}]) {
    const options=await fixture('agy');
    await atomicJson(join(options.stateDir,'sessions','agy-abc.json'),{...options.source,...change});
    await assert.rejects(startHandoff({sourceKey:'agy:abc',target:'codex'},options));
  }
  const options=await fixture('agy');
  const {jobId}=await startHandoff({sourceKey:'agy:abc',target:'claude'},options);
  await runJob(jobId,{...options,createBundle:async()=>{
    await atomicJson(join(options.stateDir,'sessions','agy-abc.json'),{...options.source,agentIdle:false});
    return {directory:'/tmp/bundle',prompt:'read'};
  },launch:async()=>assert.fail('A working AGY source must not launch a target')});
  assert.equal((await readJson(join(options.stateDir,'jobs',jobId+'.json'))).status,'failed');
});
test('AGY handoff permissions are explicitly bound and propagated only for that session',async()=>{
  const options=await fixture('agy');
  options.listSessions=async()=>[options.source];
  const input={terminalId:'t1',provider:'agy',id:'abc',cwd:options.source.cwd};
  await assert.rejects(bindSession({...input,handoffPermissionMode:'yolo'},options));
  const binding=await bindSession({...input,handoffPermissionMode:'bypass'},options);
  assert.equal(binding.handoffPermissionMode,'bypass');
  const {jobId}=await startHandoff({sourceKey:'agy:abc',target:'codex'},options);
  let launch;
  await runJob(jobId,{...options,createBundle:async()=>({directory:'/tmp/bundle',prompt:'read'}),launch:async args=>{launch=args;return {terminal:'t2'};}});
  assert.equal(launch.argv.at(-1),'bypass');
  assert.equal((await readJson(join(options.stateDir,'jobs',jobId+'.json'))).permissionMode,'bypass');
});
test('automatic AGY routes require a selected target and recheck that target after export',async()=>{
  const options=await fixture('agy');
  await assert.rejects(saveConfig({mode:'auto',autoSessions:['agy:abc']},options));
  await saveConfig({mode:'auto',autoSessions:['agy:abc'],autoTargets:{'agy:abc':'claude'}},options);
  for(const [provider,remainingPercent] of [['agy',5],['claude',90],['codex',90]]) await atomicJson(join(options.stateDir,`quota-${provider}.json`),{provider,observedAt:Date.now(),windows:[{id:'test',remainingPercent,resetsAt:Date.now()+60000}]});
  await assert.rejects(startHandoff({sourceKey:'agy:abc',target:'codex',automatic:true},options));
  const {jobId}=await startHandoff({sourceKey:'agy:abc',target:'claude',automatic:true},options);
  await runJob(jobId,{...options,createBundle:async()=>{
    await saveConfig({autoTargets:{'agy:abc':'codex'}},options);
    return {directory:'/tmp/bundle',prompt:'read'};
  },launch:async()=>assert.fail('A changed automatic destination must not launch')});
  assert.equal((await readJson(join(options.stateDir,'jobs',jobId+'.json'))).status,'failed');
});
test('status follows registered AGY destinations and does not auto-launch while AGY is busy',async()=>{
  for(const agentIdle of [true,false]) {
    const options=await fixture('agy');
    const source={...options.source,agentIdle};
    await atomicJson(join(options.stateDir,'sessions','agy-abc.json'),source);
    await atomicJson(join(options.stateDir,'terminals','t1.json'),source);
    await saveConfig({mode:'auto',autoSessions:['agy:abc'],autoTargets:{'agy:abc':'codex'}},options);
    for(const [provider,remainingPercent] of [['agy',5],['claude',90],['codex',90]]) await atomicJson(join(options.stateDir,`quota-${provider}.json`),{provider,observedAt:Date.now(),windows:[{id:'test',remainingPercent,resetsAt:Date.now()+60000}]});
    const status=await getStatus(options);
    assert.equal(status.jobs.length,agentIdle?1:0);
    if(agentIdle)assert.equal(status.jobs[0].target,'codex');
  }
});
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
  assert.equal(launch.argv[0],process.execPath);
  assert.deepEqual(launch.argv.slice(2,-1),['launch','codex',jobId,'0']);
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

test('handoff maps confirmed source bypass to the target and records the selected mode',async()=>{
  for(const provider of ['claude','codex']) {
    const options=await fixture();
    await capture(provider,{session_id:'abc',cwd:'/tmp/project',hook_event_name:'SessionStart',permission_mode:'bypassPermissions'},{stateDir:options.stateDir,env:{HC_TERMINAL_ID:'t1'}});
    options.terminals=async()=>[{address:'t1',cwd:'/tmp/project',agent:provider,status:'idle',state:'live'}];
    const target=provider==='claude'?'codex':'claude';
    const {jobId}=await startHandoff({sourceKey:`${provider}:abc`,target},options);
    let launch;
    await runJob(jobId,{...options,createBundle:async()=>({directory:'/tmp/bundle',manifest:{permissionMode:provider==='codex'?'bypass':'default'},prompt:'read'}),launch:async args=>{launch=args;return {terminal:'t2'};}});
    assert.deepEqual(launch.argv.slice(2),['launch',target,jobId,'0','read','bypass']);
    assert.equal((await readJson(join(options.stateDir,'jobs',jobId+'.json'))).permissionMode,'bypass');
  }
});

test('handoff rechecks Claude permission mode after creating the bundle',async()=>{
  const options=await fixture(),captureOptions={stateDir:options.stateDir,env:{HC_TERMINAL_ID:'t1'}};
  const event={session_id:'abc',cwd:'/tmp/project',hook_event_name:'Stop'};
  await capture('claude',{...event,permission_mode:'bypassPermissions'},captureOptions);
  const {jobId}=await startHandoff({sourceKey:'claude:abc',target:'codex'},options);
  let launch;
  await runJob(jobId,{...options,createBundle:async()=>{
    await capture('claude',{...event,permission_mode:'default'},captureOptions);
    return {directory:'/tmp/bundle',manifest:{permissionMode:'bypass'},prompt:'read'};
  },launch:async args=>{launch=args;return {terminal:'t2'};}});
  assert.deepEqual(launch.argv.slice(2),['launch','codex',jobId,'0','read']);
  assert.equal((await readJson(join(options.stateDir,'jobs',jobId+'.json'))).permissionMode,'default');
});

test('Codex hook and caller-supplied bypass cannot replace missing rollout evidence',async()=>{
  const options=await fixture();
  await capture('codex',{session_id:'abc',cwd:'/tmp/project',hook_event_name:'SessionStart',permission_mode:'bypassPermissions'},{stateDir:options.stateDir,env:{HC_TERMINAL_ID:'t1'}});
  options.terminals=async()=>[{address:'t1',cwd:'/tmp/project',agent:'codex',status:'idle',state:'live'}];
  const {jobId}=await startHandoff({sourceKey:'codex:abc',target:'claude',permissionMode:'bypass'},options);
  let launch;
  await runJob(jobId,{...options,createBundle:async()=>({directory:'/tmp/bundle',prompt:'read'}),launch:async args=>{launch=args;return {terminal:'t2'};}});
  assert.deepEqual(launch.argv.slice(2),['launch','claude',jobId,'0','read']);
  assert.equal((await readJson(join(options.stateDir,'jobs',jobId+'.json'))).permissionMode,'default');
});

test('a Codex resume or approval change during export invalidates bypass evidence',async()=>{
  for(const [hook,permission_mode] of [['SessionStart','bypassPermissions'],['Stop','default'],['Stop','bypassPermissions']]) {
    const options=await fixture(),captureOptions={stateDir:options.stateDir,env:{HC_TERMINAL_ID:'t1'}};
    const event={session_id:'abc',cwd:'/tmp/project',permission_mode:'bypassPermissions'};
    await capture('codex',{...event,hook_event_name:'SessionStart'},captureOptions);
    options.terminals=async()=>[{address:'t1',cwd:'/tmp/project',agent:'codex',status:'idle',state:'live'}];
    const {jobId}=await startHandoff({sourceKey:'codex:abc',target:'claude'},options);
    let launch;
    await runJob(jobId,{...options,createBundle:async()=>{
      await capture('codex',{...event,hook_event_name:hook,permission_mode},captureOptions);
      return {directory:'/tmp/bundle',manifest:{permissionMode:'bypass'},prompt:'read'};
    },launch:async args=>{launch=args;return {terminal:'t2'};}});
    assert.deepEqual(launch.argv.slice(2),['launch','claude',jobId,'0','read']);
    assert.equal((await readJson(join(options.stateDir,'jobs',jobId+'.json'))).permissionMode,'default');
  }
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

test('installed CLIs and empty failed caches do not display an unobserved account',async()=>{
  const options=await fixture();
  await atomicJson(join(options.stateDir,'quota-claude.json'),{provider:'claude',observedAt:Date.now(),windows:[],error:'No usage'});
  await atomicJson(join(options.stateDir,'quota-agy.json'),{provider:'agy',observedAt:Date.now(),windows:[]});
  const status=await getStatus({...options,readCodexQuota:async()=>({provider:'codex',observedAt:Date.now(),windows:[],error:'Not signed in'})});
  assert.deepEqual(status.quotas,{});
  assert.equal(status.installed.agy,true);
});

test('status displays observed AGY buckets and legacy usage without inferring authentication from bindings',async()=>{
  const options=await fixture(),now=Date.now();
  await atomicJson(join(options.stateDir,'quota-claude.json'),{provider:'claude',observedAt:now-700000,windows:[{id:'five_hour',remainingPercent:0,resetsAt:now+60000}]});
  await atomicJson(join(options.stateDir,'quota-agy.json'),{provider:'agy',accountObserved:true,observedAt:now,windows:[{id:'custom-bucket',label:'custom-bucket',remainingPercent:42,resetsAt:now+60000}]});
  const status=await getStatus({...options,readCodexQuota:async()=>({provider:'codex',observedAt:now,windows:[],error:'No account'})});
  assert.deepEqual(Object.keys(status.quotas),['claude','agy']);
  assert.equal(status.quotas.agy.windows[0].remainingPercent,42);
  assert.equal(status.quotas.claude.observedAt,now-700000);
  assert.equal(status.config.mode,'ask');
  assert.ok((await startHandoff({sourceKey:'claude:abc',target:'agy'},options)).jobId);
});

test('an official observed account remains visible when no percentage is available',async()=>{
  const options=await fixture();
  const status=await getStatus({...options,readCodexQuota:async()=>({provider:'codex',accountObserved:true,observedAt:Date.now(),windows:[],error:'No subscription quota'})});
  assert.deepEqual(Object.keys(status.quotas),['codex']);
  assert.deepEqual(status.quotas.codex.windows,[]);
});

test('later query failures retain observed account history without retaining stale capacity',async()=>{
  const options=await fixture(),now=Date.now();
  await atomicJson(join(options.stateDir,'quota-codex.json'),{provider:'codex',observedAt:now-61000,windows:[{id:'codex:primary',remainingPercent:80,resetsAt:now+60000}]});
  let status=await getStatus({...options,readCodexQuota:async()=>{throw new Error('Temporary failure');}});
  assert.equal(status.quotas.codex.accountObserved,true);
  assert.deepEqual(status.quotas.codex.windows,[]);
  const saved=await readJson(join(options.stateDir,'quota-codex.json'));
  assert.equal(saved.accountObserved,true);
  await atomicJson(join(options.stateDir,'quota-codex.json'),{...saved,observedAt:now-61000});
  status=await getStatus({...options,readCodexQuota:async()=>({provider:'codex',observedAt:Date.now(),windows:[],error:'Still unavailable'})});
  assert.equal(status.quotas.codex.accountObserved,true);
  assert.deepEqual(status.quotas.codex.windows,[]);
});

test('status does not invoke a missing Codex CLI or show empty provider placeholders',async()=>{
  const options=await fixture();
  const status=await getStatus({...options,installed:async()=>false,readCodexQuota:async()=>{assert.fail('Missing CLI must not be launched');}});
  assert.deepEqual(status.quotas,{});
  assert.deepEqual(status.installed,{claude:false,codex:false,agy:false});
});
