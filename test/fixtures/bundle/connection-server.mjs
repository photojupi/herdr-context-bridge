#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const log = event => appendFileSync(process.env.BRIDGE_CONNECTION_LOG, JSON.stringify({ pid: process.pid, ...event }) + '\n');
setInterval(() => {}, 1000);
let lastMethod;
log({ event: 'start' });
process.on('SIGTERM', () => {
  const base = join(process.env.HERDR_BRIDGE_STATE_DIR, 'bundles');
  const rawExists = existsSync(base) && readdirSync(base).some(name => existsSync(join(base, name, 'raw', 'main.jsonl')));
  log({ event: 'stop', lastMethod, rawExists });
  process.exit(0);
});
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  lastMethod = request.method;
  if (request.method === 'thread/read' && process.env.BRIDGE_READ_DELAY) await new Promise(resolve => setTimeout(resolve, Number(process.env.BRIDGE_READ_DELAY)));
  const result = request.method === 'initialize' ? {} : request.method === 'thread/read'
    ? { thread: { id: 'codex-one', cwd: process.env.BRIDGE_TEST_CWD, path: process.env.BRIDGE_TEST_ROLLOUT } }
    : { data: [{ id: 'turn', status: 'completed', itemsView: 'full', items: [] }], nextCursor: null };
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
}
