import {t as message} from '../src/i18n.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSessions } from '../src/sessions.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-sessions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
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
