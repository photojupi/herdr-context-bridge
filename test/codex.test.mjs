import {t as message} from '../src/i18n.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { withCodex } from '../src/codex.mjs';

const args = [new URL('./fixtures/quota/fake-codex.mjs', import.meta.url).pathname];
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
