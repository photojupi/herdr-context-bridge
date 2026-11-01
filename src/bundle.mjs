import {t} from './i18n.mjs';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { validatedTranscript } from './sessions.mjs';

const CHUNK_BYTES = 131072;
const PARSE_BYTES = 1048576;

async function writeJson(path, value) {
  // Serialize large strings in pieces, without a second full JSON-sized allocation.
  function* json(part) {
    if (typeof part === 'string') {
      yield '"';
      for (let offset = 0; offset < part.length;) {
        let end = Math.min(offset + 32768, part.length);
        if (end < part.length && /[\uD800-\uDBFF]/.test(part[end - 1])) end--;
        yield JSON.stringify(part.slice(offset, end)).slice(1, -1);
        offset = end;
      }
      yield '"';
    } else if (Array.isArray(part)) {
      yield '[';
      for (let i = 0; i < part.length; i++) { if (i) yield ','; yield* json(part[i]); }
      yield ']';
    } else if (part && typeof part === 'object') {
      yield '{';
      let first = true;
      for (const [key, item] of Object.entries(part)) {
        if (item === undefined) continue;
        if (!first) yield ',';
        first = false;
        yield JSON.stringify(key) + ':';
        yield* json(item);
      }
      yield '}';
    } else yield JSON.stringify(part) ?? 'null';
  }
  await pipeline(Readable.from(json(value)), createWriteStream(path, { mode: 0o600, flags: 'wx' }));
}

async function snapshot(path, destination) {
  const input = await open(path, 'r');
  try {
    const before = await input.stat();
    if (!before.isFile() || !before.size) throw new Error(t('빈 transcript 또는 일반 파일이 아닌 기록입니다'));
    const hash = createHash('sha256');
    let copied = 0;
    async function* bytes() {
      for await (const part of input.createReadStream({ start: 0, end: before.size - 1, autoClose: false })) {
        hash.update(part); copied += part.length; yield part;
      }
    }
    await pipeline(Readable.from(bytes()), createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
    const after = await input.stat();
    if (copied !== before.size || after.size < before.size || after.mtimeMs !== before.mtimeMs && after.size === before.size) throw new Error(t('스냅샷 중 원본이 변경되어 고정 byte 경계를 확인할 수 없습니다'));
    return { bytes: copied, sha256: hash.digest('hex'), snapshotBoundary: before.size };
  } finally { await input.close(); }
}

async function readableChunks(directory, path, manifest) {
  let carry = Buffer.alloc(0);
  let offset = 0;
  let number = 0;
  const source = path;
  const stem = basename(path).replace(/\.[^.]+$/, '');
  async function emit(buffer) {
    const output = `chunks/${stem}-${String(++number).padStart(5, '0')}.txt`;
    await writeFile(join(directory, output), buffer, { mode: 0o600, flag: 'wx' });
    manifest.chunks.push({ path: output, source, startByte: offset, byteLength: buffer.length });
    offset += buffer.length;
  }
  for await (const buffer of createReadStream(join(directory, path), { highWaterMark: CHUNK_BYTES })) {
    carry = Buffer.concat([carry, buffer]);
    while (carry.length > CHUNK_BYTES) {
      let end = CHUNK_BYTES;
      while (end && end < carry.length && (carry[end] & 0xc0) === 0x80) end--;
      await emit(carry.subarray(0, end));
      carry = carry.subarray(end);
    }
  }
  if (carry.length) await emit(carry);
}

async function indexJsonl(directory, raw, indexHandle, manifest, main, source) {
  let parts = [];
  let length = 0;
  let offset = 0;
  let lineNumber = 0;
  let valid = 0;
  let latestCwd;
  const parents = new Map();
  async function record(terminated) {
    lineNumber++;
    const metadata = { source: raw.path, line: lineNumber, startByte: offset, byteLength: length + (terminated ? 1 : 0) };
    if (length > PARSE_BYTES) {
      metadata.metadataUnavailable = t('large record: read all byte chunks');
      if (main) { manifest.latestLeaf = null; manifest.latestRecord = null; latestCwd = undefined; }
      manifest.warnings.push(t('{path}:{line} 큰 record의 메타데이터는 분석하지 않았으며 최신 cwd/branch 판정은 확인할 수 없습니다. 원문과 모든 조각은 보존했습니다',{path:raw.path,line:lineNumber}));
      valid++;
    } else if (length) {
      try {
        const event = JSON.parse(Buffer.concat(parts, length).toString('utf8'));
        if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('record object required');
        if (main && event.sessionId && event.sessionId !== source.id) throw new Error(t('선택한 session id/cwd와 원문 metadata가 일치하지 않습니다'));
        valid++;
        if (main && event.cwd && !event.isSidechain) latestCwd = event.cwd;
        for (const key of ['type', 'subtype', 'uuid', 'parentUuid', 'isSidechain', 'timestamp', 'cwd']) if (event[key] !== undefined) metadata[key] = event[key];
        if (main && event.uuid && !event.isSidechain && ['user', 'assistant', 'system'].includes(event.type)) {
          parents.set(event.uuid, event.parentUuid ?? null);
          manifest.latestLeaf = event.uuid;
          manifest.latestRecord = metadata;
        }
        if (main && (event.subtype === 'compact_boundary' || event.type === 'summary')) manifest.compactions.push({ ...metadata, compactMetadata: event.compactMetadata });
      } catch (error) {
        if (error.message===t('선택한 session id/cwd와 원문 metadata가 일치하지 않습니다')) throw error;
        if (terminated) throw new Error(t('{path}:{line} JSON 기록이 손상되었습니다',{path:raw.path,line:lineNumber}));
        metadata.incomplete = true;
        manifest.warnings.push(t('{path}:{line} 불완전한 마지막 JSONL 줄(incomplete)을 raw에 보존했으며 메시지로 해석하지 않았습니다',{path:raw.path,line:lineNumber}));
      }
    }
    await indexHandle.write(JSON.stringify(metadata) + '\n');
    offset += metadata.byteLength;
    parts = []; length = 0;
  }
  for await (const buffer of createReadStream(join(directory, raw.path))) {
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] !== 10) continue;
      const part = buffer.subarray(start, i);
      length += part.length;
      if (length <= PARSE_BYTES) parts.push(part);
      else parts = [];
      await record(true);
      start = i + 1;
    }
    const tail = buffer.subarray(start);
    length += tail.length;
    if (length <= PARSE_BYTES) parts.push(tail); else parts = [];
  }
  if (length) await record(false);
  if (!valid) throw new Error(t('유효한 JSON 기록을 찾을 수 없습니다'));
  if (main) {
    if (latestCwd && latestCwd !== source.cwd) {
      if (!source.trustedBinding) throw new Error(t('선택한 session cwd와 최신 원문 cwd가 일치하지 않습니다'));
      manifest.warnings.push(t('최신 원문 cwd와 선택한 cwd가 다르므로 trusted hook binding의 현재 cwd를 사용했습니다. 과거 cwd 기록은 그대로 보존했습니다'));
    }
    let uuid = manifest.latestLeaf;
    const seen = new Set();
    while (uuid && parents.has(uuid) && !seen.has(uuid)) {
      seen.add(uuid); manifest.activeBranch.push(uuid); uuid = parents.get(uuid);
    }
    manifest.activeBranch.reverse();
    if (uuid) manifest.warnings.push(t('현재 branch의 일부 부모 기록을 확인할 수 없습니다. 모든 history와 원문을 대조하십시오'));
  }
}

async function gitCommand(cwd, args, destination) {
  const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  const child = spawn('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' } });
  const completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  try { const [code] = await Promise.all([completion, pipeline(child.stdout, output)]); return code === 0; }
  catch { output.destroy(); return false; }
}

export async function createBundle(source, { stateDir, codexClient, codexOptions = {}, now = Date.now, claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), codexHome = process.env.CODEX_HOME || join(homedir(), '.codex') } = {}) {
  if (!source || !['claude', 'codex'].includes(source.provider) || !/^[A-Za-z0-9_-]+$/.test(source.id)) throw new Error(t('provider 또는 session id 식별자가 올바르지 않습니다'));
  if (typeof source.cwd !== 'string' || !source.cwd.startsWith('/')) throw new Error(t('절대 작업 경로가 필요합니다'));
  if (!stateDir) { const { stateDirectory } = await import('./storage.mjs'); stateDir = stateDirectory(); }
  if (source.provider === 'codex' && !codexClient) {
    const { withCodex } = await import('./codex.mjs');
    // Own a connection only for the RPC. Slow snapshots/chunks/Git cannot outlive
    // an enclosing transport timeout, and each page has the same request bound.
    codexClient = { request: (method, params) => withCodex(client => client.request(method, params), codexOptions) };
  }
  const base = join(stateDir, 'bundles');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(base, `${source.provider}-${source.id}-`));
  await mkdir(join(directory, 'raw'), { mode: 0o700 });
  await mkdir(join(directory, 'chunks'), { mode: 0o700 });
  const manifest = { version: 1, createdAt: typeof now === 'function' ? now() : now, source: { provider: source.provider, id: source.id, cwd: source.cwd }, complete: false, raw: [], chunks: [], apiPages: [], activeBranch: [], latestLeaf: null, compactions: [], warnings: [], limits: [t('실행 중 도구/프로세스, 모델 내부 상태, 원래 시스템 프롬프트는 복제하지 않습니다'), t('외부 첨부는 접근 가능성을 확인하지 않았으며 원문 내부 데이터와 참조만 보존합니다')] };
  const index = await open(join(directory, 'records.jsonl'), 'wx', 0o600);
  try {
    async function addRaw(path, role) {
      const roots = source.provider === 'claude' ? [join(claudeHome, 'projects')] : [join(codexHome, 'sessions'), join(codexHome, 'archived_sessions')];
      path = await validatedTranscript(path, roots);
      if (role === 'main' && source.provider === 'claude' && basename(path) !== `${source.id}.jsonl`) throw new Error(t('선택한 session id와 transcript 경로가 일치하지 않습니다'));
      const destination = `raw/${role === 'main' ? 'main' : `subagent-${manifest.raw.length}`}.jsonl`;
      const raw = { path: destination, originalPath: path, role, ...await snapshot(path, join(directory, destination)) };
      manifest.raw.push(raw);
      await readableChunks(directory, destination, manifest);
      await indexJsonl(directory, raw, index, manifest, role === 'main' && source.provider === 'claude', source);
    }
    if (source.provider === 'claude') {
      if (!source.transcriptPath) throw new Error(t('Claude transcript 경로가 없습니다'));
      await addRaw(source.transcriptPath, 'main');
      const subdirectory = join(dirname(manifest.raw[0].originalPath), source.id, 'subagents');
      let subagents;
      try { subagents = await readdir(subdirectory, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; subagents = []; }
      for (const entry of subagents.sort((a, b) => a.name.localeCompare(b.name))) if (entry.isFile() && /^[A-Za-z0-9_-]+\.jsonl$/.test(entry.name)) await addRaw(join(subdirectory, entry.name), 'subagent');
    } else {
      const response = await codexClient.request('thread/read', { threadId: source.id });
      if (response?.thread?.id !== source.id || response.thread.cwd !== source.cwd) throw new Error(t('선택한 Codex 세션 id/cwd가 현재 metadata와 일치하지 않습니다'));
      await writeJson(join(directory, 'thread.json'), response);
      if (response.thread.path || source.transcriptPath) await addRaw(response.thread.path || source.transcriptPath, 'main');
      else manifest.warnings.push(t('Codex raw rollout 경로가 없어 공식 API full history를 보존했습니다'));
      const cursors = new Set();
      let cursor;
      do {
        const page = await codexClient.request('thread/turns/list', { threadId: source.id, itemsView: 'full', sortDirection: 'asc', limit: 50, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(page?.data)) throw new Error(t('Codex full history 페이지가 올바르지 않습니다'));
        if (page.data.some(turn => turn.itemsView && turn.itemsView !== 'full' || !Array.isArray(turn.items))) throw new Error(t('Codex history full items를 확인하지 못했습니다'));
        const path = `turns-${String(manifest.apiPages.length + 1).padStart(5, '0')}.json`;
        await writeJson(join(directory, path), page);
        manifest.apiPages.push(path);
        await readableChunks(directory, path, manifest);
        for (const turn of page.data) { if (turn.id) manifest.latestLeaf = turn.id; }
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error(t('Codex cursor 반복으로 전체 페이지 보존을 확인하지 못했습니다'));
        if (cursor) cursors.add(cursor);
      } while (cursor);
    }
    manifest.latestChunks = manifest.chunks.filter(chunk => source.provider === 'codex'
      ? chunk.source === manifest.apiPages.at(-1)
      : manifest.latestRecord && chunk.source === manifest.latestRecord.source && chunk.startByte < manifest.latestRecord.startByte + manifest.latestRecord.byteLength && chunk.startByte + chunk.byteLength > manifest.latestRecord.startByte).map(chunk => chunk.path);
    manifest.git = {};
    for (const [name, args] of [['head', ['rev-parse', 'HEAD']], ['status', ['status', '--porcelain=v1']], ['diff', ['diff', '--no-ext-diff', '--no-textconv', '--binary']], ['staged', ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary']]]) {
      manifest.git[name] = { path: `git-${name}.txt`, available: await gitCommand(source.cwd, args, join(directory, `git-${name}.txt`)) };
    }
    manifest.complete = true;
    await writeJson(join(directory, 'manifest.json'), manifest);
    const indexLines = manifest.chunks.map(c => `- ${c.path}: ${c.source} bytes ${c.startByte}..${c.startByte + c.byteLength}`).join('\n');
    const start = t('bundle.start',{cwd:JSON.stringify(source.cwd),source:`${source.provider}:${source.id}`,latestLeaf:JSON.stringify(manifest.latestLeaf),latestChunks:JSON.stringify(manifest.latestChunks),latestRecord:JSON.stringify(manifest.latestRecord??null),activeBranch:JSON.stringify(manifest.activeBranch),warnings:manifest.warnings.map(warning=>t('주의: {warning}',{warning})).join('\n'),index:indexLines,limits:manifest.limits.join('\n')});
    await writeFile(join(directory, 'START_HERE.md'), start, { mode: 0o600, flag: 'wx' });
    const prompt = t('bundle.prompt',{path:JSON.stringify(join(directory,'START_HERE.md'))});
    return { directory, manifest, prompt };
  } catch (error) {
    await writeFile(join(directory, 'FAILED.json'), JSON.stringify({ complete: false, error: error.message }), { mode: 0o600 }).catch(() => {});
    throw error;
  } finally { await index.close(); }
}
