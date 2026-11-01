import {t as message} from '../src/i18n.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withCodex } from '../src/codex.mjs';

const args = [fileURLToPath(new URL('./fixtures/quota/fake-codex.mjs', import.meta.url))];
const options = mode => ({ binary: process.execPath, args, env: { ...process.env, FAKE_CODEX_MODE: mode }, timeoutMs: 1000 });

test('stdio RPC initializes before requests and matches concurrent out-of-order responses', async () => {
  const result = await withCodex(client => Promise.all([client.request('echo', { value: 1 }), client.request('echo', { value: 2 })]), options('echo'));
  assert.deepEqual(result, [{ value: 1 }, { value: 2 }]);
});

for (const mode of ['malformed', 'exit', 'error']) {
  test(`stdio ${mode} rejects safely without exposing server data`, async () => {
    await assert.rejects(withCodex(client => client.request('echo', {}), options(mode)), error => {
      assert.doesNotMatch(error.message, /SECRET/);
      return true;
    });
  });
}

test('stdio has a bounded total timeout even when server remains alive', async () => {
  const start = Date.now();
  await assert.rejects(withCodex(client => client.request('echo', {}), { ...options('hang'), timeoutMs: 100 }), {message:message('Codex app-server timed out')});
  assert.ok(Date.now() - start < 2000);
});

test('callback failure closes the app server and preserves the caller error', async () => {
  await assert.rejects(withCodex(() => { throw new Error('caller failed'); }, options('echo')), /caller failed/);
});

test('a missing CLI fails without leaking spawn arguments or environment', async () => {
  await assert.rejects(withCodex(() => {}, { binary: '/missing-SECRET-code/cli', env: { SECRET: 'value' }, timeoutMs: 1000 }), error => {
    assert.doesNotMatch(error.message, /SECRET|value/);
    return true;
  });
});

test('successful RPC closes its owned subprocess before returning', async () => {
  const pid = await withCodex(client => client.request('pid'), options('echo'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

async function ownedWrapper(t, stubborn = false) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-owned-server-'));
  const worker = join(dir, 'worker.cjs'), wrapper = join(dir, 'wrapper.cjs'), closed = join(dir, 'closed');
  let pids;
  t.after(async () => {
    for (const pid of pids ? [pids.child, pids.parent] : []) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(worker, `const input = require('node:readline').createInterface({input:process.stdin});
setInterval(() => {}, 1000);
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === 'pids' ? {parent:process.ppid, child:process.pid} : {};
  process.stdout.write(JSON.stringify({id:message.id,result})+'\\n');
});
input.on('close', () => { if (!${stubborn}) setTimeout(() => process.exit(0), 30); });
`);
  await writeFile(wrapper, `const child = require('node:child_process').spawn(process.execPath, [process.argv[2]], {stdio:['pipe','inherit','inherit']});
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {});
child.on('close', () => { require('node:fs').writeFileSync(process.argv[3], 'child closed'); process.exit(0); });
`);
  return {
    options: { binary: process.execPath, args: [wrapper, worker, closed], timeoutMs: 1000 },
    remember: value => { pids = value; return value; },
    closed,
  };
}

test('owned npm-style wrapper receives EOF and reaps its app-server child before returning', async t => {
  const fixture = await ownedWrapper(t);
  const pids = await withCodex(async client => fixture.remember(await client.request('pids')), fixture.options);
  assert.throws(() => process.kill(pids.child, 0), { code: 'ESRCH' });
  assert.throws(() => process.kill(pids.parent, 0), { code: 'ESRCH' });
  assert.equal(await readFile(fixture.closed, 'utf8'), 'child closed');
});

test('Windows terminates only its owned wrapper tree when the app-server ignores EOF', { skip: process.platform !== 'win32' }, async t => {
  const fixture = await ownedWrapper(t, true);
  const start = Date.now();
  const pids = await withCodex(async client => fixture.remember(await client.request('pids')), fixture.options);
  assert.throws(() => process.kill(pids.child, 0), { code: 'ESRCH' });
  assert.throws(() => process.kill(pids.parent, 0), { code: 'ESRCH' });
  assert.ok(Date.now() - start < 2000);
});

test('POSIX force-kill fallback confirms an EOF- and SIGTERM-resistant owned server exits', { skip: process.platform === 'win32' }, async t => {
  let pid;
  t.after(() => { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
  const source = `setInterval(() => {}, 1000); process.on('SIGTERM', () => {});
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const message=JSON.parse(line);
  if(message.id!==undefined)process.stdout.write(JSON.stringify({id:message.id,result:process.pid})+'\\n');
});`;
  const start = Date.now();
  await withCodex(async client => { pid = await client.request('pid'); }, { binary: process.execPath, args: ['-e', source], timeoutMs: 1000 });
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.ok(Date.now() - start < 2000);
});
