import {t} from './i18n.mjs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';

const DISCOVERY_LIMIT = 5000;
const METADATA_BYTES = 131072;

export async function listSessions(provider, cwd, { stateDir, claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), codexClient } = {}) {
  if (!['claude', 'codex'].includes(provider)) throw new Error(t('지원하지 않는 provider'));
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error(t('절대 cwd 경로가 필요합니다'));
  if (provider === 'codex') {
    if (!codexClient) {
      const { withCodex } = await import('./codex.mjs');
      return withCodex(client => listSessions(provider, cwd, { codexClient: client }));
    }
    const sessions = [];
    const ids = new Set();
    const cursors = new Set();
    let cursor;
    let pages = 0;
    do {
      if (++pages > 100) throw new Error(t('Codex 세션 페이지 발견 한도에 도달했습니다'));
      const page = await codexClient.request('thread/list', { cwd, limit: 100, sortKey: 'updated_at', ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page?.data)) throw new Error(t('Codex 세션 페이지 응답이 올바르지 않습니다'));
      for (const thread of page.data) {
        if (thread.cwd !== cwd || ids.has(thread.id)) continue;
        ids.add(thread.id);
        sessions.push({ provider, id: thread.id, cwd, updatedAt: thread.updatedAt * 1000, ...(thread.name ? { title: thread.name } : {}), ...(thread.path ? { transcriptPath: thread.path } : {}) });
      }
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error(t('Codex 세션 cursor 반복으로 페이지를 완전히 읽지 못했습니다'));
      if (cursor) cursors.add(cursor);
      if (sessions.length >= DISCOVERY_LIMIT && cursor) throw new Error(t('세션 발견 한도에 도달했습니다. 후보가 누락될 수 있어 선택을 중단합니다'));
    } while (cursor);
    return sessions;
  }
  const projects = join(claudeHome, 'projects');
  let directories;
  try { directories = await readdir(projects, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (directories.length > DISCOVERY_LIMIT) throw new Error(t('Claude 프로젝트 발견 한도에 도달했습니다'));
  const sessions = [];
  let visited = 0;
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    for (const entry of await readdir(join(projects, directory.name), { withFileTypes: true })) {
      if (!entry.isFile() || !/^[A-Za-z0-9_-]+\.jsonl$/.test(entry.name)) continue;
      if (++visited > DISCOVERY_LIMIT) throw new Error(t('Claude 세션 발견 한도에 도달했습니다. 후보를 조용히 생략하지 않습니다'));
      const path = join(projects, directory.name, entry.name);
      const handle = await open(path, 'r');
      let metadata;
      let uncertain = false;
      try {
        const { size } = await handle.stat();
        const start = Math.max(0, size - METADATA_BYTES);
        const buffer = Buffer.alloc(Math.min(size, METADATA_BYTES + (start ? 1 : 0)));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, start - 1));
        let tail = buffer.subarray(0, bytesRead).toString('utf8');
        if (start) {
          // The extra byte tells whether the window starts at a complete line.
          const boundary = tail.indexOf('\n');
          uncertain = buffer[0] !== 10 && boundary < 0;
          tail = buffer[0] === 10 ? tail.slice(1) : boundary < 0 ? '' : tail.slice(boundary + 1);
        }
        const lines = tail.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i]) continue;
          try {
            const record = JSON.parse(lines[i]);
            if (record.cwd && !record.isSidechain) metadata = record;
          } catch {
            if (i === lines.length - 1) uncertain = true;
          }
        }
        if (!metadata && size > METADATA_BYTES) uncertain = true;
      } finally { await handle.close(); }
      const id = basename(entry.name, '.jsonl');
      let discoveryWarnings;
      if (uncertain) {
        const { readJson, stateDirectory } = await import('./storage.mjs');
        const binding = await readJson(join(stateDir || stateDirectory(), 'sessions', `claude-${id}.json`));
        let matchingPath = false;
        if (binding?.transcriptPath) {
          try { matchingPath = await realpath(binding.transcriptPath) === await realpath(path); } catch { /* Missing registry paths are not identity evidence. */ }
        }
        if (!binding?.trustedBinding || binding.provider !== 'claude' || binding.id !== id || !matchingPath) throw new Error(t('Claude 최신 cwd metadata 탐색 한도에 도달했습니다. 현재 후보를 확인할 수 없습니다'));
        metadata = binding;
        discoveryWarnings = [t('마지막 큰/불완전 record의 cwd를 확인하지 못해 일치하는 hook registry를 사용했습니다. 현재 cwd를 다시 확인해야 하며 자동 인계 근거로 사용할 수 없습니다')];
      }
      if (metadata?.cwd !== cwd) continue;
      if (metadata.sessionId && metadata.sessionId !== id) continue;
      sessions.push({ provider, id, cwd, transcriptPath: path, updatedAt: (await stat(path)).mtimeMs, ...(discoveryWarnings ? { discoveryWarnings, trustedBinding: false } : {}) });
    }
  }
  return sessions;
}

export async function validatedTranscript(path, roots) {
  if (typeof path !== 'string' || !isAbsolute(path) || !path.endsWith('.jsonl')) throw new Error(t('허용되지 않는 transcript 경로'));
  const canonical = await realpath(path);
  for (const root of roots) {
    let canonicalRoot;
    try { canonicalRoot = await realpath(root); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const child = relative(canonicalRoot, canonical);
    if (child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)) return canonical;
  }
  throw new Error(t('transcript 경로가 provider data root 밖에 있습니다'));
}
