import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {atomicJson,readJson, safeId,stateDirectory} from '../src/storage.mjs';
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
test('missing state falls back, corrupt state is not treated as permission to act',async context=>{
  const dir=await mkdtemp(join(tmpdir(),'bridge-state-missing-'));
  context.after(()=>rm(dir,{recursive:true,force:true}));
  assert.equal(await readJson(join(dir,'missing.json'),null),null);
  assert.equal(safeId('claude-123_ab'),'claude-123_ab');
  assert.throws(()=>safeId('../../auth'));
});
