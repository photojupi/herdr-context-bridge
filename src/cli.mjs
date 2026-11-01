#!/usr/bin/env node
import {getLocale,t,localizeMessage} from './i18n.mjs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {stateDirectory,readJson,safeId} from './storage.mjs';
import {validateConfig} from './policy.mjs';
import {getStatus,saveConfig,bindSession,startHandoff,runJob,reconcileJobs} from './bridge.mjs';

const [command,...args]=process.argv.slice(2),stateDir=stateDirectory();
const json=()=>JSON.parse(args[0]||'{}');
const stdin=async()=>{let data='';for await(const chunk of process.stdin){data+=chunk;if(data.length>16*1024*1024)throw new Error(t('입력이 너무 큽니다.'));}return data;};
try {
  let result;
  switch(command) {
    case 'locale':result={locale:getLocale()};break;
    case 'status':result=await getStatus();break;
    case 'config':result=args.length?await saveConfig(json()):validateConfig(await readJson(join(stateDir,'config.json'),{}));break;
    case 'sessions':result={sessions:await (await import('./sessions.mjs')).listSessions(args[0],args[1],{stateDir})};break;
    case 'bind':result=await bindSession(json());break;
    case 'handoff':result=await startHandoff(json());break;
    case 'job':await reconcileJobs();result=await readJson(join(stateDir,'jobs',safeId(args[0])+'.json'));if(!result)throw new Error(t('인계 작업을 찾을 수 없습니다.'));if(result.error)result.error=localizeMessage(result.error);break;
    case 'worker':await runJob(args[0]);break;
    case 'capture':await (await import('./capture.mjs')).capture(args[0],JSON.parse(await stdin()),{stateDir,env:process.env});break;
    case 'statusline':{
      const output=await (await import('./capture.mjs')).runStatusLine(await stdin(),{provider:args[0]||'claude',stateDir,env:process.env});
      if(output.stdout)process.stdout.write(output.stdout);if(output.stderr)process.stderr.write(output.stderr);process.exitCode=output.code;break;
    }
    default:result={name:'herdr-context-bridge',commands:['locale','status','config','sessions','bind','handoff','job'],version:'0.1.0'};
  }
  if(result!==undefined)process.stdout.write(JSON.stringify(result)+'\n');
} catch(error) {
  if(['capture','statusline'].includes(command)) {process.exitCode=0;}
  else {process.stdout.write(JSON.stringify({error:error.message})+'\n');process.exitCode=1;}
}
