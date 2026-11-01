import test from 'node:test';
import assert from 'node:assert/strict';
import { decideHandoff, quotaHealth, validateConfig } from '../src/policy.mjs';
import * as policy from '../src/policy.mjs';

const now = 1_800_000_000_000;
const quota = (remainingPercent = 5, extra = {}) => ({observedAt:now, windows:[{id:'primary',remainingPercent,resetsAt:now+3600000}],...extra});
const base = {config:{mode:'ask',threshold:10,autoSessions:[]},source:{provider:'claude',id:'abc',trustedBinding:true,terminalId:'t1'},sourceQuota:quota(),targetQuota:quota(80),status:'idle',installed:true,now};
test('approval mode never launches automatically, even at zero quota', () => {
  assert.equal(decideHandoff({...base,sourceQuota:quota(0)}).action,'ask');
});
test('automatic mode requires explicit arming and fresh target quota', () => {
  const automatic={...base,config:{...base.config,mode:'auto',autoSessions:['claude:abc']}};
  assert.equal(decideHandoff(automatic).action,'auto');
  for (const patch of [
    {config:{...automatic.config,autoSessions:[]}},
    {source:{...base.source,trustedBinding:false}},
    {source:{...base.source,autoOrigin:true}},
    {status:'working'}, {status:'blocked'}, {installed:false}, {already:true},
    {targetQuota:quota(80,{observedAt:now-600001})},
    {targetQuota:{observedAt:now,windows:[]}},
    {targetQuota:quota(10)}, {sourceQuota:quota(5,{error:'failed'})}
  ]) assert.notEqual(decideHandoff({...automatic,...patch}).action,'auto',JSON.stringify(patch));
});
test('unknown, expired, stale and out-of-range data cannot trigger handoff', () => {
  for (const q of [quota(null),quota(-1),quota(101),quota(5,{observedAt:now-600001}),quota(5,{windows:[{remainingPercent:0,resetsAt:now-1}]}),{windows:[]}]) {
    assert.equal(quotaHealth(q,now).usable,false);
    assert.equal(decideHandoff({...base,sourceQuota:q}).action,'none');
  }
  assert.equal(decideHandoff({...base,sourceQuota:quota(11)}).action,'none');
});
test('minimum remaining window governs, reset timestamps are not converted into full quota', () => {
  assert.equal(quotaHealth({...quota(80),windows:[{remainingPercent:80,resetsAt:now+1000},{remainingPercent:2,resetsAt:now+5000}]},now).remaining,2);
});
test('invalid config cannot silently arm automatic sessions', () => {
  assert.deepEqual(validateConfig({}),{mode:'ask',threshold:10,autoSessions:[]});
  assert.throws(()=>validateConfig({mode:'yes'}));
  assert.throws(()=>validateConfig({threshold:NaN}));
  assert.throws(()=>validateConfig({threshold:100}));
  assert.throws(()=>validateConfig({autoSessions:['../../x']}));
});
test('automatic targets preserve legacy routes and require a selected destination for AGY', () => {
  assert.equal(typeof policy.autoTarget,'function');
  assert.equal(policy.autoTarget({}, {provider:'claude',id:'abc'}),'codex');
  assert.equal(policy.autoTarget({}, {provider:'codex',id:'abc'}),'claude');
  assert.equal(policy.autoTarget({}, {provider:'agy',id:'abc'}),null);
  const config=validateConfig({mode:'auto',autoSessions:['agy:abc'],autoTargets:{'agy:abc':'codex'}});
  assert.deepEqual(config.autoTargets,{'agy:abc':'codex'});
  assert.equal(policy.autoTarget(config,{provider:'agy',id:'abc'}),'codex');
  const automatic={...base,source:{...base.source,provider:'agy'},config};
  assert.equal(decideHandoff({...automatic,target:'codex'}).action,'auto');
  assert.equal(decideHandoff({...automatic,target:'claude'}).action,'ask');
  assert.equal(decideHandoff({...automatic,config:{...config,autoTargets:{}}}).action,'ask');
  assert.equal(decideHandoff({...automatic,config:{...config,autoSessions:[]}}).action,'ask');
});
test('automatic target validation rejects invalid providers, source keys and self destinations', () => {
  for(const autoTargets of [null,[],true,{'agy:abc':'agy'},{'claude:abc':'other'},{'other:abc':'agy'},{'agy:../abc':'claude'}]) {
    assert.throws(()=>validateConfig({autoTargets}),JSON.stringify(autoTargets));
  }
  assert.deepEqual(validateConfig({autoTargets:{'claude:abc':'agy'}}).autoTargets,{'claude:abc':'agy'});
});
