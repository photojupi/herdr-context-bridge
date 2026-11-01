import {t as message} from '../src/i18n.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBundle } from '../src/bundle.mjs';

async function fixture(t, text) {
  const home = await mkdtemp(join(tmpdir(), 'bridge-bundle-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const project = join(home, 'claude', 'projects', '-workspace');
  await mkdir(project, { recursive: true });
  const transcriptPath = join(project, 'session-one.jsonl');
  await writeFile(transcriptPath, text);
  return { home, project, transcriptPath, source: { provider: 'claude', id: 'session-one', cwd: home, transcriptPath }, options: { stateDir: join(home, 'state'), claudeHome: join(home, 'claude'), now: () => 1234 } };
}
const events = [
  { type: 'user', uuid: 'u1', parentUuid: null, message: { content: 'original request' } },
  { type: 'assistant', uuid: 'old', parentUuid: 'u1', message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: { file_path: '/example' } }] } },
  { type: 'user', uuid: 'u2', parentUuid: 'u1', message: { content: [{ type: 'tool_result', tool_use_id: 'tool1', content: 'tool output' }] } },
  { type: 'system', subtype: 'compact_boundary', uuid: 'compact', parentUuid: 'u2', compactMetadata: { trigger: 'auto', preTokens: 99 } },
  { type: 'assistant', uuid: 'latest', parentUuid: 'compact', message: { content: 'unfinished work' } },
];
const text = events.map(e => JSON.stringify(e)).join('\n') + '\n';
test('native absolute cwd and transcript paths produce a readable bundle on Windows and POSIX', async t => {
  const f = await fixture(t, text);
  const cwd = join(f.home, '작업 폴더');
  await mkdir(cwd);
  const result = await createBundle({ ...f.source, cwd }, f.options);
  assert.equal(result.manifest.source.cwd, cwd);
  assert.equal(result.manifest.complete, true);
  assert.equal(await readFile(join(result.directory, result.manifest.raw[0].path), 'utf8'), text);
});
test('Claude raw 정확한 bytes/hash, 도구 결과, branch/compaction/subagent를 보존한다', async t => {
  const f = await fixture(t, text);
  await mkdir(join(f.project, 'session-one', 'subagents'), { recursive: true });
  await writeFile(join(f.project, 'session-one', 'subagents', 'agent-a.jsonl'), '{"type":"assistant","uuid":"child","message":{"content":"subagent result"}}\n');
  const result = await createBundle(f.source, f.options);
  const raw = result.manifest.raw.find(r => r.role === 'main');
  assert.equal(await readFile(join(result.directory, raw.path), 'utf8'), text);
  assert.equal(raw.bytes, Buffer.byteLength(text));
  assert.equal(raw.sha256, createHash('sha256').update(text).digest('hex'));
  assert.equal(result.manifest.raw.length, 2);
  assert.equal(result.manifest.latestLeaf, 'latest');
  assert.deepEqual(result.manifest.activeBranch, ['u1', 'u2', 'compact', 'latest']);
  assert.equal(result.manifest.compactions.length, 1);
  const chunks = await Promise.all(result.manifest.chunks.filter(c => c.source === raw.path).map(c => readFile(join(result.directory, c.path), 'utf8')));
  assert.equal(chunks.join(''), text);
  assert.match(chunks.join(''), /tool output/);
  assert.match(result.prompt, /START_HERE/);
  if (process.platform !== 'win32') assert.equal((await stat(result.directory)).mode & 0o777, 0o700);
  assert.equal(await readFile(f.transcriptPath, 'utf8'), text);
});
test('잘린 마지막 JSONL은 raw에 유지하고 incomplete로 명시하며 정상 메시지로 해석하지 않는다', async t => {
  const f = await fixture(t, text + '{"uuid":"partial"');
  const result = await createBundle(f.source, f.options);
  assert.ok(result.manifest.warnings.some(w => w===message('{path}:{line} 불완전한 마지막 JSONL 줄(incomplete)을 raw에 보존했으며 메시지로 해석하지 않았습니다',{path:result.manifest.raw[0].path,line:events.length+1})));
  assert.equal(result.manifest.latestLeaf, 'latest');
  const raw = result.manifest.raw[0];
  assert.ok((await readFile(join(result.directory, raw.path), 'utf8')).endsWith('{"uuid":"partial"'));
});
test('큰 단일 record를 잘라 버리지 않고 읽기 조각과 byte index에 전부 보존한다', async t => {
  const large = JSON.stringify({ type: 'assistant', uuid: 'big', message: { content: '가'.repeat(700000) } }) + '\n';
  const f = await fixture(t, large);
  const result = await createBundle(f.source, f.options);
  assert.ok(result.manifest.chunks.length > 5);
  let joined = '';
  for (const chunk of result.manifest.chunks) {
    const bytes = await readFile(join(result.directory, chunk.path));
    assert.ok(bytes.length <= 131072 + 4);
    joined += bytes.toString('utf8');
  }
  assert.equal(joined, large);
  const index = await readFile(join(result.directory, 'records.jsonl'), 'utf8');
  assert.match(index, /byteLength/);
});
test('provider root 밖 경로 및 빈/잘못된 기록은 bundle 성공으로 처리하지 않는다', async t => {
  const f = await fixture(t, '');
  await assert.rejects(createBundle(f.source, f.options), {message:message('빈 transcript 또는 일반 파일이 아닌 기록입니다')});
  await writeFile(f.transcriptPath, 'not json\n');
  await assert.rejects(createBundle(f.source, f.options), /JSON|기록/);
  const outside = join(f.home, 'secret.jsonl');
  await writeFile(outside, text);
  await assert.rejects(createBundle({ ...f.source, transcriptPath: outside }, f.options), {message:message('transcript 경로가 provider data root 밖에 있습니다')});
  await assert.rejects(createBundle({ ...f.source, id: '../escape' }, f.options), {message:message('provider 또는 session id 식별자가 올바르지 않습니다')});
});
test('Codex 전체 history를 full asc 모든 페이지로 저장하고 raw rollout도 보존한다', async t => {
  const f = await fixture(t, text);
  const codexHome = join(f.home, 'codex');
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  const rollout = join(codexHome, 'sessions', 'rollout-test.jsonl');
  await writeFile(rollout, text);
  const calls = [];
  const codexClient = { async request(method, params) {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: 'codex-one', cwd: f.home, path: rollout, updatedAt: 5 } };
    return params.cursor ? { data: [{ id: 'turn2', status: 'completed', itemsView: 'full', items: [{ id: 'cmd', type: 'commandExecution', aggregatedOutput: 'tool-result-full' }] }], nextCursor: null } : { data: [{ id: 'turn1', status: 'completed', itemsView: 'full', items: [{ id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'request' }] }] }], nextCursor: 'more' };
  } };
  const result = await createBundle({ provider: 'codex', id: 'codex-one', cwd: f.home }, { ...f.options, codexHome, codexClient });
  assert.equal(result.manifest.apiPages.length, 2);
  const pages = await Promise.all(result.manifest.apiPages.map(p => readFile(join(result.directory, p), 'utf8')));
  assert.match(pages.join(''), /tool-result-full/);
  assert.equal(result.manifest.raw[0].bytes, Buffer.byteLength(text));
  assert.ok(calls.filter(c => c.method === 'thread/turns/list').every(c => c.params.itemsView === 'full' && c.params.sortDirection === 'asc'));
  assert.equal(calls[0].params.includeTurns, undefined);
});
test('Codex summary only 응답이나 반복 cursor를 성공으로 위장하지 않는다', async t => {
  const f = await fixture(t, text);
  for (const partial of [true, false]) {
    const codexClient = { async request(method) {
      return method === 'thread/read' ? { thread: { id: 'codex-one', cwd: f.home } } : { data: [{ id: 'turn', itemsView: partial ? 'summary' : 'full', items: [] }], nextCursor: partial ? null : 'again' };
    } };
    await assert.rejects(createBundle({ provider: 'codex', id: 'codex-one', cwd: f.home }, { ...f.options, codexClient }), /full|cursor|페이지/);
  }
});
test('스냅샷 복사 중 append되어도 최초 byte 경계만 보존한다', async t => {
  const f = await fixture(t, JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(10_000_000) } }) + '\n');
  const original = await readFile(f.transcriptPath);
  let appended = false;
  const timer = setInterval(async () => {
    if (appended) return;
    try {
      for (const name of await readdir(join(f.options.stateDir, 'bundles'))) {
        const raw = join(f.options.stateDir, 'bundles', name, 'raw', 'main.jsonl');
        if ((await stat(raw)).size > 0) {
          appended = true;
          const { appendFile } = await import('node:fs/promises');
          await appendFile(f.transcriptPath, '{"type":"assistant","uuid":"after-boundary"}\n');
          break;
        }
      }
    } catch { /* Wait until the destination is being streamed. */ }
  }, 1);
  t.after(() => clearInterval(timer));
  const result = await createBundle(f.source, f.options);
  clearInterval(timer);
  assert.equal(appended, true);
  const raw = result.manifest.raw[0];
  assert.equal(raw.bytes, original.length);
  assert.equal(raw.sha256, createHash('sha256').update(original).digest('hex'));
  assert.ok((await stat(f.transcriptPath)).size > raw.bytes);
});
test('symlink를 통한 provider root 탈출을 거부한다', async t => {
  const f = await fixture(t, text);
  const outside = join(f.home, 'private');
  await mkdir(outside);
  await writeFile(join(outside, 'session-one.jsonl'), text);
  const { symlink } = await import('node:fs/promises');
  const link = join(f.project, 'escape');
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createBundle({ ...f.source, transcriptPath: join(link, 'session-one.jsonl') }, f.options), {message:message('transcript 경로가 provider data root 밖에 있습니다')});
});
test('Claude transcript의 sessionId/cwd가 선택한 source와 다르면 실패한다', async t => {
  const f = await fixture(t, '{"type":"user","sessionId":"someone-else","cwd":"/other","uuid":"first"}\n');
  await assert.rejects(createBundle(f.source, f.options), {message:message('선택한 session id/cwd와 원문 metadata가 일치하지 않습니다')});
});
test('Codex metadata에 path가 없어도 선택한 rollout 경로를 검증 후 보존한다', async t => {
  const f = await fixture(t, text);
  const codexHome = join(f.home, 'codex');
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  const path = join(codexHome, 'sessions', 'rollout.jsonl');
  await writeFile(path, text);
  const codexClient = { async request(method) {
    return method === 'thread/read' ? { thread: { id: 'codex-one', cwd: f.home } } : { data: [], nextCursor: null };
  } };
  const result = await createBundle({ provider: 'codex', id: 'codex-one', cwd: f.home, transcriptPath: path }, { ...f.options, codexHome, codexClient });
  assert.equal(result.manifest.raw.length, 1);
});
test('최신 active 메시지의 byte 위치와 읽기 조각을 직접 찾을 수 있다', async t => {
  const prefix = JSON.stringify({ type: 'assistant', uuid: 'old', parentUuid: null, message: { content: 'x'.repeat(200000) } }) + '\n';
  const latest = JSON.stringify({ type: 'user', uuid: 'new', parentUuid: 'old', message: { content: 'continue this task' } }) + '\n';
  const f = await fixture(t, prefix + latest);
  const result = await createBundle(f.source, f.options);
  assert.equal(result.manifest.latestRecord?.startByte, Buffer.byteLength(prefix));
  assert.ok(result.manifest.latestChunks?.length);
  const readable = (await Promise.all(result.manifest.latestChunks.map(path => readFile(join(result.directory, path), 'utf8')))).join('');
  assert.match(readable, /continue this task/);
});
test('Claude historical cwd 변경 기록을 보존하고 마지막 applicable cwd로 source를 검증한다', async t => {
  const f = await fixture(t, '');
  const moved = [
    { type: 'user', uuid: 'old-work', sessionId: 'session-one', cwd: '/historical-worktree', message: { content: 'prior work' } },
    { type: 'assistant', uuid: 'current-work', parentUuid: 'old-work', sessionId: 'session-one', cwd: f.home, message: { content: 'continue current work' } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n';
  await writeFile(f.transcriptPath, moved);
  const result = await createBundle(f.source, f.options);
  assert.equal(await readFile(join(result.directory, result.manifest.raw[0].path), 'utf8'), moved);
  assert.equal(result.manifest.latestLeaf, 'current-work');
});
async function realConnectionFixture(t) {
  const f = await fixture(t, text);
  const codexHome = join(f.home, 'codex');
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  const rollout = join(codexHome, 'sessions', 'rollout.jsonl');
  await writeFile(rollout, text);
  const fake = await readFile(new URL('./fixtures/bundle/connection-server.mjs', import.meta.url), 'utf8');
  const server = join(f.home, 'connection-server.mjs');
  await writeFile(server, fake.replace('  process.stdout.write', "  const base = join(process.env.HERDR_BRIDGE_STATE_DIR, 'bundles');\n  log({ event: 'response', lastMethod, rawExists: existsSync(base) && readdirSync(base).some(name => existsSync(join(base, name, 'raw', 'main.jsonl'))) });\n  process.stdout.write"));
  const log = join(f.home, 'connections.jsonl');
  const env = { ...process.env, HERDR_BRIDGE_STATE_DIR: f.options.stateDir, CODEX_HOME: codexHome, BRIDGE_CONNECTION_LOG: log, BRIDGE_TEST_CWD: f.home, BRIDGE_TEST_ROLLOUT: rollout, BRIDGE_TEST_SERVER: server };
  return { ...f, log, env };
}
test('실제 export 연결은 RPC 사이에 닫히고 raw 파일 처리를 app-server 수명 밖에서 수행한다', async t => {
  const f = await realConnectionFixture(t);
  const { promisify } = await import('node:util');
  const { execFile } = await import('node:child_process');
  const module = new URL('../src/bundle.mjs', import.meta.url).href;
  const code = `const { createBundle } = await import(${JSON.stringify(module)}); await createBundle({ provider:'codex', id:'codex-one', cwd:process.env.BRIDGE_TEST_CWD }, { codexOptions: { binary:process.execPath, args:[process.env.BRIDGE_TEST_SERVER] } });`;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { env: f.env });
  const events = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  const responses = events.filter(e => e.event === 'response' && e.lastMethod !== 'initialize');
  assert.equal(responses.length, 2);
  assert.equal(responses[0].lastMethod, 'thread/read');
  assert.equal(responses[0].rawExists, false);
  assert.equal(responses[1].lastMethod, 'thread/turns/list');
  assert.equal(responses[1].rawExists, true);
  assert.notEqual(responses[0].pid, responses[1].pid);
  for (const { pid } of responses) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  if (process.platform !== 'win32') {
    const stops = events.filter(e => e.event === 'stop');
    assert.equal(stops.length, 2);
    assert.equal(stops[0].rawExists, false);
  }
});
test('개별 Codex API timeout은 실패 후 원문 복사를 계속하지 않는다', async t => {
  const f = await realConnectionFixture(t);
  const { promisify } = await import('node:util');
  const { execFile } = await import('node:child_process');
  const module = new URL('../src/bundle.mjs', import.meta.url).href;
  const code = `const { createBundle } = await import(${JSON.stringify(module)}); let timedOut=false; try { await createBundle({ provider:'codex', id:'codex-one', cwd:process.env.BRIDGE_TEST_CWD }, { codexOptions: { binary:process.execPath, args:[process.env.BRIDGE_TEST_SERVER], timeoutMs:500 } }); } catch(e) { timedOut=e.message===${JSON.stringify(message('Codex app-server timed out'))}; } if(!timedOut) throw new Error('request timeout was not honored'); await new Promise(r=>setTimeout(r,1100));`;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { env: { ...f.env, BRIDGE_READ_DELAY: '1000' } });
  const events = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e => e.event === 'start').length, 1);
  assert.equal(events.at(-1).rawExists, false);
});
test('마지막 oversized record가 있으면 과거 cwd를 현재 cwd로 확정하지 않는다', async t => {
  const f = await fixture(t, '');
  const history = JSON.stringify({ type: 'user', uuid: 'past', cwd: '/past-worktree', sessionId: 'session-one' }) + '\n';
  const current = JSON.stringify({ type: 'assistant', uuid: 'large-current', cwd: f.home, sessionId: 'session-one', message: { content: 'x'.repeat(1100000) } }) + '\n';
  await writeFile(f.transcriptPath, history + current);
  const result = await createBundle(f.source, f.options);
  assert.equal(result.manifest.raw[0].bytes, Buffer.byteLength(history + current));
  assert.ok(result.manifest.warnings.some(w => w===message('{path}:{line} 큰 record의 메타데이터는 분석하지 않았으며 최신 cwd/branch 판정은 확인할 수 없습니다. 원문과 모든 조각은 보존했습니다',{path:result.manifest.raw[0].path,line:2})));
});
test('generated handoff instructions use the helper locale while preserving conversation bytes',async t=>{
  const {t:message}=await import('../src/i18n.mjs');
  const f=await fixture(t,text);
  const result=await createBundle(f.source,f.options);
  const start=await readFile(join(result.directory,'START_HERE.md'),'utf8');
  assert.ok(start.startsWith('# '+message('인계 기록 읽기')));
  assert.ok(start.includes(JSON.stringify(f.source.cwd)));
  assert.equal(result.prompt,message('bundle.prompt',{path:JSON.stringify(join(result.directory,'START_HERE.md'))}));
  const raw=result.manifest.raw.find(r=>r.role==='main');
  assert.equal(await readFile(join(result.directory,raw.path),'utf8'),text);
});
