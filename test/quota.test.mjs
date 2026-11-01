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
import * as quotaModule from '../src/quota.mjs';

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
  assert.equal(quota.accountObserved, true);
  assert.equal(quota.windows[0].remainingPercent, 25);
  const failed = await readCodexQuota({ binary: process.execPath, args, env: { ...process.env, FAKE_CODEX_MODE: 'error' }, timeoutMs: 1000 });
  assert.deepEqual(failed.windows, []);
  assert.ok(failed.error);
  assert.notEqual(failed.accountObserved, true);
  assert.doesNotMatch(JSON.stringify(failed), /SECRET/);
});

test('AGY official quota fractions preserve bucket names and prefer ISO reset timestamps', () => {
  assert.equal(typeof quotaModule.normalizeAgyQuota, 'function');
  const quota=quotaModule.normalizeAgyQuota({quota:{
    'gemini-weekly':{remaining_fraction:0.9378,reset_time:'2027-01-15T08:00:00Z',reset_in_seconds:20},
    'other-model':{remaining_fraction:0,reset_in_seconds:0},
    full:{remaining_fraction:1,reset_in_seconds:60},
  }},now);
  assert.equal(quota.provider,'agy');
  assert.equal(quota.accountObserved,true);
  assert.deepEqual(quota.windows.map(w=>[w.id,w.label,w.remainingPercent,w.usedPercent,w.resetsAt]),[
    ['gemini-weekly','gemini-weekly',93.78,6.22,1800000000000],
    ['other-model','other-model',0,100,now],
    ['full','full',100,0,now+60000],
  ]);
});

test('AGY disabled invalid and amount-only buckets never fabricate percentage availability', () => {
  assert.equal(typeof quotaModule.normalizeAgyQuota, 'function');
  const quota=quotaModule.normalizeAgyQuota({email:'PRIVATE@example.com',quota:{
    disabled:{remaining_fraction:1,disabled:true},amount:{remaining_amount:42},
    negative:{remaining_fraction:-0.1,reset_in_seconds:-1},overflow:{remaining_fraction:1.01},
    invalidReset:{remaining_fraction:0.5,reset_time:'invalid',reset_in_seconds:60},
    missing:null,
  }},now);
  assert.equal(quota.accountObserved,true);
  assert.deepEqual(quota.windows.map(w=>[w.id,w.remainingPercent,w.resetsAt]),[
    ['disabled',null,null],['amount',null,null],['negative',null,null],['overflow',null,null],['invalidReset',50,null],
  ]);
  assert.equal(quota.windows[0].disabled,true);
  assert.equal(quota.windows[1].remainingAmount,42);
  assert.equal(quota.error,undefined);
  assert.doesNotMatch(JSON.stringify(quota),/PRIVATE|email/);
  for(const input of [{},{agent_state:'authenticating',quota:{}},{quota:{bad:{remaining_fraction:'1'}}}])
    assert.notEqual(quotaModule.normalizeAgyQuota(input,now).accountObserved,true);
  assert.notEqual(normalizeClaudeQuota({rate_limits:{bad:{used_percentage:101}}},now).accountObserved,true);
  assert.equal(normalizeClaudeQuota({rate_limits:{five_hour:{used_percentage:0}}},now).accountObserved,true);
});

test('account observation recognizes explicit history and legacy valid percentage caches only', () => {
  assert.equal(typeof quotaModule.hasAccountObservation,'function');
  for(const quota of [{accountObserved:true,windows:[]},{windows:[{remainingPercent:0}]},{windows:[{remainingPercent:100}]}])
    assert.equal(quotaModule.hasAccountObservation(quota),true);
  for(const quota of [null,{windows:[]},{error:'failed'},{windows:[{remainingPercent:null}]},{windows:[{remainingPercent:101}]}])
    assert.equal(quotaModule.hasAccountObservation(quota),false);
});
