import test from 'node:test';
import assert from 'node:assert/strict';
import { quotaState, lowQuotaAlerts, localSources, sourceKey } from '../mods/context-bridge/ui-logic.js';
import * as logic from '../mods/context-bridge/ui-logic.js';
import { normalizeAgyQuota } from '../src/quota.mjs';

const now = 1_800_000_000_000;
const quota = (remainingPercent = 10) => ({ provider: 'claude', observedAt: now, windows: [{ id: 'five_hour', label: '5시간', remainingPercent, resetsAt: now + 300_000 }] });

test('summary keeps periods for present providers and matches canonical Claude ids and actual Codex durations', () => {
  assert.equal(typeof logic.quotaSummary, 'function');
  const windows = [
    { id: 'codex:secondary', labelParams: { minutes: 300 }, remainingPercent: 42, resetsAt: now + 1000 },
    { id: 'codex:primary', labelParams: { minutes: 10080 }, remainingPercent: 63, resetsAt: now + 1000 },
  ];
  const summary = logic.quotaSummary({ claude: { ...quota(), windows: [...quota().windows, { id: 'seven_day', remainingPercent: 80, resetsAt: now + 1000 }] }, codex: { provider: 'codex', observedAt: now, windows } }, 10, now);
  assert.deepEqual(summary.map(({ provider, period, remaining, warning }) => ({ provider, period, remaining, warning })), [
    { provider: 'claude', period: 'fiveHour', remaining: 10, warning: true },
    { provider: 'claude', period: 'weekly', remaining: 80, warning: false },
    { provider: 'codex', period: 'fiveHour', remaining: 42, warning: false },
    { provider: 'codex', period: 'weekly', remaining: 63, warning: false },
  ]);
  assert.deepEqual(logic.quotaSummary({}, 10, now), []);
  assert.deepEqual(logic.quotaSummary({ claude: quota() }, 10, now).map(({ provider }) => provider), ['claude', 'claude']);
});

test('summary never guesses Codex periods or combines model buckets', () => {
  assert.equal(typeof logic.quotaSummary, 'function');
  const window = (id, remainingPercent, minutes = 300) => ({ id, remainingPercent, labelParams: { minutes }, resetsAt: now + 1000 });
  const summarize = (windows) => logic.quotaSummary({ codex: { provider: 'codex', observedAt: now, windows } }, 10, now);
  assert.equal(summarize([window('codex:primary', 99, null)])[0].remaining, null);
  assert.equal(summarize([window('model-a:primary', 20), window('model-b:primary', 30)])[0].remaining, null);
  assert.equal(summarize([window('model-a:primary', 20)])[0].remaining, null);
  assert.equal(summarize([window('model-a:primary', 20), window('codex:secondary', 75)])[0].remaining, 75);
  assert.equal(summarize([window('codex:primary', 20), window('codex:secondary', 75)])[0].remaining, null);
});

test('AGY summary selects only the Argon weekly quota without changing other collected buckets', () => {
  const agy = { provider: 'agy', observedAt: now, windows: [
    { id: '3p-5h', remainingPercent: 1, resetsAt: now + 300_000 },
    { id: '3p-weekly', remainingPercent: 80, resetsAt: now + 300_000 },
    { id: 'gemini-5h', remainingPercent: 90, resetsAt: now + 300_000 },
    { id: 'gemini-argon-wtu-weekly', remainingPercent: 25, resetsAt: now + 300_000 },
    { id: 'gemini-weekly', remainingPercent: 60, resetsAt: now + 300_000 },
  ] };
  const before = structuredClone(agy);
  const summary = logic.quotaSummary({ agy }, 10, now);
  assert.deepEqual(summary.map(({ provider, period, label, bucketId, remaining, warning }) => ({ provider, period, label, bucketId, remaining, warning })), [
    { provider: 'agy', period: 'weekly', label: 'Gemini 4 Argon', bucketId: 'gemini-argon-wtu-weekly', remaining: 25, warning: false },
  ]);
  assert.deepEqual(agy, before);
  assert.equal(lowQuotaAlerts(agy, 10, now, {})[0].window.id, '3p-5h');
});

test('missing Argon weekly quota never falls back to another AGY weekly quota', () => {
  for (const agy of [
    { provider: 'agy', observedAt: now, windows: [{ id: 'gemini-weekly', remainingPercent: 90, resetsAt: now + 1000 }, { id: '3p-weekly', remainingPercent: 80, resetsAt: now + 1000 }] },
    { provider: 'agy', windows: [], error: 'offline' },
  ]) {
    const [entry, ...rest] = logic.quotaSummary({ agy }, 10, now);
    assert.deepEqual(rest, []);
    assert.equal(entry.period, 'weekly');
    assert.equal(entry.remaining, null);
    assert.equal(entry.warning, false);
  }
});

test('AGY invalid or disabled buckets never show a number or trigger a usage warning', () => {
  for (const patch of [{ disabled: true }, { remainingPercent: -1 }, { remainingPercent: 101 }, { remainingPercent: null }, { resetsAt: now }]) {
    const agy = { provider: 'agy', observedAt: now, windows: [{ id: 'gemini-argon-wtu-weekly', remainingPercent: 5, resetsAt: now + 1000, ...patch }] };
    assert.equal(logic.quotaSummary({ agy }, 10, now)[0]?.remaining, null);
    assert.deepEqual(lowQuotaAlerts(agy, 10, now, {}), []);
  }
  const agy = { provider: 'agy', observedAt: now, windows: [{ id: 'bucket', remainingPercent: 5, resetsAt: now + 1000 }] };
  assert.equal(lowQuotaAlerts(agy, 10, now, {}).length, 1);
});

test('Argon weekly summary keeps fresh warnings and stale markers', () => {
  const agy = { provider: 'agy', observedAt: now, windows: [{ id: 'gemini-argon-wtu-weekly', remainingPercent: 10, resetsAt: now + 900_000 }] };
  assert.equal(logic.quotaSummary({ agy }, 10, now)[0].warning, true);
  const stale = logic.quotaSummary({ agy }, 10, now + 600_000)[0];
  assert.equal(stale.remaining, 10);
  assert.equal(stale.state, 'stale');
  assert.equal(stale.warning, false);
});

test('summary excludes invalid and reset values, marks old data separately and warns only on fresh values', () => {
  assert.equal(typeof logic.quotaSummary, 'function');
  for (const patch of [
    { remainingPercent: null }, { remainingPercent: -1 }, { remainingPercent: 101 }, { remainingPercent: NaN },
    { resetsAt: now }, { resetsAt: null },
  ]) {
    const q = { ...quota(), windows: [{ ...quota().windows[0], ...patch }] };
    assert.equal(logic.quotaSummary({ claude: q }, 10, now)[0].remaining, null);
  }
  for (const patch of [{ error: 'unavailable' }, { observedAt: now + 61_000 }, { observedAt: null }]) {
    assert.equal(logic.quotaSummary({ claude: { ...quota(), ...patch } }, 10, now)[0].remaining, null);
  }
  const old = logic.quotaSummary({ claude: { ...quota(), observedAt: now - 600_000 } }, 10, now)[0];
  assert.equal(old.remaining, 10);
  assert.equal(old.state, 'stale');
  assert.equal(old.warning, false);
  assert.equal(logic.quotaSummary({ claude: quota(11) }, 10, now)[0].warning, false);
});

test('unknown, errored and ten-minute-old usage cannot produce low quota alerts', () => {
  assert.equal(quotaState(null, now), 'unknown');
  assert.equal(quotaState({ ...quota(), error: 'failed' }, now), 'error');
  assert.equal(quotaState(quota(), now + 600_000), 'stale');
  for (const q of [null, { ...quota(), error: 'failed' }, { ...quota(), observedAt: now - 600_000 }]) {
    assert.deepEqual(lowQuotaAlerts(q, 10, now, {}), []);
  }
});

test('first low observation alerts at the threshold and only once in each reset cycle', () => {
  const q = quota();
  const [alert] = lowQuotaAlerts(q, 10, now, {});
  assert.equal(alert.key, 'claude:five_hour');
  assert.equal(alert.cycle, String(now + 300_000));
  assert.deepEqual(lowQuotaAlerts(q, 10, now, { [alert.key]: alert.cycle }), []);
  assert.equal(lowQuotaAlerts({ ...q, windows: [{ ...q.windows[0], resetsAt: now + 900_000 }] }, 10, now, { [alert.key]: alert.cycle }).length, 1);
  assert.deepEqual(lowQuotaAlerts(quota(11), 10, now, {}), []);
});

test('missing percentages and already reset windows stay unknown', () => {
  assert.deepEqual(lowQuotaAlerts({ ...quota(), windows: [{ id: 'x', remainingPercent: null }] }, 10, now, {}), []);
  assert.deepEqual(lowQuotaAlerts({ ...quota(), windows: [{ id: 'x', remainingPercent: 0, resetsAt: now }] }, 10, now, {}), []);
});

test('AGY relative reset countdown jitter does not repeat an alert within the same cycle', () => {
  const firstNow = now + 123;
  const payload = seconds => ({ quota: { custom: { remaining_fraction: 0.05, reset_in_seconds: seconds } } });
  const [first] = lowQuotaAlerts(normalizeAgyQuota(payload(3600), firstNow), 10, firstNow, {});
  const later = firstNow + 60_200;
  const updated = normalizeAgyQuota(payload(3540), later);
  assert.deepEqual(lowQuotaAlerts(updated, 10, later, { [first.key]: first.cycle }), []);
  const afterReset = Number(first.cycle) + 100;
  assert.equal(lowQuotaAlerts(normalizeAgyQuota(payload(0.5), afterReset), 10, afterReset, { [first.key]: first.cycle }).length, 1);
  const absolute = normalizeAgyQuota({ quota: { custom: { remaining_fraction: 0.05, reset_time: new Date(Number(first.cycle) + 200).toISOString() } } }, later);
  assert.equal(lowQuotaAlerts(absolute, 10, later, { [first.key]: first.cycle }).length, 1);
});

test('invalid, future and incomplete observations cannot prompt a handoff', () => {
  for (const window of [
    { id: 'x', remainingPercent: -1, resetsAt: now + 1000 },
    { id: 'x', remainingPercent: 0 },
  ]) assert.deepEqual(lowQuotaAlerts({ ...quota(), windows: [window] }, 10, now, {}), []);
  assert.deepEqual(lowQuotaAlerts({ ...quota(), observedAt: now + 61_000 }, 10, now, {}), []);
});

test('source picker includes only local Claude/Codex terminal panes with a known cwd', () => {
  const spaces = [{ id: 'local', machine: null, tabs: [{ id: 'lt' }] }, { id: 'remote', machine: 'server', tabs: [{ id: 'rt' }] }];
  const panes = [
    { terminal: 't1', tab: 'lt', cwd: '/repo', title: 'work', program: { key: 'claude' } },
    { terminal: 't2', tab: 'rt', cwd: '/repo', program: { key: 'codex' } },
    { terminal: 't3', tab: 'lt', cwd: '/repo', program: { key: 'shell' } },
    { terminal: 't4', tab: 'lt', cwd: null, program: { key: 'codex' } },
  ];
  const sources = localSources(panes, spaces, [{ address: 't3', app: 'codex' }]);
  assert.deepEqual(sources.map(({ terminalId, provider, space }) => ({ terminalId, provider, space })), [
    { terminalId: 't1', provider: 'claude', space: 'local' },
    { terminalId: 't3', provider: 'codex', space: 'local' },
  ]);
  assert.equal(sourceKey({ provider: 'codex', id: 'session-1' }), 'codex:session-1');
});
