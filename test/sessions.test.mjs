import {t as message} from '../src/i18n.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSessions, validatedTranscript } from '../src/sessions.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-sessions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test('native absolute cwd discovers Claude and Codex sessions including Windows drive paths', async t => {
  const home = await fixture(t);
  const cwd = join(home, '작업 폴더');
  const project = join(home, 'projects', 'native');
  await mkdir(cwd);
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'native.jsonl'), JSON.stringify({ sessionId: 'native', cwd }) + '\n');
  const claude = await listSessions('claude', cwd, { claudeHome: home });
  assert.deepEqual(claude.map(s => ({ id: s.id, cwd: s.cwd })), [{ id: 'native', cwd }]);
  const codex = await listSessions('codex', cwd, { codexClient: { request: async () => ({ data: [{ id: 'native', cwd, updatedAt: 1 }], nextCursor: null }) } });
  assert.deepEqual(codex.map(s => ({ id: s.id, cwd: s.cwd })), [{ id: 'native', cwd }]);
});
test('transcript validation accepts native paths and child names beginning with two dots', async t => {
  const home = await fixture(t);
  const root = join(home, 'projects');
  const directory = join(root, '..project');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'native.jsonl');
  await writeFile(path, '{}\n');
  assert.equal(await validatedTranscript(path, [root]), await realpath(path));
});
test('transcript validation rejects relative paths, sibling roots and parent traversal', async t => {
  const home = await fixture(t);
  const root = join(home, 'projects');
  const sibling = join(home, 'projects-other');
  await mkdir(root);
  await mkdir(sibling);
  await writeFile(join(sibling, 'outside.jsonl'), '{}\n');
  await writeFile(join(home, 'outside.jsonl'), '{}\n');
  await assert.rejects(validatedTranscript('outside.jsonl', [root]), { message: message('허용되지 않는 transcript 경로') });
  for (const path of [join(sibling, 'outside.jsonl'), join(root, '..', 'outside.jsonl')]) {
    await assert.rejects(validatedTranscript(path, [root]), { message: message('transcript 경로가 provider data root 밖에 있습니다') });
  }
});
test('Claude 동일 cwd의 모든 세션을 반환하며 최신 세션을 자동 선택하지 않는다', async t => {
  const home = await fixture(t);
  const project = join(home, 'projects', '-workspace');
  await mkdir(project, { recursive: true });
  for (const id of ['one', 'two']) await writeFile(join(project, `${id}.jsonl`), `${JSON.stringify({ sessionId: id, cwd: '/workspace', type: 'user', message: { content: 'private' } })}\n`);
  await writeFile(join(project, 'other.jsonl'), '{"sessionId":"other","cwd":"/elsewhere"}\n');
  const result = await listSessions('claude', '/workspace', { claudeHome: home, stateDir: join(home, 'state') });
  assert.deepEqual(result.map(s => s.id).sort(), ['one', 'two']);
  assert.equal(JSON.stringify(result).includes('private'), false);
});
test('Codex thread/list cwd 필터와 모든 cursor를 사용한다', async () => {
  const calls = [];
  const codexClient = { async request(method, params) {
    calls.push({ method, params });
    return params.cursor ? { data: [{ id: 'two', cwd: '/workspace', updatedAt: 9, name: 'second' }], nextCursor: null } : { data: [{ id: 'one', cwd: '/workspace', updatedAt: 8 }, { id: 'wrong', cwd: '/other', updatedAt: 1 }], nextCursor: 'page2' };
  } };
  const result = await listSessions('codex', '/workspace', { codexClient });
  assert.deepEqual(result.map(s => s.id), ['one', 'two']);
  assert.equal(result[0].updatedAt, 8000);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.method === 'thread/list' && c.params.cwd === '/workspace'));
});
test('Codex 반복 cursor는 조용한 누락 대신 오류를 낸다', async () => {
  await assert.rejects(listSessions('codex', '/workspace', { codexClient: { request: async () => ({ data: [], nextCursor: 'loop' }) } }), {message:message('Codex 세션 cursor 반복으로 페이지를 완전히 읽지 못했습니다')});
});
test('Codex 결과가 없는 무한 pagination도 발견 한도를 명시한다', async () => {
  let page = 0;
  await assert.rejects(listSessions('codex', '/workspace', { codexClient: { request: async () => ({ data: [], nextCursor: ++page <= 101 ? `cursor-${page}` : null }) } }), {message:message('Codex 세션 페이지 발견 한도에 도달했습니다')});
});
test('Claude 작업 폴더 이동은 과거 prefix보다 최신 tail cwd로 발견한다', async t => {
  const home = await fixture(t);
  const project = join(home, 'projects', '-old');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'moved.jsonl'), JSON.stringify({ type: 'user', sessionId: 'moved', cwd: '/old', message: { content: 'x'.repeat(150000) } }) + '\n' + JSON.stringify({ type: 'assistant', sessionId: 'moved', cwd: '/new' }) + '\n');
  const result = await listSessions('claude', '/new', { claudeHome: home });
  assert.deepEqual(result.map(s => s.id), ['moved']);
  assert.deepEqual(await listSessions('claude', '/old', { claudeHome: home }), []);
});
test('oversized 마지막 record는 일치하는 trusted registry 근거로만 경고와 함께 발견한다', async t => {
  const home = await fixture(t);
  const project = join(home, 'projects', '-old');
  const stateDir = join(home, 'state');
  await mkdir(project, { recursive: true });
  await mkdir(join(stateDir, 'sessions'), { recursive: true });
  const path = join(project, 'large.jsonl');
  await writeFile(path, JSON.stringify({ type: 'user', sessionId: 'large', cwd: '/old' }) + '\n' + JSON.stringify({ type: 'assistant', sessionId: 'large', cwd: '/new', message: { content: 'x'.repeat(300000) } }) + '\n');
  await writeFile(join(stateDir, 'sessions', 'claude-large.json'), JSON.stringify({ provider: 'claude', id: 'large', cwd: '/new', transcriptPath: path, trustedBinding: true }));
  const result = await listSessions('claude', '/new', { claudeHome: home, stateDir });
  assert.equal(result.length, 1);
  assert.ok(result[0].discoveryWarnings?.length);
  assert.equal(result[0].trustedBinding, false);
  await assert.rejects(listSessions('claude', '/new', { claudeHome: home, stateDir: join(home, 'missing-state') }), {message:message('Claude 최신 cwd metadata 탐색 한도에 도달했습니다. 현재 후보를 확인할 수 없습니다')});
});
test('큰 과거 record 뒤 newline 없는 완전한 최신 metadata도 cwd 증거로 사용한다', async t => {
  const home = await fixture(t);
  const project = join(home, 'projects', '-old');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'moved.jsonl'), JSON.stringify({ type: 'user', sessionId: 'moved', cwd: '/old', message: { content: 'x'.repeat(150000) } }) + '\n' + JSON.stringify({ type: 'assistant', sessionId: 'moved', cwd: '/new' }));
  const result = await listSessions('claude', '/new', { claudeHome: home, stateDir: join(home, 'state') });
  assert.equal(result[0].id, 'moved');
});
test('AGY는 동일 cwd의 공식 관측 registry와 존재하는 transcript가 있는 세션만 발견한다', async t => {
  const home = await fixture(t);
  const stateDir = join(home, 'state');
  const agyHome = join(home, 'agy');
  await mkdir(join(stateDir, 'sessions'), { recursive: true });
  for (const [id, extra] of [['observed', {}], ['other', { cwd: '/other' }], ['unobserved', { observationSource: undefined }], ['missing', {}]]) {
    const transcriptPath = join(agyHome, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
    if (id !== 'missing') {
      await mkdir(join(agyHome, 'brain', id, '.system_generated', 'logs'), { recursive: true });
      await writeFile(transcriptPath, '{"step_index":0,"content":"private conversation"}\n');
    }
    await writeFile(join(stateDir, 'sessions', `agy-${id}.json`), JSON.stringify({ provider: 'agy', id, cwd: home, updatedAt: 1234, observationSource: 'statusline', trustedBinding: true, transcriptPath, ...extra }));
  }
  const sessions = await listSessions('agy', home, { stateDir, agyHome });
  assert.deepEqual(sessions.map(s => ({ id: s.id, cwd: s.cwd, trustedBinding: s.trustedBinding })), [{ id: 'observed', cwd: home, trustedBinding: true }]);
  assert.equal(sessions[0].updatedAt, 1234);
  assert.equal(sessions[0].observationSource, 'statusline');
  assert.equal(JSON.stringify(sessions).includes('private conversation'), false);
  assert.deepEqual(await listSessions('agy', home, { stateDir: join(home, 'missing'), agyHome }), []);
});
test('AGY 재사용 터미널의 새 공식 관측 세션도 수동 연결 후보로 반환한다', async t => {
  const home = await fixture(t);
  const stateDir = join(home, 'state');
  const agyHome = join(home, 'agy');
  const logs = join(agyHome, 'brain', 'new-session', '.system_generated', 'logs');
  await mkdir(logs, { recursive: true });
  await mkdir(join(stateDir, 'sessions'), { recursive: true });
  const transcriptPath = join(logs, 'transcript.jsonl');
  await writeFile(transcriptPath, '{"step_index":0}\n');
  await writeFile(join(stateDir, 'sessions', 'agy-new-session.json'), JSON.stringify({ provider: 'agy', id: 'new-session', cwd: home, observationSource: 'statusline', trustedBinding: false, transcriptPath }));
  const sessions = await listSessions('agy', home, { stateDir, agyHome });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'new-session');
  assert.equal(sessions[0].observationSource, 'statusline');
  assert.equal(sessions[0].trustedBinding, false);
});
test('AGY는 다른 session id의 transcript와 brain 내부 symlink로 바뀐 id를 거부한다', async t => {
  const home = await fixture(t);
  const stateDir = join(home, 'state');
  const agyHome = join(home, 'agy');
  const logs = join(agyHome, 'brain', 'other', '.system_generated', 'logs');
  await mkdir(logs, { recursive: true });
  await mkdir(join(stateDir, 'sessions'), { recursive: true });
  await writeFile(join(logs, 'transcript.jsonl'), '{}\n');
  const registryPath = join(stateDir, 'sessions', 'agy-selected.json');
  const binding = { provider: 'agy', id: 'selected', cwd: home, observationSource: 'statusline', trustedBinding: true, transcriptPath: join(logs, 'transcript.jsonl') };
  await writeFile(registryPath, JSON.stringify(binding));
  await assert.rejects(listSessions('agy', home, { stateDir, agyHome }), { message: message('AGY session id와 transcript 경로가 일치하지 않습니다') });
  await symlink(join(agyHome, 'brain', 'other'), join(agyHome, 'brain', 'selected'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(registryPath, JSON.stringify({ ...binding, transcriptPath: join(agyHome, 'brain', 'selected', '.system_generated', 'logs', 'transcript.jsonl') }));
  await assert.rejects(listSessions('agy', home, { stateDir, agyHome }), { message: message('AGY session id와 transcript 경로가 일치하지 않습니다') });
});
