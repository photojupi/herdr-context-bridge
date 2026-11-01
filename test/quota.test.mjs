import {t as message} from '../src/i18n.mjs';
import test from 'node:test';
import {quotaHealth} from '../src/policy.mjs';
import assert from 'node:assert/strict';

test('explicit ordinary usage denial cannot be inferred available from percentages',()=>{
  const now=Date.now();
  const result=normalizeCodexQuota({ordinaryUsageAllowed:false,rateLimits:{limitId:'codex',primary:{usedPercent:5,resetsAt:now/1000+600}}},now);
  assert.equal(quotaHealth(result,now).usable,false);
  assert.equal(result.ordinaryUsageAllowed,false);
});
import { normalizeClaudeQuota, normalizeCodexQuota, readCodexQuota } from '../src/quota.mjs';

const now = 1800000000000;

test('missing subscription usage is unknown rather than full remaining quota', () => {
  for (const quota of [normalizeClaudeQuota({}, now), normalizeCodexQuota({}, now)]) {
    assert.equal(quota.observedAt, now);
    assert.deepEqual(quota.windows, []);
    assert.ok(quota.error);
  }
  assert.deepEqual(normalizeClaudeQuota({ context_window: { remaining_percentage: 80 } }, now).windows, []);
});

test('Codex normalizes every bucket with actual durations and no legacy duplicates', () => {
  const quota = normalizeCodexQuota({
    rateLimits: { primary: { usedPercent: 99 } },
    rateLimitsByLimitId: {
      codex: { primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: 1800000100 }, secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1800600000 } },
      reviews: { limitName: 'Reviews', primary: { usedPercent: 0, windowDurationMins: 60, resetsAt: 1800003600 } },
    },
  }, now);
  assert.equal(quota.windows.length, 3);
  assert.deepEqual(quota.windows.map(w => [w.id, w.remainingPercent, w.resetsAt]), [
    ['codex:primary', 10, 1800000100000], ['codex:secondary', 95, 1800600000000], ['reviews:primary', 100, 1800003600000],
  ]);
  assert.equal(quota.windows[0].label,message('{period} 한도',{period:message('{count}시간',{count:5})}));
  assert.match(quota.windows[2].label, /Reviews/);
});

test('legacy quota and Claude spend buckets preserve zero and reject invalid usage', () => {
  assert.equal(normalizeCodexQuota({ rateLimits: { primary: { usedPercent: 0 } } }, now).windows[0].remainingPercent, 100);
  const quota = normalizeClaudeQuota({ rate_limits: {
    five_hour: { used_percentage: 100, resets_at: 1800001000 },
    spend_limit: { used_percentage: 12.5, resets_at: 1800002000 },
    seven_day: { used_percentage: null, resets_at: null },
    bad: { used_percentage: 101 },
  } }, now);
  assert.deepEqual(quota.windows.map(w => [w.id, w.remainingPercent, w.resetsAt]), [
    ['five_hour', 0, 1800001000000], ['spend_limit', 87.5, 1800002000000], ['seven_day', null, null], ['bad', null, null],
  ]);
  assert.ok(quota.error);
});

test('expired quota is never silently reset to available', () => {
  const quota = normalizeClaudeQuota({ rate_limits: { five_hour: { used_percentage: 99, resets_at: 1799999999 } } }, now);
  assert.equal(quota.windows[0].remainingPercent, 1);
  assert.equal(quota.error,message('리셋 후 사용량 갱신을 기다립니다.'));
});

test('official account ID and individual spend limit are preserved without tokens or credits', () => {
  const quota = normalizeCodexQuota({ accountId: 'account-123', accessToken: 'SECRET', rateLimits: {
    individualLimit: { remainingPercent: 20, resetsAt: 1800001000, used: '80', limit: '100' },
    credits: { balance: 'SECRET', unlimited: true },
  } }, now);
  assert.equal(quota.accountId, 'account-123');
  assert.equal(quota.windows[0].remainingPercent, 20);
  assert.doesNotMatch(JSON.stringify(quota), /SECRET|accessToken|balance/);
});

test('readCodexQuota handles official RPC and returns sanitized unknown on errors', async () => {
  const args = [new URL('./fixtures/quota/fake-codex.mjs', import.meta.url).pathname];
  const quota = await readCodexQuota({ binary: process.execPath, args, env: { ...process.env, FAKE_CODEX_MODE: 'quota' }, timeoutMs: 1000 });
  assert.equal(quota.provider, 'codex');
  assert.equal(quota.windows[0].remainingPercent, 25);
  const failed = await readCodexQuota({ binary: process.execPath, args, env: { ...process.env, FAKE_CODEX_MODE: 'error' }, timeoutMs: 1000 });
  assert.deepEqual(failed.windows, []);
  assert.ok(failed.error);
  assert.doesNotMatch(JSON.stringify(failed), /SECRET/);
});
