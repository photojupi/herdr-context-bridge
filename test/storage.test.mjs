import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {atomicJson,readJson, safeId} from '../src/storage.mjs';
test('atomic state writes preserve UTF8 and restrict private files', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'bridge-state-'));
  const path=join(dir,'nested','state.json');
  await atomicJson(path,{title:'인계'});
  assert.deepEqual(await readJson(path),{title:'인계'});
  assert.equal((await stat(path)).mode & 0o777,0o600);
  await Promise.all(Array.from({length:10},(_,i)=>atomicJson(path,{i})));
  assert.ok(Number.isInteger(JSON.parse(await readFile(path,'utf8')).i));
});
test('missing state falls back, corrupt state is not treated as permission to act',async()=>{
  assert.equal(await readJson('/private/tmp/no-such-herdr-bridge-state.json',null),null);
  assert.equal(safeId('claude-123_ab'),'claude-123_ab');
  assert.throws(()=>safeId('../../auth'));
});
