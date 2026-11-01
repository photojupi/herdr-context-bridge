import {t as message} from '../src/i18n.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capture, runStatusLine } from '../src/capture.mjs';

async function state(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'bridge-capture-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return stateDir;
}
const event = { session_id: 'abc-123', cwd: '/work/project', transcript_path: '/history/abc-123.jsonl', hook_event_name: 'SessionStart', prompt: 'SECRET prompt', token: 'SECRET token' };

test('statusline keeps transcript binding and rate_limit failure until a successful lifecycle event', async t => {
  const stateDir=await state(t),options={stateDir,env:{HC_TERMINAL_ID:'terminal-1'}};
  await capture('claude',{...event,hook_event_name:'StopFailure',error:'rate_limit',error_details:'PRIVATE'},options);
  await runStatusLine(JSON.stringify({session_id:event.session_id,workspace:{current_dir:event.cwd}}),options);
  let saved=JSON.parse(await readFile(join(stateDir,'sessions/claude-abc-123.json'),'utf8'));
  assert.equal(saved.transcriptPath,event.transcript_path);
  assert.equal(saved.error,'rate_limit');
  assert.ok(!JSON.stringify(saved).includes('PRIVATE'));
  await capture('claude',{...event,hook_event_name:'Stop'},options);
  saved=JSON.parse(await readFile(join(stateDir,'sessions/claude-abc-123.json'),'utf8'));
  assert.equal(saved.error,undefined);
});

test('capture writes only minimal trusted registry and terminal binding', async t => {
  const stateDir = await state(t);
  await capture('claude', event, { stateDir, env: { HC_TERMINAL_ID: 'terminal-1', HERDR_BRIDGE_AUTO_ORIGIN: '1' } });
  const session = JSON.parse(await readFile(join(stateDir, 'sessions/claude-abc-123.json'), 'utf8'));
  assert.equal(session.id, 'abc-123');
  assert.equal(session.transcriptPath, '/history/abc-123.jsonl');
  assert.equal(session.terminalId, 'terminal-1');
  assert.equal(session.trustedBinding, true);
  assert.equal(session.autoOrigin, true);
  assert.equal(session.event, 'SessionStart');
  assert.ok(session.updatedAt > 0);
  assert.doesNotMatch(JSON.stringify(session), /SECRET|prompt|token/);
  assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'terminals/terminal-1.json'), 'utf8')), session);
});

test('subagents, mismatched transcript IDs and unsafe identifiers cannot overwrite a parent binding', async t => {
  const stateDir = await state(t);
  const options = { stateDir, env: { HC_TERMINAL_ID: 'terminal-1' } };
  await capture('claude', event, options);
  for (const extra of [{ agent_id: 'child' }, { subagent_id: 'child' }, { transcript_path: '/history/child.jsonl' }, { session_id: '../escape' }]) {
    await capture('claude', { ...event, ...extra }, options);
  }
  assert.deepEqual(await readdir(join(stateDir, 'sessions')), ['claude-abc-123.json']);
  assert.equal(JSON.parse(await readFile(join(stateDir, 'terminals/terminal-1.json'), 'utf8')).id, 'abc-123');
});

test('late Stop and statusLine from old sessions cannot take back a reused terminal ID', async t => {
  const stateDir = await state(t);
  const options = { stateDir, env: { HC_TERMINAL_ID: 'terminal-1' } };
  await capture('claude', event, options);
  await capture('codex', { session_id: 'new-session', cwd: '/work/project', hook_event_name: 'SessionStart' }, options);
  await capture('claude', { ...event, hook_event_name: 'Stop' }, options);
  await runStatusLine(JSON.stringify({ ...event, hook_event_name: undefined }), options);
  assert.equal(JSON.parse(await readFile(join(stateDir, 'terminals/terminal-1.json'), 'utf8')).id, 'new-session');
  assert.equal(JSON.parse(await readFile(join(stateDir, 'sessions/claude-abc-123.json'), 'utf8')).trustedBinding, false);
});

test('statusLine refresh preserves the latest lifecycle event and capture failure cannot hide original output', async t => {
  const stateDir = await state(t);
  const options = { stateDir, env: { HC_TERMINAL_ID: 'terminal-1' } };
  await capture('claude', { ...event, hook_event_name: 'Stop' }, options);
  await runStatusLine(JSON.stringify({ ...event, hook_event_name: undefined }), options);
  assert.equal(JSON.parse(await readFile(join(stateDir, 'sessions/claude-abc-123.json'), 'utf8')).event, 'Stop');
  await writeFile(join(stateDir, 'quota-claude.json'), '{}');
  await writeFile(join(stateDir, 'install.json'), JSON.stringify({ originalStatusLine: { type: 'command', command: 'cat' } }));
  const input = 'malformed json';
  assert.equal((await runStatusLine(input, options)).stdout, input);
});

test('Codex rollout filename and thread_id hook are supported without reading transcript content', async t => {
  const stateDir = await state(t);
  await capture('codex', { thread_id: 'codex-123', cwd: '/project', transcript_path: '/history/rollout-2026-11-01T10-00-00-codex-123.jsonl' }, { stateDir, env: {} });
  const record = JSON.parse(await readFile(join(stateDir, 'sessions/codex-codex-123.json'), 'utf8'));
  assert.equal(record.id, 'codex-123');
  assert.equal(record.trustedBinding, false);
});

test('a busy terminal capture lock skips mutation and preserves the original statusLine', async t => {
  const stateDir = await state(t);
  const options = { stateDir, env: { ...process.env, HC_TERMINAL_ID: 'terminal-1' } };
  await capture('claude', event, options);
  await mkdir(join(stateDir, 'capture-locks', 'terminal-1'), { recursive: true });
  const start = Date.now();
  assert.equal(await capture('codex', { session_id: 'new', cwd: '/project', hook_event_name: 'SessionStart' }, options), null);
  assert.ok(Date.now() - start < 500);
  assert.equal(JSON.parse(await readFile(join(stateDir, 'terminals/terminal-1.json'), 'utf8')).id, 'abc-123');
  await writeFile(join(stateDir, 'install.json'), JSON.stringify({ originalStatusLine: { command: 'cat' } }));
  const input = JSON.stringify(event);
  assert.equal((await runStatusLine(input, options)).stdout, input);
});

test('a dead capture owner is recovered and a late old Stop cannot steal the new binding', async t => {
  const stateDir = await state(t);
  const options = { stateDir, env: { HC_TERMINAL_ID: 'terminal-1' } };
  await capture('claude', event, options);
  const lock = join(stateDir, 'capture-locks/terminal-1');
  await mkdir(lock);
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647, createdAt: Date.now() }));
  const session = await capture('codex', { session_id: 'new-session', cwd: '/project', hook_event_name: 'SessionStart' }, options);
  assert.equal(session?.id, 'new-session');
  await capture('claude', { ...event, hook_event_name: 'Stop' }, options);
  assert.equal(JSON.parse(await readFile(join(stateDir, 'terminals/terminal-1.json'), 'utf8')).id, 'new-session');
  assert.deepEqual(await readdir(join(stateDir, 'capture-locks')), []);
});

test('a live owner remains protected even when its lock is old', async t => {
  const stateDir = await state(t);
  const lock = join(stateDir, 'capture-locks/terminal-1');
  await mkdir(lock, { recursive: true });
  const owner = JSON.stringify({ pid: process.pid, createdAt: Date.now() - 3600000 });
  await writeFile(join(lock, 'owner.json'), owner);
  const before = Date.now();
  assert.equal(await capture('claude', event, { stateDir, env: { HC_TERMINAL_ID: 'terminal-1' } }), null);
  assert.ok(Date.now() - before < 500);
  assert.equal(await readFile(join(lock, 'owner.json'), 'utf8'), owner);
});

test('an old ownerless lock recovers while a fresh incomplete owner stays protected', async t => {
  const stateDir = await state(t);
  const lock = join(stateDir, 'capture-locks/terminal-1');
  await mkdir(lock, { recursive: true });
  const options = { stateDir, env: { HC_TERMINAL_ID: 'terminal-1' } };
  assert.equal(await capture('claude', event, options), null);
  const old = new Date(Date.now() - 60000);
  await utimes(lock, old, old);
  assert.equal((await capture('claude', event, options))?.id, 'abc-123');
});

test('capture marks sessions launched by a recorded automatic handoff', async t => {
  const stateDir = await state(t);
  await mkdir(join(stateDir, 'origins'));
  await writeFile(join(stateDir, 'origins/terminal-1.json'), JSON.stringify({ autoOrigin: true, jobId: 'job-1' }));
  const session = await capture('claude', event, { stateDir, env: { HC_TERMINAL_ID: 'terminal-1' } });
  assert.equal(session.autoOrigin, true);
});

test('statusLine stores quota without persisting unrelated stdin and missing usage replaces stale cache', async t => {
  const stateDir = await state(t);
  await runStatusLine(JSON.stringify({ ...event, rate_limits: { five_hour: { used_percentage: 90, resets_at: Math.floor(Date.now() / 1000) + 500 } } }), { stateDir, env: {} });
  let cached = await readFile(join(stateDir, 'quota-claude.json'), 'utf8');
  assert.equal(JSON.parse(cached).windows[0].remainingPercent, 10);
  assert.doesNotMatch(cached, /SECRET|prompt|token|history/);
  const result = await runStatusLine(JSON.stringify(event), { stateDir, env: {} });
  assert.equal(result.code, 0);
  assert.equal(result.stdout,`Claude: ${message('확인 불가')}\n`);
  assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'quota-claude.json'), 'utf8')).windows, []);
  assert.equal(JSON.parse(await readFile(join(stateDir, 'quota-claude.json'), 'utf8')).accountObserved,true);
});

test('statusLine preserves complete original stdin stdout stderr and exit code', async t => {
  const stateDir = await state(t);
  const command = `"${process.execPath}" -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{process.stdout.write(s);process.stderr.write("original stderr");process.exitCode=7})'`;
  await writeFile(join(stateDir, 'install.json'), JSON.stringify({ originalStatusLine: { type: 'command', command } }));
  const input = ` ${JSON.stringify(event)}\n`;
  const result = await runStatusLine(input, { stateDir, env: process.env });
  assert.deepEqual(result, { stdout: input, stderr: 'original stderr', code: 7 });
});

test('statusLine original command still runs when capture input is malformed', async t => {
  const stateDir = await state(t);
  await writeFile(join(stateDir, 'install.json'), JSON.stringify({ originalStatusLine: { type: 'command', command: 'cat' } }));
  assert.equal((await runStatusLine('not json\n', { stateDir, env: process.env })).stdout, 'not json\n');
});

test('AGY statusLine captures quota without session handoff binding and preserves original command streams', async t => {
  const stateDir=await state(t);
  const command=`"${process.execPath}" -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{process.stdout.write(s);process.stderr.write("agy stderr");process.exitCode=7})'`;
  await writeFile(join(stateDir,'install.json'),JSON.stringify({originalAgyStatusLine:{type:'command',command}}));
  const input=JSON.stringify({session_id:'agy-1',cwd:'/project',email:'PRIVATE@example.com',quota:{'gemini-weekly':{remaining_fraction:0.5,reset_in_seconds:60}}});
  assert.deepEqual(await runStatusLine(input,{provider:'agy',stateDir,env:{...process.env,HC_TERMINAL_ID:'terminal-1'}}),{stdout:input,stderr:'agy stderr',code:7});
  const stored=await readFile(join(stateDir,'quota-agy.json'),'utf8');
  assert.equal(JSON.parse(stored).windows[0].remainingPercent,50);
  assert.equal(JSON.parse(stored).accountObserved,true);
  assert.doesNotMatch(stored,/PRIVATE|email|agy-1|project/);
  await assert.rejects(readdir(join(stateDir,'sessions')),{code:'ENOENT'});
  await assert.rejects(readdir(join(stateDir,'terminals')),{code:'ENOENT'});
});

test('malformed and authenticating empty AGY payloads create no account observation', async t => {
  const stateDir=await state(t),options={provider:'agy',stateDir,env:{}};
  for(const input of ['not json','null','[]',JSON.stringify({agent_state:'authenticating',quota:{}})])
    await runStatusLine(input,options);
  const saved=JSON.parse(await readFile(join(stateDir,'quota-agy.json'),'utf8'));
  assert.notEqual(saved.accountObserved,true);
  assert.deepEqual(saved.windows,[]);
  await writeFile(join(stateDir,'quota-agy.json'),JSON.stringify({provider:'agy',windows:[{remainingPercent:25}]}));
  await runStatusLine('{}',options);
  const previous=JSON.parse(await readFile(join(stateDir,'quota-agy.json'),'utf8'));
  assert.equal(previous.accountObserved,true);
  assert.deepEqual(previous.windows,[]);
});

test('AGY default statusLine keeps valid buckets visible beside unavailable buckets', async t => {
  const stateDir=await state(t);
  const input=JSON.stringify({quota:{valid:{remaining_fraction:0.75},disabled:{remaining_fraction:1,disabled:true},amount:{remaining_amount:10}}});
  const output=await runStatusLine(input,{provider:'agy',stateDir,env:{}});
  assert.match(output.stdout,/valid.*75%/);
  assert.match(output.stdout,new RegExp(`disabled.*${message('확인 불가')}`));
  assert.match(output.stdout,new RegExp(`amount.*${message('확인 불가')}`));
  assert.doesNotMatch(output.stdout,/null%/);
});
