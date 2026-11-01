import {t} from './i18n.mjs';
import {mkdir,readFile,writeFile,rename,readdir,unlink} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

export function homeDirectory(env=process.env,platform=process.platform) {
  return (platform==='win32' ? env.USERPROFILE || (env.HOMEDRIVE && env.HOMEPATH ? env.HOMEDRIVE+env.HOMEPATH : null) : env.HOME) || homedir();
}
export function stateDirectory(env=process.env,platform=process.platform) {
  return env.HERDR_BRIDGE_STATE_DIR || join(homeDirectory(env,platform),'.local','state','herdr-context-bridge');
}
export function safeId(value) {
  if(typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(value)) throw new Error(t('잘못된 식별자입니다.'));
  return value;
}
export async function readJson(path,fallback=null) {
  try { return JSON.parse(await readFile(path,'utf8')); }
  catch(error) { if(error.code==='ENOENT') return fallback; throw error; }
}
export async function atomicJson(path,value) {
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const temp=`${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
    for(let attempt=0;;attempt++) {
      try { await rename(temp,path); break; }
      catch(error) {
        // Windows can briefly deny replacement while another writer closes the file.
        if(process.platform!=='win32' || !['EPERM','EBUSY','EACCES'].includes(error.code) || attempt===5) throw error;
        await delay(10*2**attempt);
      }
    }
  } finally { await unlink(temp).catch(()=>{}); }
}
export async function jsonRecords(dir) {
  let names;
  try { names=await readdir(dir); } catch(e) { if(e.code==='ENOENT') return []; throw e; }
  return Promise.all(names.filter(n=>n.endsWith('.json')).map(n=>readJson(join(dir,n))));
}
