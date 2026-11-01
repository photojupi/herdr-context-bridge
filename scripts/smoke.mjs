#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from '../src/i18n.mjs';

// Every executable and home below belongs to this smoke run. No real app,
// provider CLI, credentials, or existing user session is contacted.
const root = await realpath(await mkdtemp(join(tmpdir(), 'herdr-bridge-smoke-')));
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const home = join(root, 'home');
const bin = join(root, 'bin');
const stateDir = join(root, 'state "quoted"');
const cwd = join(root, "project [a] $literal 'quote'");
const callsFile = join(root, 'calls.jsonl');
const terminalsFile = join(root, 'terminals.json');
const launchGate = join(root, 'launch-gate');
const children = new Set();
const jobs = new Set();
const env = {
  HOME: home, PATH: `${bin}:/usr/bin:/bin`, LANG: 'en_US.UTF-8',
  TMPDIR: root, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'),
  HERDR_BRIDGE_STATE_DIR: stateDir, SMOKE_CALLS: callsFile, SMOKE_TERMINALS: terminalsFile,
  SMOKE_LAUNCH_GATE: launchGate,
};
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const calls = async () => (await readFile(callsFile, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
async function putJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
}
async function executable(name, body) {
  const path = join(bin, name);
  await writeFile(path, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  await chmod(path, 0o700);
}
async function helper(command, args = [], input = '', extraEnv = {}) {
  const child = spawn(process.execPath, [cli, command, ...args], { cwd, env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
      child.stdin.end(input);
    });
    assert.equal(stderr, '', `${command} stderr`);
    return { code, stdout, value: stdout ? JSON.parse(stdout) : undefined };
  } finally { clearTimeout(timer); children.delete(child); }
}
async function waitJob(id) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await helper('job', [id]);
    assert.equal(result.code, 0);
    const job = result.value;
    assert.notEqual(job.status, 'failed', job.error);
    if (job.status === 'launched') {
      try {
        const origin = await json(join(stateDir, 'origins', `${job.terminalId}.json`));
        if (origin.jobId === id) return job;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`smoke worker timed out: ${id}`);
}

try {
  await Promise.all([home, bin, cwd, stateDir].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  await writeFile(callsFile, '', { mode: 0o600 });
  const common = `const fs=require('node:fs');
const log=entry=>fs.appendFileSync(process.env.SMOKE_CALLS,JSON.stringify(entry)+'\\n');
const args=process.argv.slice(2);`;
  await executable('hc', `${common}
log({binary:'hc',args});
if(JSON.stringify(args)!==JSON.stringify(['ls','--json']))throw Error('Source input or mutation is forbidden');
process.stdout.write(fs.readFileSync(process.env.SMOKE_TERMINALS));`);
  await executable('claude', `${common}
log({binary:'claude',args});throw Error('The source CLI must never be invoked');`);
  await executable('codex', `${common}
if(args[0]==='app-server'){
  require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
    const message=JSON.parse(line);log({binary:'codex-api',method:message.method});
    if(message.method==='initialized')return;
    let result;
    if(message.method==='initialize')result={userAgent:'smoke'};
    else if(message.method==='account/rateLimits/read')result={rateLimits:{primary:{usedPercent:10,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+3600}}};
    else throw Error('Unexpected provider RPC');
    process.stdout.write(JSON.stringify({id:message.id,result})+'\\n');
  });
}else{
  if(args.length!==2||args[0]!=='--no-daemon')throw Error('Target argv boundary changed');
  const match=args[1].match(/"(?:\\\\.|[^"\\\\])*START_HERE\\.md"/);
  if(!match)throw Error('No quoted archive index path');
  const indexPath=JSON.parse(match[0]),directory=require('node:path').dirname(indexPath);
  const index=fs.readFileSync(indexPath,'utf8');
  const manifest=JSON.parse(fs.readFileSync(require('node:path').join(directory,'manifest.json'),'utf8'));
  if(!manifest.complete||!manifest.raw.length||!manifest.chunks.length)throw Error('Incomplete archive');
  for(const chunk of manifest.chunks){if(!index.includes(chunk.path))throw Error('Missing chunk index');fs.readFileSync(require('node:path').join(directory,chunk.path));}
  for(const raw of manifest.raw)fs.readFileSync(require('node:path').join(directory,raw.path));
  log({binary:'codex-target',args,cwd:process.cwd(),origin:process.env.HERDR_BRIDGE_AUTO_ORIGIN,jobId:process.env.HERDR_BRIDGE_JOB_ID,indexPath,chunkCount:manifest.chunks.length});
}`);
  await executable('herdr-app', `${common}
if(args.length===1&&args[0]==='ls'){
  log({binary:'herdr-app-ls',args});
  process.stdout.write(JSON.stringify({spaces:[{id:'smoke-space',machine:null,tabs:[{terminals:JSON.parse(fs.readFileSync(process.env.SMOKE_TERMINALS,'utf8')).terminals.map(t=>({terminal:t.address}))}]}]}));process.exit(0);
}
if(args.length!==3||args[0]!=='do'||args[1]!=='tab.new')throw Error('Only a new fake tab may be launched');
const deadline=Date.now()+5000;
while(!fs.existsSync(process.env.SMOKE_LAUNCH_GATE)){
  if(Date.now()>deadline)throw Error('The helper did not return independently of its worker');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
}
const payload=JSON.parse(args[2]);log({binary:'herdr-app',args,payload});
const result=require('node:child_process').spawnSync(payload.argv[0],payload.argv.slice(1),{cwd:payload.folder,env:process.env,encoding:'utf8',timeout:10000});
if(result.error||result.status!==0)throw Error(result.error?.message||result.stderr||'Fake target failed');
process.stdout.write(JSON.stringify({terminal:'target-'+process.pid,tab:'tab-'+process.pid}));`);

  const rawById = new Map();
  for (const id of ['source-manual', 'source-auto']) {
    const transcriptPath = join(env.CLAUDE_CONFIG_DIR, 'projects', 'smoke-project', `${id}.jsonl`);
    const raw = Buffer.from([
      { type: 'user', uuid: 'u1', parentUuid: null, cwd, sessionId: id, message: { role: 'user', content: 'Continue the temporary smoke fixture.' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', cwd, sessionId: id, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'fixture.txt' } }] } },
      { type: 'user', uuid: 'u2', parentUuid: 'a1', cwd, sessionId: id, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Entire tool result preserved: 한국어.' }] } },
    ].map(JSON.stringify).join('\n') + '\n');
    await mkdir(dirname(transcriptPath), { recursive: true, mode: 0o700 });
    await writeFile(transcriptPath, raw, { mode: 0o600 });
    rawById.set(id, { raw, transcriptPath });
  }
  await putJson(terminalsFile, { terminals: [
    { address: 'source-terminal-manual', agent: 'claude-code', cwd, status: 'idle', state: 'live' },
    { address: 'source-terminal-auto', agent: 'claude-code', cwd, status: 'idle', state: 'live' },
  ] });
  for (const [id, { transcriptPath }] of rawById) {
    const terminalId = id.replace('source-', 'source-terminal-');
    const captured = await helper('capture', ['claude'], JSON.stringify({ session_id: id, transcript_path: transcriptPath, cwd, hook_event_name: 'SessionStart' }), { HC_TERMINAL_ID: terminalId });
    assert.equal(captured.code, 0);
    assert.equal(captured.stdout, '');
  }
  const locale = (await helper('locale')).value.locale;
  const status = await helper('status');
  assert.equal(status.code, 0);
  assert.equal(status.value.config.mode, 'ask');
  assert.deepEqual(status.value.installed, { claude: true, codex: true });
  const rejected = await helper('handoff', [JSON.stringify({ sourceKey: 'claude:source-manual', target: 'codex', automatic: true })]);
  assert.equal(rejected.code, 1);
  assert.ok(rejected.value.error.startsWith(t('자동 인계 불가: {reason}', { reason: '' }, locale)));
  assert.ok(!(await calls()).some(call => call.binary === 'herdr-app'));

  for (const [id, automatic] of [['source-manual', false], ['source-auto', true]]) {
    await rm(launchGate, { force: true });
    if (automatic) {
      const future = Date.now() + 3600000;
      for (const [provider, remainingPercent] of [['claude', 5], ['codex', 90]]) {
        await putJson(join(stateDir, `quota-${provider}.json`), { provider, observedAt: Date.now(), windows: [{ id: 'fixture', label: 'fixture', usedPercent: 100 - remainingPercent, remainingPercent, resetsAt: future }] });
      }
      const config = await helper('config', [JSON.stringify({ mode: 'auto', autoSessions: ['claude:source-auto'] })]);
      assert.equal(config.code, 0);
    }
    const requested = await helper('handoff', [JSON.stringify({ sourceKey: `claude:${id}`, target: 'codex', automatic, space: 'smoke-space' })]);
    assert.equal(requested.code, 0);
    const jobId = requested.value.jobId;
    jobs.add(jobId);
    // The detached worker waits in its fake launcher until the CLI has returned.
    await writeFile(launchGate, jobId, { mode: 0o600 });
    const job = await waitJob(jobId);
    assert.notEqual(job.workerPid, process.pid);
    assert.equal(job.delivery, 'initial-cli-prompt');
    const target = (await calls()).find(call => call.binary === 'codex-target' && call.jobId === jobId);
    assert.ok(target);
    assert.equal(target.origin, automatic ? '1' : '0');
    assert.equal(target.cwd, cwd);
    assert.equal(dirname(target.indexPath), job.directory);
    const origin = await json(join(stateDir, 'origins', `${job.terminalId}.json`));
    assert.equal(origin.autoOrigin, automatic);
    const manifest = await json(join(job.directory, 'manifest.json'));
    const { raw, transcriptPath } = rawById.get(id);
    assert.deepEqual(await readFile(join(job.directory, manifest.raw[0].path)), raw);
    assert.deepEqual(await readFile(transcriptPath), raw);
    assert.equal(manifest.raw[0].sha256, createHash('sha256').update(raw).digest('hex'));
    assert.deepEqual(Buffer.concat(await Promise.all(manifest.chunks.map(chunk => readFile(join(job.directory, chunk.path))))), raw);
    const launch = (await calls()).find(call => call.binary === 'herdr-app' && call.payload.argv.includes(`HERDR_BRIDGE_JOB_ID=${jobId}`));
    assert.equal(launch.payload.space, 'smoke-space');
    assert.deepEqual(launch.payload.argv.slice(0, 5), ['/usr/bin/env', `HERDR_BRIDGE_AUTO_ORIGIN=${automatic ? '1' : '0'}`, `HERDR_BRIDGE_JOB_ID=${jobId}`, 'codex', '--no-daemon']);
    assert.equal(launch.payload.argv.length, 6);
    assert.ok(!launch.payload.argv.some(arg => /--yolo|--dangerously|--bypass/.test(arg)));
  }
  assert.equal((await calls()).filter(call => call.binary === 'herdr-app').length, 2);
  assert.equal((await calls()).filter(call => call.binary === 'claude').length, 0);
  assert.ok((await calls()).filter(call => call.binary === 'hc').every(call => JSON.stringify(call.args) === '["ls","--json"]'));
  assert.ok((await calls()).filter(call => call.binary === 'codex-api').every(call => ['initialize', 'initialized', 'account/rateLimits/read'].includes(call.method)));
  process.stdout.write(JSON.stringify({ ok: true, scenarios: ['default-ask-rejects-auto', 'manual-detached-handoff', 'armed-auto-detached-handoff', 'raw-sha256-and-complete-chunks', 'argv-and-origin-boundaries', 'source-remains-untouched'], jobs: jobs.size }) + '\n');
} finally {
  for (const child of children) child.kill('SIGKILL');
  // Only a worker ID returned by this run's own helper can be considered here.
  for (const id of jobs) {
    try {
      const job = await json(join(stateDir, 'jobs', `${id}.json`));
      if (job.status === 'preparing' && Number.isInteger(job.workerPid) && job.workerPid !== process.pid) {
        try { process.kill(job.workerPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    } catch (error) { if (error.code !== 'ENOENT') process.stderr.write(`smoke cleanup: ${error.message}\n`); }
  }
  await rm(root, { recursive: true, force: true });
}
