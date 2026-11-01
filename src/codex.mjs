import {t} from './i18n.mjs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// A fresh app-server owns authentication. This client never resumes a session.
export async function withCodex(callback, options = {}) {
  const child = spawn(options.binary ?? 'codex', options.args ?? ['app-server'], {
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
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
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => {
        const killTimer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 500);
        child.once('close', () => { clearTimeout(killTimer); resolve(); });
      });
    }
    fail(new Error(t('Codex app-server connection closed')));
  }
}
