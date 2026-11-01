import { spawn } from 'node:child_process';
import { access, open, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';

function envValue(env, name, windows) {
  const key = windows ? Object.keys(env).sort().find(key => key.toUpperCase() === name) : name;
  return env[key] || '';
}

async function executable(file, windows) {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, windows ? constants.F_OK : constants.X_OK);
    return true;
  } catch { return false; }
}

async function shimCommand(file) {
  // npm/read-cmd-shim's two target forms; never execute batch syntax.
  const match = (await readFile(file, 'utf8')).match(/"%(?:~dp0|dp0%)\\([^"\r\n]+)"[ \t]+%\*/i);
  const unsupported = () => Object.assign(new Error(`Unsupported Windows command shim: ${file}`), { code: 'ENOTASHIM' });
  if (!match) throw unsupported();
  const target = resolve(dirname(file), match[1].split('\\').join(sep));
  if (!(await executable(target, true))) throw Object.assign(new Error(`Command target not found: ${target}`), { code: 'ENOENT' });
  if (/\.(exe|com)$/i.test(target)) return { file: target, args: [] };
  if (!/\.(?:js|cjs|mjs)$/i.test(target)) throw unsupported();
  const handle = await open(target);
  try {
    const { buffer, bytesRead } = await handle.read({ buffer: Buffer.alloc(256), position: 0 });
    const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0];
    if (!/^#!\s*(?:\/usr\/bin\/env\s+(?:-S\s+)?|\/usr\/bin\/)?node\s*$/.test(firstLine)) throw unsupported();
  } finally { await handle.close(); }
  return { file: process.execPath, args: [target] };
}

export async function resolveCommand(binary, { env = process.env, platform = process.platform } = {}) {
  const windows = platform === 'win32';
  const explicit = windows ? /[\\/]/.test(binary) : binary.includes('/');
  const directories = explicit ? [''] : envValue(env, 'PATH', windows).split(windows ? ';' : ':').filter(Boolean);
  const extensions = !windows || extname(binary) ? [''] : (envValue(env, 'PATHEXT', true) || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(extension => extension.toLowerCase());
  for (const directory of directories) {
    for (const extension of extensions) {
      const file = resolve(directory.replace(/^"(.*)"$/, '$1'), `${binary}${extension}`);
      if (!(await executable(file, windows))) continue;
      if (!windows || /\.(exe|com)$/i.test(file)) return { file, args: [] };
      if (/\.cmd$/i.test(file)) return shimCommand(file);
      throw Object.assign(new Error(`Unsupported Windows command: ${file}`), { code: 'ENOTASHIM' });
    }
  }
  throw Object.assign(new Error(`Command not found: ${binary}`), { code: 'ENOENT' });
}

export async function spawnCommand(binary, args, options = {}) {
  const { platform, ...spawnOptions } = options;
  const command = await resolveCommand(binary, { env: options.env, platform });
  return spawn(command.file, [...command.args, ...args], { ...spawnOptions, shell: false });
}
