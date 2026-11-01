import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const cli=new URL('../src/cli.mjs',import.meta.url).pathname;
test('locale command returns only device locale without creating state',async t=>{
  const home=await mkdtemp(join(tmpdir(),'bridge-locale-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const result=JSON.parse(execFileSync(process.execPath,[cli,'locale'],{env:{...process.env,HOME:home,HERDR_BRIDGE_STATE_DIR:join(home,'state')}}));
  assert.deepEqual(Object.keys(result),['locale']);
  assert.ok(['en','ko','ja','zh-CN'].includes(result.locale));
  assert.deepEqual(await readdir(home),[]);
});
test('normalization distinguishes simplified Chinese from traditional and unsupported locales',async()=>{
  const {normalizeLocale}=await import('../src/i18n.mjs');
  for(const [input,expected] of Object.entries({'ko_KR.UTF-8':'ko','ja-JP':'ja','en-GB':'en','zh':'zh-CN','zh-Hans':'zh-CN','zh-CN':'zh-CN','zh-SG':'zh-CN','zh-Hans-SG':'zh-CN','zh-Hant':'en','zh-TW':'en','zh-HK':'en','zh-MO':'en','zh-Hant-CN':'en','fr-FR':'en','C':'en'}))assert.equal(normalizeLocale(input),expected,input);
});
test('first macOS language beats shell, unsupported first language stays English',async()=>{
  const {detectLocale}=await import('../src/i18n.mjs');
  assert.equal(detectLocale({platform:'darwin',env:{LANG:'en_US.UTF-8'},readAppleLanguages:()=>'(\n "ja-JP",\n "ko-KR"\n)'}),'ja');
  assert.equal(detectLocale({platform:'darwin',env:{LANG:'ko_KR.UTF-8'},readAppleLanguages:()=>'(\n "fr-FR",\n "ko-KR"\n)'}),'en');
});
test('failed device detection falls back through shell precedence and Intl',async()=>{
  const {detectLocale}=await import('../src/i18n.mjs');
  const base={platform:'darwin',readAppleLanguages:()=>{throw new Error('unavailable');},intlLocale:'ja-JP'};
  assert.equal(detectLocale({...base,env:{LC_ALL:'ko_KR',LC_MESSAGES:'ja_JP',LANG:'en_US'}}),'ko');
  assert.equal(detectLocale({...base,env:{LC_MESSAGES:'zh_SG',LANG:'en_US'}}),'zh-CN');
  assert.equal(detectLocale({...base,env:{LANG:'fr_FR'}}),'en');
  assert.equal(detectLocale({...base,env:{}}),'ja');
  assert.equal(detectLocale({...base,readAppleLanguages:()=>'( )',env:{LANG:'ko_KR'}}),'ko');
});
test('helper catalogs translate product text with matching placeholders and preserve external details',async()=>{
  const {messages,t,localizeMessage}=await import('../src/i18n.mjs');
  assert.equal(t('잘못된 식별자입니다.',{},'en'),'Invalid identifier.');
  assert.equal(t('잘못된 식별자입니다.',{},'ja'),'識別子が正しくありません。');
  assert.equal(t('잘못된 식별자입니다.',{},'zh-CN'),'标识符无效。');
  assert.equal(localizeMessage('잘못된 식별자입니다.','en'),'Invalid identifier.');
  assert.equal(localizeMessage('provider failed: user original text','ja'),'provider failed: user original text');
  assert.ok(Object.keys(messages).length>50);
  for(const [key,variants] of Object.entries(messages)) {
    const placeholders=value=>(value.match(/\{\w+\}/g)||[]).sort();
    for(const locale of ['en','ko','ja','zh-CN']) {
      assert.equal(typeof variants[locale],'string',`${key}: ${locale}`);
      assert.deepEqual(placeholders(variants[locale]),placeholders(variants.en),`${key}: ${locale}`);
    }
  }
});
test('quota labels and cached product errors follow the requested display language',async()=>{
  const {normalizeCodexQuota,normalizeClaudeQuota,localizeQuota}=await import('../src/quota.mjs');
  const now=Date.now();
  const original=normalizeCodexQuota({rateLimits:{limitName:'Provider Name',primary:{usedPercent:4,windowDurationMins:300,resetsAt:now/1000+600}}},now,'ko');
  assert.equal(original.windows[0].label,'Provider Name · 5시간 한도');
  assert.equal(localizeQuota(original,'en').windows[0].label,'Provider Name · 5 hours limit');
  assert.equal(localizeQuota(original,'ja').windows[0].label,'Provider Name · 5時間の上限');
  assert.equal(localizeQuota(original,'zh-CN').windows[0].label,'Provider Name · 5小时限额');
  const empty=normalizeClaudeQuota({},now,'ko');
  assert.equal(localizeQuota(empty,'en').error,'Usage information is not available yet.');
  assert.equal(localizeQuota({...empty,error:'external error text'},'ja').error,'external error text');
});
test('cached dynamic handoff reasons and legacy quota labels can be translated without changing user titles',async()=>{
  const {t,localizeMessage}=await import('../src/i18n.mjs');
  const {localizeQuota}=await import('../src/quota.mjs');
  const cached=t('자동 인계 불가: {reason}',{reason:t('원본 세션을 먼저 연결해 주세요.',{},'ko')},'ko');
  assert.equal(localizeMessage(cached,'en'),'Automatic handoff unavailable: Connect the source session first.');
  const q=localizeQuota({provider:'codex',windows:[{id:'reviews:primary',label:'검토 Reviews · 5시간 한도'}]},'en');
  assert.equal(q.windows[0].label,'검토 Reviews · 5 hours limit');
});
test('unknown text does not substitute user placeholders',async()=>{
  const {t}=await import('../src/i18n.mjs');
  assert.equal(t('user {name}',{name:'changed'},'ja'),'user {name}');
});
test('macOS preferences are lazy, bounded, read-only and cached per helper process',()=>{
  const module=new URL('../src/i18n.mjs',import.meta.url).href;
  const code=`import childProcess from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import assert from 'node:assert/strict';let calls=0;childProcess.execFileSync=(binary,args,options)=>{calls++;assert.equal(binary,'/usr/bin/defaults');assert.deepEqual(args,['read','-g','AppleLanguages']);assert.ok(options.timeout>0);return '("ja-JP", "ko-KR")';};syncBuiltinESMExports();const {getLocale}=await import(${JSON.stringify(module)});assert.equal(calls,0);getLocale();getLocale();assert.equal(calls,process.platform==='darwin'?1:0);`;
  execFileSync(process.execPath,['--input-type=module','-e',code]);
});
test('cached product errors with record paths preserve the path while changing language',async()=>{
  const {t,localizeMessage}=await import('../src/i18n.mjs');
  const original=t('{path}:{line} JSON 기록이 손상되었습니다',{path:'/user/original name.jsonl',line:3},'ko');
  assert.equal(localizeMessage(original,'en'),'/user/original name.jsonl:3 JSON record is corrupted');
});
test('large-record reading instructions are localized',async()=>{
  const {t}=await import('../src/i18n.mjs');
  assert.equal(t('large record: read all byte chunks',{},'ko'),'큰 record: 모든 byte 조각을 읽으십시오');
  assert.equal(t('large record: read all byte chunks',{},'ja'),'大きい record: すべての byte チャンクを読んでください');
  assert.equal(t('large record: read all byte chunks',{},'zh-CN'),'大记录：请阅读所有 byte 分块');
});
