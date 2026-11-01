import {t,localizeMessage} from './i18n.mjs';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {open,mkdir,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {atomicJson,readJson,jsonRecords,stateDirectory,safeId} from './storage.mjs';
import {validateConfig,decideHandoff,autoTarget,FRESH_MS} from './policy.mjs';
import {hasAccountObservation,localizeQuota} from './quota.mjs';
import {resolveCommand} from './commands.mjs';

const execFileAsync=promisify(execFile);
const cliPath=fileURLToPath(new URL('./cli.mjs',import.meta.url));
export const providerOf=agent=>agent==='claude-code'||agent==='claude'?'claude':agent==='codex'?'codex':['agy','antigravity','antigravity-cli'].includes(agent)?'agy':null;
const keyOf=s=>`${s.provider}:${s.id}`;
function parseKey(key) {
  const [provider,id,...rest]=String(key).split(':');
  if(!['claude','codex','agy'].includes(provider)||rest.length) throw new Error(t('잘못된 세션입니다.'));
  safeId(id); return {provider,id};
}
export async function commandJson(binary,args) {
  const command=await resolveCommand(binary);
  const {stdout}=await execFileAsync(command.file,[...command.args,...args],{timeout:20000,maxBuffer:8*1024*1024,windowsHide:true});
  const result=JSON.parse(stdout);
  if(result.error) throw new Error(typeof result.error==='string'?result.error:result.error.message);
  return result;
}
export async function liveTerminals() { return (await commandJson('hc',['ls','--json'])).terminals || []; }
export async function liveSpaces() { return (await commandJson('herdr-app',['ls'])).spaces || []; }
export async function installedCli(name) {
  try { await resolveCommand(name); return true; } catch { return false; }
}
async function configAt(dir) { return validateConfig(await readJson(join(dir,'config.json'),{})); }
export async function saveConfig(input,{stateDir=stateDirectory()}={}) {
  const config=validateConfig({...await configAt(stateDir),...input});
  for(const key of config.mode==='auto'?config.autoSessions:[]) {
    const s=await sourceAt(key,stateDir);
    if(s.autoOrigin) throw new Error(t('연결된 원본 세션만 자동 인계에 등록할 수 있습니다.'));
    if(!autoTarget(config,s)) throw new Error(t('다른 제공자를 대상으로 선택해 주세요.'));
  }
  await atomicJson(join(stateDir,'config.json'),config); return config;
}
async function sourceAt(key,dir) {
  const {provider,id}=parseKey(key);
  const source=await readJson(join(dir,'sessions',`${provider}-${id}.json`));
  if(!source||!source.trustedBinding||!source.terminalId||source.discoveryWarnings?.length) throw new Error(t('원본 세션을 먼저 연결해 주세요.'));
  safeId(source.terminalId);
  const current=await readJson(join(dir,'terminals',`${source.terminalId}.json`));
  if(!current||keyOf(current)!==key) throw new Error(t('터미널의 세션이 바뀌었습니다. 다시 연결해 주세요.'));
  const origin=await readJson(join(dir,'origins',`${source.terminalId}.json`));
  return {...source,autoOrigin:!!(source.autoOrigin||current.autoOrigin||origin?.autoOrigin)};
}
const agyReady=source=>source.observationSource==='statusline'&&source.agentIdle===true&&Number.isFinite(source.updatedAt)&&source.updatedAt<=Date.now()+60000&&Date.now()-source.updatedAt<=FRESH_MS;
function sourceTerminal(source,terminals) {
  const terminal=terminals.find(t=>t.address===source.terminalId);
  if(!terminal||terminal.state!=='live'||providerOf(terminal.agent)!==source.provider||terminal.cwd!==source.cwd) throw new Error(t('원본 터미널과 세션 연결을 다시 확인해 주세요.'));
  if(source.provider==='agy'&&!agyReady(source)) throw new Error(t('AGY 상태줄에서 최신 유휴 상태를 확인해야 합니다.'));
  if(!['idle','done'].includes(terminal.status)&&!(terminal.status==='blocked'&&source.error==='rate_limit')) throw new Error(t('원본 작업이 진행 중이거나 승인을 기다립니다. 작업이 멈춘 뒤 인계해 주세요.'));
  return terminal;
}
function sourceSpace(source,spaces) {
  const matches=spaces.filter(space=>space.machine==null&&space.tabs?.some(tab=>tab.terminals?.some(t=>t.terminal===source.terminalId)));
  if(matches.length!==1||typeof matches[0].id!=='string') throw new Error(t('원본 터미널의 로컬 공간(space)을 확인할 수 없습니다.'));
  return matches[0].id;
}
export async function bindSession(input,options={}) {
  const dir=options.stateDir||stateDirectory();
  safeId(input.terminalId); parseKey(`${input.provider}:${input.id}`);
  if(input.handoffPermissionMode!==undefined&&(input.provider!=='agy'||!['default','bypass'].includes(input.handoffPermissionMode))) throw new Error(t('잘못된 세션입니다.'));
  const terminals=await (options.terminals||liveTerminals)();
  const terminal=terminals.find(t=>t.address===input.terminalId);
  if(!terminal||providerOf(terminal.agent)!==input.provider||terminal.cwd!==input.cwd) throw new Error(t('선택한 터미널의 폴더 또는 에이전트가 바뀌었습니다.'));
  const list=options.listSessions||(await import('./sessions.mjs')).listSessions;
  const sessions=await list(input.provider,input.cwd,{stateDir:dir});
  const chosen=sessions.find(s=>s.id===input.id);
  if(!chosen||chosen.provider!==input.provider||chosen.cwd!==input.cwd) throw new Error(t('현재 폴더에서 선택한 세션을 확인할 수 없습니다.'));
  if(chosen.discoveryWarnings?.length) throw new Error(t('최신 세션 정보가 불명확합니다. 원본의 hook과 cwd를 새로 확인한 뒤 연결해 주세요.'));
  const previous=await readJson(join(dir,'sessions',`${input.provider}-${input.id}.json`),{});
  const current=await readJson(join(dir,'terminals',`${input.terminalId}.json`),{});
  const lifecycle=keyOf(current)===`${input.provider}:${input.id}`?{...previous,...current}:previous;
  const origin=await readJson(join(dir,'origins',`${input.terminalId}.json`));
  const source={...lifecycle,...chosen,terminalId:input.terminalId,trustedBinding:true,boundAt:Date.now(),bindingSource:'user'};
  if(input.handoffPermissionMode!==undefined)source.handoffPermissionMode=input.handoffPermissionMode;
  if(lifecycle.autoOrigin||current.autoOrigin||chosen.autoOrigin||origin?.autoOrigin)source.autoOrigin=true;
  await atomicJson(join(dir,'sessions',`${source.provider}-${source.id}.json`),source);
  await atomicJson(join(dir,'terminals',`${source.terminalId}.json`),source);
  return source;
}
const lockFile=(dir,key)=>join(dir,'locks',createHash('sha256').update(key).digest('hex')+'.lock');
function processAlive(pid) {
  if(!Number.isInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}
}
async function releaseJobLock(dir,job) {
  const path=lockFile(dir,job.sourceKey);
  const owner=await readJson(path);
  if(owner?.jobId===job.id)await unlink(path).catch(()=>{});
}
export async function reconcileJobs(options={}) {
  const dir=options.stateDir||stateDirectory(),now=options.now??Date.now();
  for(const job of await jsonRecords(join(dir,'jobs'))) {
    if(job.status!=='preparing'||now-job.createdAt<30000)continue;
    if((options.isAlive||processAlive)(job.workerPid))continue;
    const path=join(dir,'jobs',safeId(job.id)+'.json');
    if((await readJson(path))?.status!=='preparing')continue;
    const launchUncertain=!!job.launchStartedAt;
    await atomicJson(path,{...job,status:'failed',launchUncertain,finishedAt:now,error:launchUncertain?t('대상 생성 중 연결이 끊겼습니다. 중복 실행을 막기 위해 잠금을 유지했습니다. 새 인계 탭을 확인해 주세요.'):t('인계 준비 프로그램이 중단되었습니다. 원본을 확인하고 수동으로 다시 시도할 수 있습니다.')});
    if(!launchUncertain)await releaseJobLock(dir,job);
  }
}
async function acquire(dir,key,id) {
  await mkdir(join(dir,'locks'),{recursive:true,mode:0o700});
  const path=lockFile(dir,key);
  try { const f=await open(path,'wx',0o600); await f.writeFile(JSON.stringify({jobId:id,createdAt:Date.now()})); await f.close(); }
  catch(e) { if(e.code==='EEXIST') throw new Error(t('이미 이 세션의 인계가 진행 중이거나 완료되었습니다.')); throw e; }
}
export async function startHandoff(input,options={}) {
  const dir=options.stateDir||stateDirectory();
  await reconcileJobs(options);
  const source=await sourceAt(input.sourceKey,dir);
  if(!['claude','codex','agy'].includes(input.target)||input.target===source.provider) throw new Error(t('다른 제공자를 대상으로 선택해 주세요.'));
  const terminal=sourceTerminal(source,await (options.terminals||liveTerminals)());
  const space=sourceSpace(source,await (options.spaces||liveSpaces)());
  if(input.space&&input.space!==space)throw new Error(t('선택한 공간(space)이 원본 터미널의 현재 공간과 다릅니다.'));
  const installed=await (options.installed||installedCli)(input.target);
  if(!installed) throw new Error(t('대상 CLI를 찾을 수 없습니다.'));
  if(input.automatic) {
    const config=await configAt(dir);
    const decision=decideHandoff({config,source,target:input.target,status:terminal.status,installed,sourceQuota:await readJson(join(dir,`quota-${source.provider}.json`)),targetQuota:await readJson(join(dir,`quota-${input.target}.json`))});
    if(decision.action!=='auto') throw new Error(t('자동 인계 불가: {reason}',{reason:decision.reason}));
    const attempted=await readJson(join(dir,'auto-attempts',`${source.provider}-${source.id}.json`));
    if(attempted) throw new Error(t('자동 인계는 이미 시도했습니다. 수동으로 상태를 확인해 주세요.'));
  }
  const id=randomUUID();
  await acquire(dir,input.sourceKey,id);
  const job={id,status:'preparing',sourceKey:input.sourceKey,target:input.target,source,automatic:input.automatic===true,space,createdAt:Date.now()};
  try {
    await atomicJson(join(dir,'jobs',id+'.json'),job);
    if(job.automatic) await atomicJson(join(dir,'auto-attempts',`${source.provider}-${source.id}.json`),{jobId:id});
    if(options.spawnWorker) await options.spawnWorker(id);
    else {
      const child=spawn(process.execPath,[cliPath,'worker',id],{detached:true,stdio:'ignore',windowsHide:true,env:{...process.env,HERDR_BRIDGE_STATE_DIR:dir}});
      await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);}); child.unref();
    }
    return {jobId:id};
  } catch(e) {
    await atomicJson(join(dir,'jobs',id+'.json'),{...job,status:'failed',error:e.message});
    await unlink(lockFile(dir,input.sourceKey)).catch(()=>{}); throw e;
  }
}
export async function runJob(id,options={}) {
  const dir=options.stateDir||stateDirectory(); safeId(id);
  const path=join(dir,'jobs',id+'.json'); const job=await readJson(path);
  if(!job||job.status!=='preparing') throw new Error(t('실행 가능한 인계 작업이 없습니다.'));
  job.workerPid=process.pid;
  await atomicJson(path,job);
  try {
    let source=await sourceAt(job.sourceKey,dir);
    sourceTerminal(source,await (options.terminals||liveTerminals)());
    const permissionUpdatedAt=source.updatedAt;
    const createBundle=options.createBundle||(await import('./bundle.mjs')).createBundle;
    const bundle=await createBundle(source,{stateDir:dir});
    // Recheck after snapshot: an idle source may have started a new turn.
    source=await sourceAt(job.sourceKey,dir);
    sourceTerminal(source,await (options.terminals||liveTerminals)());
    if(sourceSpace(source,await (options.spaces||liveSpaces)())!==job.space)throw new Error(t('준비 중 원본 터미널의 공간(space)이 바뀌었습니다. 다시 확인해 주세요.'));
    if(job.automatic) {
      const decision=decideHandoff({config:await configAt(dir),source,target:job.target,status:'idle',installed:true,sourceQuota:await readJson(join(dir,`quota-${source.provider}.json`)),targetQuota:await readJson(join(dir,`quota-${job.target}.json`))});
      if(decision.action!=='auto') throw new Error(t('준비 중 자동 인계 조건이 바뀌었습니다. 수동으로 확인해 주세요.'));
    }
    if((await readJson(path))?.status!=='preparing')throw new Error(t('중단된 인계 작업입니다.'));
    const bypass=source.provider==='claude'?source.permissionMode==='bypass'
      :source.provider==='agy'?source.handoffPermissionMode==='bypass'
      :bundle.manifest?.permissionMode==='bypass'&&source.approvalBypass===true&&source.updatedAt===permissionUpdatedAt;
    job.permissionMode=bypass?'bypass':'default';
    job.launchStartedAt=Date.now();
    await atomicJson(path,job);
    const args={name:t('{provider} · 인계 {id}',{provider:{claude:'Claude',codex:'Codex',agy:'AGY'}[job.target],id:id.slice(0,8)}),folder:source.cwd,argv:[process.execPath,cliPath,'launch',job.target,id,job.automatic?'1':'0',bundle.prompt]};
    if(job.permissionMode==='bypass')args.argv.push('bypass');
    if(job.space) args.space=job.space;
    const result=await (options.launch|| (args=>commandJson('herdr-app',['do','tab.new',JSON.stringify(args)])))(args);
    if(!result?.terminal) throw new Error(t('새 터미널 생성 결과를 확인할 수 없습니다.'));
    await atomicJson(path,{...job,status:'launched',directory:bundle.directory,terminalId:result.terminal,tabId:result.tab,launchedAt:Date.now(),delivery:'initial-cli-prompt'});
    await atomicJson(join(dir,'origins',`${safeId(result.terminal)}.json`),{jobId:id,autoOrigin:job.automatic,createdAt:Date.now()});
  } catch(e) {
    const launchUncertain=!!job.launchStartedAt;
    await atomicJson(path,{...job,status:'failed',launchUncertain,error:launchUncertain?t('대상 생성 결과가 불명확합니다. 중복 실행을 막기 위해 잠금을 유지했습니다. 새 인계 탭을 확인해 주세요.'):e.message,finishedAt:Date.now()});
    if(!launchUncertain)await releaseJobLock(dir,job);
  }
}
export async function getStatus(options={}) {
  const dir=options.stateDir||stateDirectory();
  await reconcileJobs(options);
  let config=await configAt(dir);
  const installed=Object.fromEntries(await Promise.all(['claude','codex','agy'].map(async provider=>[provider,await (options.installed||installedCli)(provider)])));
  let codex=await readJson(join(dir,'quota-codex.json'));
  if(installed.codex&&(!codex||Date.now()-codex.observedAt>=60000)) {
    const previousAccountId=codex?.accountId;
    const accountObserved=hasAccountObservation(codex);
    try { codex=await (options.readCodexQuota||(await import('./quota.mjs')).readCodexQuota)(); }
    catch(e) { codex={provider:'codex',observedAt:Date.now(),windows:[],error:e.message}; }
    if(accountObserved) codex.accountObserved=true;
    if(previousAccountId&&codex.accountId&&previousAccountId!==codex.accountId) {
      config={...config,autoSessions:[]};
      await atomicJson(join(dir,'config.json'),config);
    }
    await atomicJson(join(dir,'quota-codex.json'),codex);
  }
  const claude=await readJson(join(dir,'quota-claude.json'));
  const agy=await readJson(join(dir,'quota-agy.json'));
  const quotas=Object.fromEntries(Object.entries({claude,codex,agy}).filter(([,quota])=>hasAccountObservation(quota)).map(([provider,quota])=>[provider,localizeQuota(quota)]));
  let terminals=[],terminalError=null;
  try { terminals=await (options.terminals||liveTerminals)(); } catch(e) { terminalError=e.message; }
  const bindings=(await jsonRecords(join(dir,'terminals'))).filter(s=>terminals.some(t=>t.address===s.terminalId&&t.cwd===s.cwd&&providerOf(t.agent)===s.provider));
  for(const source of bindings) {
    const origin=await readJson(join(dir,'origins',`${safeId(source.terminalId)}.json`));
    if(origin?.autoOrigin) source.autoOrigin=true;
    const target=autoTarget(config,source),terminal=terminals.find(t=>t.address===source.terminalId);
    const attempted=await readJson(join(dir,'auto-attempts',`${source.provider}-${source.id}.json`));
    source.decision=decideHandoff({config,source,target,sourceQuota:quotas[source.provider],targetQuota:quotas[target],status:source.provider==='agy'&&!agyReady(source)?'working':terminal.status,installed:installed[target],already:!!attempted});
    if(source.decision.action==='auto') {
      try { await startHandoff({sourceKey:keyOf(source),target,automatic:true},options); }
      catch(e) { source.decision={action:'ask',reason:e.message}; }
    }
  }
  const jobs=(await jsonRecords(join(dir,'jobs'))).sort((a,b)=>b.createdAt-a.createdAt).slice(0,20);
  return {config,quotas,bindings,installed,jobs:jobs.map(job=>({...job,...(job.error?{error:localizeMessage(job.error)}:{})})),now:Date.now(),terminalError};
}
