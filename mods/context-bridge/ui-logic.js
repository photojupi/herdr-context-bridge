export function quotaState(quota, now) {
  if (quota?.error) return 'error';
  if (!Number.isFinite(quota?.observedAt) || quota.observedAt > now + 60_000 || !quota?.windows?.length) return 'unknown';
  return now - quota.observedAt >= 600_000 ? 'stale' : 'fresh';
}

export function quotaSummary(quotas, threshold, now) {
  return ['claude', 'codex'].flatMap((provider) => ['fiveHour', 'weekly'].map((period) => {
    const quota = quotas?.[provider];
    const state = quotaState(quota, now);
    const candidates = (quota?.windows ?? []).filter((window) => provider === 'claude'
      ? window.id === (period === 'fiveHour' ? 'five_hour' : 'seven_day')
      : window.id?.split(':')[0] === 'codex' && window.labelParams?.minutes === (period === 'fiveHour' ? 300 : 10080));
    const window = candidates.length === 1 ? candidates[0] : null;
    const expired = Number.isFinite(window?.resetsAt) && window.resetsAt <= now;
    const known = ['fresh', 'stale'].includes(state) && Number.isFinite(window?.remainingPercent)
      && window.remainingPercent >= 0 && window.remainingPercent <= 100
      && Number.isFinite(window.resetsAt) && !expired;
    const remaining = known ? window.remainingPercent : null;
    return { provider, period, remaining, state: expired ? 'expired' : known ? state : 'unknown', warning: known && state === 'fresh' && remaining <= threshold };
  }));
}

export function lowQuotaAlerts(quota, threshold, now, seen) {
  if (quotaState(quota, now) !== 'fresh') return [];
  return quota.windows.flatMap((window) => {
    const key = `${quota.provider}:${window.id}`;
    const cycle = String(window.resetsAt);
    if (!Number.isFinite(window.remainingPercent) || window.remainingPercent < 0 || window.remainingPercent > 100 || window.remainingPercent > threshold
      || !Number.isFinite(window.resetsAt) || window.resetsAt <= now || seen[key] === cycle) return [];
    return [{ key, cycle, provider: quota.provider, window }];
  });
}

export function localSources(panes, spaces, agents) {
  const localTabs = new Map(spaces.filter((s) => !s.machine).flatMap((s) => s.tabs.map((tab) => [tab.id, s.id])));
  return panes.flatMap((pane) => {
    if (!pane.terminal || !pane.cwd || !localTabs.has(pane.tab)) return [];
    const agent = agents.find((a) => a.address === pane.terminal);
    const app = agent?.app ?? pane.app ?? pane.program?.key ?? '';
    const provider = /claude/.test(app) ? 'claude' : /codex/.test(app) ? 'codex' : null;
    return provider ? [{ terminalId: pane.terminal, provider, cwd: pane.cwd, title: pane.title, space: localTabs.get(pane.tab), status: agent?.status ?? pane.status }] : [];
  });
}
export function sourceKey(session) { return `${session.provider}:${session.id}`; }
