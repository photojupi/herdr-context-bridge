import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {atomicJson,readJson, safeId,stateDirectory} from '../src/storage.mjs';

async function renameFault(context,{platform='win32',code,failures=2}) {
  const dir=await mkdtemp(join(tmpdir(),'bridge-state-rename-'));
  context.after(()=>rm(dir,{recursive:true,force:true}));
  const script=`
    import fs from 'node:fs/promises';
    import assert from 'node:assert/strict';
    import {syncBuiltinESMExports} from 'node:module';
    import {join} from 'node:path';
    const dir=${JSON.stringify(dir)},path=join(dir,'state.json');
    const before={title:'이전'},after={title:'인계'};
    await fs.writeFile(path,JSON.stringify(before));
    const originalRename=fs.rename,originalUnlink=fs.unlink;
    let attempts=0,lastError,temp;
    const unlinked=[];
    fs.rename=async (from,to)=>{
      attempts++;
      assert.equal(to,path);
      assert.equal(from,temp??from);
      temp=from;
      assert.deepEqual(JSON.parse(await fs.readFile(path,'utf8')),before);
      assert.deepEqual(JSON.parse(await fs.readFile(from,'utf8')),after);
      if(attempts<=${failures}){
        lastError=Object.assign(new Error('injected rename failure'),{code:${JSON.stringify(code)}});
        throw lastError;
      }
      return originalRename(from,to);
    };
    fs.unlink=async candidate=>{
      unlinked.push(candidate);
      return originalUnlink(candidate);
    };
    syncBuiltinESMExports();
    Object.defineProperty(process,'platform',{value:${JSON.stringify(platform)}});
    const {atomicJson}=await import(${JSON.stringify(new URL('../src/storage.mjs',import.meta.url).href)});
    let error=null;
    try { await atomicJson(path,after); }
    catch(caught) { assert.equal(caught,lastError);error=caught.code; }
    assert.ok(!unlinked.includes(path),'the existing state must never be unlinked');
    const value=JSON.parse(await fs.readFile(path,'utf8'));
    assert.deepEqual(await fs.readdir(dir),['state.json']);
    console.log(JSON.stringify({attempts,error,value}));
  `;
  return JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000}));
}
test('Windows state defaults use USERPROFILE before a Git shell HOME and honor explicit state paths',()=>{
  const env={USERPROFILE:'C:\\Users\\한글 User',HOME:'C:\\GitHome'};
  assert.equal(stateDirectory(env,'win32'),join(env.USERPROFILE,'.local','state','herdr-context-bridge'));
  assert.equal(stateDirectory(env,'darwin'),join(env.HOME,'.local','state','herdr-context-bridge'));
  assert.equal(stateDirectory({...env,HERDR_BRIDGE_STATE_DIR:'D:\\state path'},'win32'),'D:\\state path');
});
test('atomic state writes preserve UTF8 and restrict private files', async context=>{
  const dir=await mkdtemp(join(tmpdir(),'bridge-state-'));
  context.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'nested','state.json');
  await atomicJson(path,{title:'인계'});
  assert.deepEqual(await readJson(path),{title:'인계'});
  if(process.platform!=='win32')assert.equal((await stat(path)).mode & 0o777,0o600);
  await Promise.all(Array.from({length:10},(_,i)=>atomicJson(path,{i})));
  assert.ok(Number.isInteger(JSON.parse(await readFile(path,'utf8')).i));
});
test('Windows atomic writes recover from transient rename contention without removing the old state',async context=>{
  for(const code of ['EPERM','EBUSY','EACCES']) {
    assert.deepEqual(await renameFault(context,{code}),{attempts:3,error:null,value:{title:'인계'}});
  }
});
test('Windows atomic writes stop retrying persistent contention and preserve the old state',async context=>{
  for(const code of ['EPERM','EBUSY','EACCES']) {
    assert.deepEqual(await renameFault(context,{code,failures:100}),{attempts:6,error:code,value:{title:'이전'}});
  }
});
test('atomic writes immediately propagate permanent rename errors and non-Windows permission errors',async context=>{
  for(const options of [{code:'ENOENT'},{code:'EXDEV'},{code:'EISDIR'},{platform:'linux',code:'EPERM'},{platform:'darwin',code:'EACCES'}]) {
    assert.deepEqual(await renameFault(context,options),{attempts:1,error:options.code,value:{title:'이전'}});
  }
});
test('missing state falls back, corrupt state is not treated as permission to act',async context=>{
  const dir=await mkdtemp(join(tmpdir(),'bridge-state-missing-'));
  context.after(()=>rm(dir,{recursive:true,force:true}));
  assert.equal(await readJson(join(dir,'missing.json'),null),null);
  assert.equal(safeId('claude-123_ab'),'claude-123_ab');
  assert.throws(()=>safeId('../../auth'));
});
