import readline from 'node:readline';
let initialized = false;
let acknowledged = false;
const mode = process.env.FAKE_CODEX_MODE;
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (mode === 'hang') return;
  if (message.method === 'initialize') {
    initialized = Boolean(message.params.clientInfo.name);
    return send({ id: message.id, result: { userAgent: 'fake' } });
  }
  if (message.method === 'initialized') { acknowledged = true; return; }
  if (!initialized || !acknowledged) return send({ id: message.id, error: { code: -32000, message: 'Not initialized' } });
  if (mode === 'exit') process.exit(3);
  if (mode === 'malformed') return process.stdout.write('SECRET invalid JSON\n');
  if (mode === 'error') return send({ id: message.id, error: { code: -32000, message: 'SECRET private error' } });
  if (message.method === 'pid') return send({ id: message.id, result: process.pid });
  if (mode === 'quota' && message.method === 'account/rateLimits/read') {
    return send({ id: message.id, result: { rateLimits: { primary: { usedPercent: 75, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 300 } } } });
  }
  if (message.method !== 'echo') process.exit(4);
  send({ method: 'notice', params: { ignored: true } });
  setTimeout(() => send({ id: message.id, result: message.params }), message.params.value === 1 ? 20 : 0);
});
