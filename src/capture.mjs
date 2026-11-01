import {t} from './i18n.mjs';
import { spawn } from 'node:child_process';
import { mkdir, rmdir, rename, stat, readdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, join } from 'node:path';
import { stateDirectory, readJson, atomicJson } from './storage.mjs';
import { normalizeClaudeQuota } from './quota.mjs';

const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value);

function deadOwner(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

async function recoverCaptureLock(lock, info) {
  // Each reclaimer pins the old directory until its checks finish. Only empty
  // directories are removed; a newly acquired populated lock is never deleted.
  const marker = join(lock, `reclaim-${process.pid}-${randomUUID()}`);
  try { await mkdir(marker, { mode: 0o700 }); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  let stale = false;
  try {
    let owner;
    try { owner = await readJson(join(lock, 'owner.json')); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    stale = owner && Number.isInteger(owner.pid) && owner.pid > 0
      ? deadOwner(owner.pid) : Date.now() - info.mtimeMs >= 30000;
    if (!stale) return false;
    await unlink(join(lock, 'owner.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    for (const name of await readdir(lock)) {
      const match = /^reclaim-(\d+)-[a-f0-9-]+$/.exec(name);
      if (match && deadOwner(Number(match[1]))) {
        await rmdir(join(lock, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    }
  } finally {
    await rmdir(marker);
  }
  if (stale) {
    try { await rmdir(lock); return true; }
    catch (error) { if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) return false; throw error; }
  }
  return false;
}

async function acquireCaptureLock(lock) {
  let info;
  try { info = await stat(lock); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (info && !await recoverCaptureLock(lock, info)) return false;
  const candidate = `${lock}-${randomUUID()}.pending`;
  await mkdir(candidate, { mode: 0o700 });
  try {
    await writeFile(join(candidate, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { mode: 0o600, flag: 'wx' });
    try { await rename(candidate, lock); return true; }
    catch (error) { if (['ENOTEMPTY', 'EEXIST'].includes(error.code)) return false; throw error; }
  } finally {
    await unlink(join(candidate, 'owner.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(candidate).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function capture(provider, event, { stateDir, env = process.env } = {}) {
  stateDir ??= stateDirectory(env);
  if (!['claude', 'codex'].includes(provider) || !event || typeof event !== 'object') return null;
  if (event.subagent_id || event.agent_id) return null;
  const id = event.session_id ?? event.thread_id;
  const cwd = event.cwd ?? event.workspace?.current_dir;
  if (!safeId(id) || typeof cwd !== 'string' || !isAbsolute(cwd)) return null;
  const transcriptPath = event.transcript_path;
  if (transcriptPath !== undefined && (typeof transcriptPath !== 'string' || !isAbsolute(transcriptPath))) return null;
  if (transcriptPath) {
    const file = basename(transcriptPath);
    if (file !== `${id}.jsonl` && !(provider === 'codex' && file.startsWith('rollout-') && file.endsWith(`-${id}.jsonl`))) return null;
  }
  let terminalId = safeId(env.HC_TERMINAL_ID) ? env.HC_TERMINAL_ID : undefined;
  const lock = terminalId ? join(stateDir, 'capture-locks', terminalId) : null;
  if (lock) {
    await mkdir(join(stateDir, 'capture-locks'), { recursive: true, mode: 0o700 });
    if (!await acquireCaptureLock(lock)) return null;
  }
  try {
    const origin = terminalId ? await readJson(join(stateDir, 'origins', `${terminalId}.json`)) : null;
    if (terminalId && event.hook_event_name !== 'SessionStart') {
      const current = await readJson(join(stateDir, 'terminals', `${terminalId}.json`));
      if (current && (current.provider !== provider || current.id !== id)) terminalId = undefined;
    }
    const previous = await readJson(join(stateDir, 'sessions', `${provider}-${id}.json`));
    const session = { provider, id, cwd, updatedAt: Date.now(), trustedBinding: Boolean(terminalId) };
    if (transcriptPath || previous?.transcriptPath) session.transcriptPath = transcriptPath || previous.transcriptPath;
    if (terminalId) session.terminalId = terminalId;
    if (env.HERDR_BRIDGE_AUTO_ORIGIN === '1' || origin?.autoOrigin || previous?.autoOrigin) session.autoOrigin = true;
    if (typeof event.hook_event_name === 'string' && /^[A-Za-z]{1,64}$/.test(event.hook_event_name)) session.event = event.hook_event_name;
    else if (previous?.event) session.event = previous.event;
    if (event.hook_event_name === 'StopFailure' && event.error === 'rate_limit') session.error = 'rate_limit';
    else if (!event.hook_event_name && previous?.error === 'rate_limit') session.error = previous.error;
    await atomicJson(join(stateDir, 'sessions', `${provider}-${id}.json`), session);
    if (terminalId) await atomicJson(join(stateDir, 'terminals', `${terminalId}.json`), session);
    return session;
  } finally {
    if (lock) {
      await unlink(join(lock, 'owner.json'));
      await rmdir(lock).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
    }
  }
}

export async function runStatusLine(input, { stateDir, env = process.env } = {}) {
  stateDir ??= stateDirectory(env);
  let payload;
  try { payload = JSON.parse(input); } catch {}
  const quota = normalizeClaudeQuota(payload);
  // Capture failures must never hide an existing user status line.
  try {
    if (!payload?.agent_id && !payload?.subagent_id) {
      await atomicJson(join(stateDir, 'quota-claude.json'), quota);
      await capture('claude', payload, { stateDir, env });
    }
  } catch {}
  const installation = await readJson(join(stateDir, 'install.json'), {});
  const original = installation?.originalStatusLine;
  const command = typeof original === 'string' ? original : original?.command;
  if (typeof command === 'string' && command.length) {
    return new Promise(resolve => {
      const child = spawn(command, { shell: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.on('error', () => resolve({ stdout, stderr, code: 1 }));
      child.on('close', code => resolve({ stdout, stderr, code: code ?? 1 }));
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }
  const summary = quota.error ? t('확인 불가') : quota.windows.map(window => t('{label} 잔여 {percent}%',{label:window.label,percent:window.remainingPercent})).join(' · ');
  return { stdout: `Claude: ${summary}\n`, stderr: '', code: 0 };
}
