import {t} from './i18n.mjs';
export const FRESH_MS=600000;
export function validateConfig(input={}) {
  const mode=input.mode ?? 'ask', threshold=input.threshold ?? 10, autoSessions=input.autoSessions ?? [];
  if(!['ask','auto'].includes(mode)) throw new Error(t('인계 모드는 ask 또는 auto여야 합니다.'));
  if(!Number.isInteger(threshold)||threshold<1||threshold>50) throw new Error(t('알림 기준은 1~50% 정수여야 합니다.'));
  if(!Array.isArray(autoSessions)||autoSessions.some(k=>typeof k!=='string'||!/^(claude|codex):[a-zA-Z0-9_-]{1,160}$/.test(k))) throw new Error(t('자동 인계 세션이 올바르지 않습니다.'));
  return {mode,threshold,autoSessions:[...new Set(autoSessions)]};
}
export function quotaHealth(quota,now=Date.now()) {
  if(!quota || quota.error || !Number.isFinite(quota.observedAt) || quota.observedAt>now+60000 || now-quota.observedAt>FRESH_MS) return {usable:false,reason:t('사용량을 새로 확인해야 합니다.')};
  const windows=quota.windows;
  if(!Array.isArray(windows)||!windows.length) return {usable:false,reason:t('아직 사용량이 수집되지 않았습니다.')};
  if(windows.some(w=>!Number.isFinite(w.remainingPercent)||w.remainingPercent<0||w.remainingPercent>100||!Number.isFinite(w.resetsAt)||w.resetsAt<=now)) return {usable:false,reason:t('사용량 창이 만료되었거나 값이 없습니다.')};
  return {usable:true,remaining:Math.min(...windows.map(w=>w.remainingPercent))};
}
export function decideHandoff({config,source,sourceQuota,targetQuota,status,installed,already=false,now=Date.now()}) {
  const health=quotaHealth(sourceQuota,now);
  if(!health.usable) return {action:'none',reason:health.reason};
  if(health.remaining>config.threshold) return {action:'none',reason:t('잔여량이 충분합니다.')};
  const ask=reason=>({action:'ask',reason});
  if(already) return {action:'none',reason:t('이미 인계한 세션입니다.')};
  if(config.mode!=='auto'||!config.autoSessions.includes(`${source.provider}:${source.id}`)) return ask(t('인계하려면 승인해 주세요.'));
  if(!source.trustedBinding||!source.terminalId) return ask(t('원본 세션을 먼저 연결해 주세요.'));
  if(source.autoOrigin) return ask(t('자동 인계로 생성된 세션은 다시 자동 전환하지 않습니다.'));
  if(!['idle','done'].includes(status) && !(status==='blocked'&&source.error==='rate_limit')) return ask(t('원본 작업이 끝날 때까지 기다립니다.'));
  if(!installed) return ask(t('대상 CLI가 설치되어 있지 않습니다.'));
  const target=quotaHealth(targetQuota,now);
  if(!target.usable||target.remaining<=config.threshold) return ask(t('대상의 잔여량을 확인한 후 수동으로 인계해 주세요.'));
  return {action:'auto',reason:t('등록한 자동 인계 조건을 만족합니다.')};
}
