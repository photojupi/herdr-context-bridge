import {t,getLocale,localizeMessage} from './i18n.mjs';
import { withCodex } from './codex.mjs';

function percent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function seconds(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * 1000 : null;
}

function result(provider, windows, now, locale) {
  const quota = { provider, observedAt: now, windows };
  if (!windows.length) quota.error = t('사용량 정보가 아직 없습니다.',{},locale);
  else if (windows.some(window => window.remainingPercent === null)) quota.error = t('일부 한도의 사용량을 확인할 수 없습니다.',{},locale);
  else if (windows.some(window => window.resetsAt !== null && window.resetsAt <= now)) quota.error = t('리셋 후 사용량 갱신을 기다립니다.',{},locale);
  return quota;
}

export function normalizeCodexQuota(payload, now = Date.now(), locale = getLocale()) {
  const windows = [];
  const multiple = payload?.rateLimitsByLimitId;
  const buckets = multiple && typeof multiple === 'object' && Object.keys(multiple).length
    ? Object.entries(multiple)
    : payload?.rateLimits ? [[payload.rateLimits.limitId ?? 'codex', payload.rateLimits]] : [];
  for (const [id, bucket] of buckets) {
    if (!bucket || typeof bucket !== 'object') continue;
    for (const key of ['primary', 'secondary', 'individualLimit']) {
      const window = bucket[key];
      if (!window || typeof window !== 'object') continue;
      const usedPercent = key === 'individualLimit'
        ? (percent(window.remainingPercent) === null ? null : 100 - window.remainingPercent)
        : percent(window.usedPercent);
      const minutes = window.windowDurationMins;
      const title = bucket.limitName || (id === 'codex' ? '' : id);
      const labelParams = {title,minutes:Number.isFinite(minutes)&&minutes>0?minutes:null,period:key};
      windows.push({
        id: `${id}:${key}`, label: codexLabel(labelParams,locale), labelKey:'codex-limit', labelParams,
        usedPercent, remainingPercent: usedPercent === null ? null : 100 - usedPercent,
        resetsAt: seconds(window.resetsAt),
      });
    }
  }
  const quota = result('codex', windows, now, locale);
  if (typeof payload?.ordinaryUsageAllowed === 'boolean') quota.ordinaryUsageAllowed = payload.ordinaryUsageAllowed;
  if (payload?.ordinaryUsageAllowed === false) quota.error = t('Codex에서 현재 사용을 허용하지 않습니다.',{},locale);
  if (typeof payload?.accountId === 'string' && payload.accountId.length <= 256) quota.accountId = payload.accountId;
  return quota;
}

export function normalizeClaudeQuota(payload, now = Date.now(), locale = getLocale()) {
  const windows = [];
  const labels = { five_hour:'5시간', seven_day:'7일', spend_limit:'지출 한도' };
  for (const [id, window] of Object.entries(payload?.rate_limits ?? {})) {
    if (!window || typeof window !== 'object') continue;
    const usedPercent = percent(window.used_percentage);
    windows.push({ id, label: labels[id] ? t(labels[id],{},locale) : id, ...(labels[id]?{labelKey:labels[id]}:{}), usedPercent,
      remainingPercent: usedPercent === null ? null : 100 - usedPercent, resetsAt: seconds(window.resets_at) });
  }
  return result('claude', windows, now, locale);
}

function codexLabel({title,minutes,period},locale) {
  const duration=minutes ? t(minutes%1440===0?'{count}일':minutes%60===0?'{count}시간':'{count}분',{count:minutes%1440===0?minutes/1440:minutes%60===0?minutes/60:minutes},locale) : t({primary:'기본',secondary:'추가',individualLimit:'개인'}[period],{},locale);
  return `${title ? title+' · ' : ''}${t('{period} 한도',{period:duration},locale)}`;
}
export function localizeQuota(quota,locale=getLocale()) {
  if(!quota)return quota;
  return {...quota,...(quota.error?{error:localizeMessage(quota.error,locale)}:{}),windows:(quota.windows||[]).map(window=>{
    if(window.labelKey==='codex-limit'&&window.labelParams)return {...window,label:codexLabel(window.labelParams,locale)};
    if(window.labelKey)return {...window,label:t(window.labelKey,{},locale)};
    // Older caches stored only Korean display labels. Keep provider-supplied titles intact.
    if(quota.provider==='claude'&&['five_hour','seven_day','spend_limit'].includes(window.id))return {...window,label:t({five_hour:'5시간',seven_day:'7일',spend_limit:'지출 한도'}[window.id],{},locale)};
    const legacy=quota.provider==='codex'&&/^(?:(.*) · )?((\d+(?:\.\d+)?)(일|시간|분)|기본|추가|개인) 한도$/.exec(window.label||'');
    if(legacy)return {...window,label:codexLabel({title:legacy[1]||'',minutes:legacy[3]?Number(legacy[3])*({일:1440,시간:60,분:1}[legacy[4]]):null,period:window.id.split(':').at(-1)},locale)};
    return window;
  })};
}

export async function readCodexQuota(options = {}) {
  try {
    const timeoutMs = Math.min(Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15000, 18000);
    const payload = await withCodex(client => client.request('account/rateLimits/read'), { ...options, timeoutMs });
    return normalizeCodexQuota(payload);
  } catch {
    return { provider: 'codex', observedAt: Date.now(), windows: [], error: t('Codex 사용량을 읽지 못했습니다. CLI 로그인을 확인해 주세요.') };
  }
}
