import {t} from './i18n.mjs';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { resolveCommand } from './commands.mjs';

// A fresh app-server owns authentication. This client never resumes a session.
export async function withCodex(callback, options = {}) {
  let command;
  try { command = await resolveCommand(options.binary ?? 'codex', { env: options.env ?? process.env }); }
  catch { throw new Error(t('Codex app-server could not start')); }
  const child = spawn(command.file, [...command.args, ...(options.args ?? ['app-server'])], {
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  const waitForClose = async timeout => {
    let timer;
    try { return await Promise.race([closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), timeout); })]); }
    finally { clearTimeout(timer); }
  };
  const pending = new Map();
  let nextId = 0;
  let failure;
  let rejectFailure;
  const failed = new Promise((_, reject) => { rejectFailure = reject; });
  // An error may arrive between two callback requests.
  failed.catch(() => {});
  const fail = error => {
    if (failure) return;
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    rejectFailure(error);
  };
  const send = message => {
    if (failure) throw failure;
    child.stdin.write(`${JSON.stringify(message)}\n`, error => {
      if (error) fail(new Error(t('Codex app-server input closed')));
    });
  };
  const client = {
    request(method, params = {}) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        try { send({ id, method, params }); } catch (error) { pending.delete(id); reject(error); }
      });
    },
  };
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { fail(new Error(t('Codex app-server returned malformed JSON'))); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      fail(new Error(t('Codex app-server returned an invalid message')));
      return;
    }
    if (message.method && message.id !== undefined) {
      // Never supply host credentials or approve server-initiated actions.
      try { send({ id: message.id, error: { code: -32601, message: 'Unsupported client request' } }); } catch {}
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(t('Codex app-server request failed')));
    else if (Object.hasOwn(message, 'result')) request.resolve(message.result);
    else request.reject(new Error(t('Codex app-server returned an invalid response')));
  });
  // Drain diagnostics without exposing possibly sensitive CLI output.
  child.stderr.resume();
  child.on('error', () => fail(new Error(t('Codex app-server could not start'))));
  child.on('exit', () => fail(new Error(t('Codex app-server exited before completion'))));
  child.stdin.on('error', () => fail(new Error(t('Codex app-server input closed'))));
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15000;
  const timer = setTimeout(() => fail(new Error(t('Codex app-server timed out'))), timeoutMs);
  try {
    return await Promise.race([(async () => {
      await client.request('initialize', {
        clientInfo: { name: 'herdr_context_bridge', title: 'Herdr Context Bridge', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      send({ method: 'initialized', params: {} });
      return callback(client);
    })(), failed]);
  } finally {
    clearTimeout(timer);
    lines.close();
    // npm launchers must have time to reap their native app-server after EOF.
    child.stdin.end();
    if (!await waitForClose(200)) {
      if (process.platform === 'win32' && child.pid && child.exitCode === null && child.signalCode === null) {
        const taskkill = join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'taskkill.exe');
        await new Promise(resolve => execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { timeout: 500, windowsHide: true }, () => resolve()));
      } else child.kill('SIGTERM');
      if (!await waitForClose(500)) {
        child.kill('SIGKILL');
        await waitForClose(100);
      }
    }
    child.stdin.destroy();
    fail(new Error(t('Codex app-server connection closed')));
  }
}
