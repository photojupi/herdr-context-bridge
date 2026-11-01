import test from 'node:test';
import assert from 'node:assert/strict';
import { quotaState, lowQuotaAlerts, localSources, sourceKey } from '../mods/context-bridge/ui-logic.js';
import * as logic from '../mods/context-bridge/ui-logic.js';

const now = 1_800_000_000_000;
const quota = (remainingPercent = 10) => ({ provider: 'claude', observedAt: now, windows: [{ id: 'five_hour', label: '5시간', remainingPercent, resetsAt: now + 300_000 }] });

test('summary keeps four periods and matches canonical Claude ids and actual Codex durations', () => {
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
  assert.equal(logic.quotaSummary({}, 10, now).length, 4);
});

test('summary never guesses Codex periods or combines model buckets', () => {
  assert.equal(typeof logic.quotaSummary, 'function');
  const window = (id, remainingPercent, minutes = 300) => ({ id, remainingPercent, labelParams: { minutes }, resetsAt: now + 1000 });
  const summarize = (windows) => logic.quotaSummary({ codex: { provider: 'codex', observedAt: now, windows } }, 10, now).slice(2);
  assert.equal(summarize([window('codex:primary', 99, null)])[0].remaining, null);
  assert.equal(summarize([window('model-a:primary', 20), window('model-b:primary', 30)])[0].remaining, null);
  assert.equal(summarize([window('model-a:primary', 20)])[0].remaining, null);
  assert.equal(summarize([window('model-a:primary', 20), window('codex:secondary', 75)])[0].remaining, 75);
  assert.equal(summarize([window('codex:primary', 20), window('codex:secondary', 75)])[0].remaining, null);
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
