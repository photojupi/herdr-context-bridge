// Run separately with: node --max-old-space-size=48 test/fixtures/bundle/large-snapshot.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, open, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBundle } from '../../../src/bundle.mjs';
const home = await mkdtemp(join(tmpdir(), 'bridge-large-snapshot-'));
try {
  const project = join(home, 'claude', 'projects', '-test');
  await mkdir(project, { recursive: true });
  const transcriptPath = join(project, 'large.jsonl');
  const handle = await open(transcriptPath, 'w');
  const hash = createHash('sha256');
  let bytes = 0;
  async function append(value) { hash.update(value); bytes += Buffer.byteLength(value); await handle.write(value); }
  await append('{"type":"assistant","uuid":"large-record","message":{"content":"');
  const part = 'x'.repeat(65536);
  for (let i = 0; i < 3200; i++) await append(part);
  await append('"}}\n');
  await handle.close();
  const result = await createBundle({ provider: 'claude', id: 'large', cwd: home, transcriptPath }, { stateDir: join(home, 'state'), claudeHome: join(home, 'claude') });
  assert.equal(result.manifest.raw[0].bytes, bytes);
  assert.equal(result.manifest.raw[0].sha256, hash.digest('hex'));
  const chunkHash = createHash('sha256');
  for (const chunk of result.manifest.chunks) for await (const data of createReadStream(join(result.directory, chunk.path))) chunkHash.update(data);
  assert.equal(chunkHash.digest('hex'), result.manifest.raw[0].sha256);
  assert.ok(result.manifest.warnings.some(w => w.includes('큰 record')));
  process.stdout.write(JSON.stringify({ bytes, chunks: result.manifest.chunks.length, heapLimitMiB: 48, exactRawAndChunks: true }) + '\n');
} finally { await rm(home, { recursive: true, force: true }); }
