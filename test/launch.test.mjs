import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchTarget } from '../src/launch.mjs';
import { t as translate } from '../src/i18n.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge launch 한글 %!& '));
  const calls = join(dir, 'calls.jsonl');
  const values = { PATH: dir, BRIDGE_TEST_CALLS: calls, BRIDGE_TEST_VALUE: '값 %PATH% !X! & "', HERDR_BRIDGE_AUTO_ORIGIN: 'previous', HERDR_BRIDGE_JOB_ID: 'previous' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });
  const body = `require('node:fs').appendFileSync(process.env.BRIDGE_TEST_CALLS,JSON.stringify({args:process.argv.slice(2),origin:process.env.HERDR_BRIDGE_AUTO_ORIGIN,jobId:process.env.HERDR_BRIDGE_JOB_ID,value:process.env.BRIDGE_TEST_VALUE})+'\\n');`;
  for (const target of ['claude', 'codex', 'agy']) {
    const path = join(dir, target);
    if (process.platform === 'win32') {
      await writeFile(`${path}.cjs`, `#!/usr/bin/env node\n${body}\n`);
      await writeFile(`${path}.cmd`, `@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe" "%~dp0\\${target}.cjs" %*\r\n) ELSE (\r\n  @SETLOCAL\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node "%~dp0\\${target}.cjs" %*\r\n)\r\n`);
    } else {
      await writeFile(path, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
      await chmod(path, 0o700);
    }
  }
  return calls;
}

const prompt = '공백 과 한글 "hello" \'world\' back\\slash\\ %PATH% !NAME! a & b | c < d > e ^ f $HOME $(echo unsafe)\nsecond\r\nthird';
for (const [target, permissionMode, automatic, flags] of [
  ['claude', undefined, '0', []],
  ['claude', 'default', '1', []],
  ['claude', 'bypass', '0', ['--dangerously-skip-permissions']],
  ['claude', 'bypass', '1', ['--dangerously-skip-permissions']],
  ['codex', undefined, '0', ['--no-daemon']],
  ['codex', 'default', '1', ['--no-daemon']],
  ['codex', 'bypass', '0', ['--no-daemon', '--yolo']],
  ['codex', 'bypass', '1', ['--no-daemon', '--yolo']],
  ['agy', undefined, '0', ['--prompt-interactive']],
  ['agy', 'default', '1', ['--prompt-interactive']],
  ['agy', 'bypass', '0', ['--dangerously-skip-permissions', '--prompt-interactive']],
  ['agy', 'bypass', '1', ['--dangerously-skip-permissions', '--prompt-interactive']],
]) {
  test(`${target} ${permissionMode ?? 'omitted'} mode preserves prompt and origin ${automatic} in a real CLI process`, async t => {
    const calls = await fixture(t), jobId = `job-${target}`;
    assert.equal(await launchTarget(target, jobId, automatic, prompt, permissionMode), 0);
    const results = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(results, [{ args: [...flags, prompt], origin: automatic, jobId, value: '값 %PATH% !X! & "' }]);
  });
}

test('invalid permission modes are rejected before launching a CLI', async t => {
  const calls = await fixture(t);
  for (const permissionMode of ['', 'yolo', 'bypassPermissions', null, true, 1, {}]) {
    await assert.rejects(launchTarget('codex', 'job-invalid', '0', prompt, permissionMode), { message: translate('잘못된 세션입니다.') });
  }
  await assert.rejects(readFile(calls), { code: 'ENOENT' });
});
