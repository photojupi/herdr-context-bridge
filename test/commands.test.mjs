import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { once } from 'node:events';
import { resolveCommand, spawnCommand } from '../src/commands.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge commands 한글 %!& '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const nodeShim = target => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\${target}" %*\r\n`;

test('Windows resolves PATH and PATHEXT case-insensitively without selecting Unix extensionless shims', async t => {
  const dir = await fixture(t), second = join(dir, 'second');
  await mkdir(second);
  await writeFile(join(dir, 'codex'), '#!/bin/sh\nexit 91\n');
  await writeFile(join(second, 'codex.exe'), 'native fixture');
  const result = await resolveCommand('codex', { platform: 'win32', env: { Path: `"${dir}";${second}`, PathExt: '.EXE;.CMD' } });
  assert.deepEqual(result, { file: join(second, 'codex.exe'), args: [] });
  await assert.rejects(resolveCommand('codex', { platform: 'win32', env: { PATH: dir, PATHEXT: '.EXE;.CMD' } }), { code: 'ENOENT' });
});

test('Windows honors PATHEXT ordering and explicit executable extensions', async t => {
  const dir = await fixture(t), native = join(dir, 'claude.exe');
  await writeFile(native, 'native fixture');
  await writeFile(join(dir, 'claude.cmd'), '@ECHO off\r\n"%~dp0\\claude.exe" %*\r\n');
  assert.deepEqual(await resolveCommand('claude', { platform: 'win32', env: { PATH: dir, PATHEXT: '.CMD;.EXE' } }), { file: native, args: [] });
  assert.deepEqual(await resolveCommand(native, { platform: 'win32', env: {} }), { file: native, args: [] });
});

test('Windows uses Node-compatible PATH key precedence and rejects directories', async t => {
  const dir = await fixture(t), other = join(dir, 'other');
  await mkdir(other);
  await writeFile(join(dir, 'agy.exe'), 'native fixture');
  await mkdir(join(other, 'agy.exe'));
  assert.deepEqual(await resolveCommand('agy', { platform: 'win32', env: { PATH: dir, Path: other } }), { file: join(dir, 'agy.exe'), args: [] });
  await assert.rejects(resolveCommand('agy', { platform: 'win32', env: { Path: other } }), { code: 'ENOENT' });
});

for (const [name, extension] of [['codex', 'js'], ['claude', 'cjs'], ['agy', 'mjs']]) {
  test(`Windows bypasses the npm Node shim for ${name}`, async t => {
    const dir = await fixture(t), script = join(dir, `${name}.${extension}`);
    await writeFile(script, '#!/usr/bin/env node\n');
    await writeFile(join(dir, `${name}.cmd`), nodeShim(`${name}.${extension}`));
    assert.deepEqual(await resolveCommand(name, { platform: 'win32', env: { PATH: dir } }), { file: process.execPath, args: [script] });
  });
}

test('Windows supports older npm %~dp0 Node shims and nested targets', async t => {
  const dir = await fixture(t), script = join(dir, 'node_modules', 'fixture', 'cli.js');
  await mkdir(dirname(script), { recursive: true });
  await writeFile(script, '#!/usr/bin/env node\n');
  await writeFile(join(dir, 'codex.cmd'), '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe" "%~dp0\\node_modules\\fixture\\cli.js" %*\r\n) ELSE (\r\n  @SETLOCAL\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node "%~dp0\\node_modules\\fixture\\cli.js" %*\r\n)\r\n');
  assert.deepEqual(await resolveCommand('codex', { platform: 'win32', env: { PATH: dir } }), { file: process.execPath, args: [script] });
});

test('Windows refuses unsupported shell wrappers and non-Node script targets', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'custom.cmd'), '@echo off\r\npowershell.exe custom.ps1 %*\r\n');
  await writeFile(join(dir, 'other.cmd'), nodeShim('other.js'));
  await writeFile(join(dir, 'other.js'), '#!/usr/bin/env python\n');
  for (const name of ['custom', 'other']) {
    await assert.rejects(resolveCommand(name, { platform: 'win32', env: { PATH: dir } }), { code: 'ENOTASHIM' });
  }
});

test('spawnCommand preserves prompt and JSON arguments through a real npm-shim target process', async t => {
  const dir = await fixture(t), script = join(dir, 'echo.cjs');
  await writeFile(script, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),value:process.env.BRIDGE_TEST_VALUE}));\n');
  await writeFile(join(dir, 'echo.cmd'), nodeShim('echo.cjs'));
  const args = ['', '공백 과 한글', 'say "hello"', 'back\\slash\\', '%PATH%', '!NAME!', 'a & b | c < d > e ^ f', 'first\nsecond\r\nthird', JSON.stringify({ prompt: '한글 "문장"\n%PATH% !X! &', cwd: 'C:\\space dir\\' })];
  const env = { ...process.env, PATH: dir, BRIDGE_TEST_VALUE: '값 %PATH% !X! & "' };
  const child = await spawnCommand('echo', args, { platform: 'win32', env, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, errors);
  const result = JSON.parse(output);
  assert.deepEqual(result.args, args);
  assert.equal(result.value, '값 %PATH% !X! & "');
  assert.equal(await realpath(result.cwd), await realpath(dir));
});

test('POSIX command resolution preserves executable checks and direct Node paths', { skip: process.platform === 'win32' }, async t => {
  const dir = await fixture(t), executable = join(dir, 'fixture');
  await writeFile(executable, '#!/bin/sh\nexit 0\n');
  await assert.rejects(resolveCommand('fixture', { env: { PATH: dir } }), { code: 'ENOENT' });
  await chmod(executable, 0o700);
  assert.deepEqual(await resolveCommand('fixture', { env: { PATH: `${dir}${delimiter}/missing` } }), { file: executable, args: [] });
  assert.deepEqual(await resolveCommand(process.execPath, { env: {} }), { file: process.execPath, args: [] });
});
