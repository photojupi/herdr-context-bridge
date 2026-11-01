import { View, div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { agents, panes, spaces, exec, appHome, props, theme, shared, setShared, notify, openOverlay, closeOverlay, nextCommand } from 'herdr';
import { quotaState, quotaSummary, lowQuotaAlerts, localSources, sourceKey } from './ui-logic.js';
import { uiLocale, translate, formatStamp } from './i18n.js';

const names = { claude: 'Claude Code', codex: 'Codex', agy: 'AGY (Antigravity)' };
const message = (error) => String(error?.message ?? error);

export default class ContextBridge extends View {
  init(_props, cx) {
    this.role = props()?.role ?? (props()?.overlay ? 'details' : 'summary');
    if (this.role === 'summary' && props()?.node && props()?.helper) {
      setShared('context-bridge.runtime', { node: props().node, helper: props().helper });
    }
    this.locale = uiLocale(props()?.locale);
    this.localeReady = props()?.locale != null;
    this.data = null;
    this.error = null;
    this.busy = false;
    this.loading = false;
    this.sessions = null;
    this.terminal = null;
    this.selected = props()?.sourceKey ?? shared('context-bridge.source') ?? null;
    this.jobs = [];
    this.handle = cx.focus_handle();
    if (this.role !== 'summary') this.handle.focus();
    cx.timer.every(60_000, (cx) => this.refresh(cx));
    cx.timer.every(2000, (cx) => this.pollJobs(cx));
    if (this.role === 'summary') cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === 'review') this.openReview();
        if (command === 'details') this.openDetails();
        cx.notify();
      }
    });
    this.refresh(cx);
  }

  tr(key, values) {
    return translate(this.locale, key, values);
  }

  stamp(time) {
    return formatStamp(this.locale, time);
  }

  runtime() {
    const p = props() ?? {};
    const installed = shared('context-bridge.runtime') ?? {};
    return { node: p.node ?? installed.node ?? 'node', helper: p.helper ?? installed.helper ?? `${appHome()}/mods/context-bridge/helper/cli.mjs` };
  }

  async call(command, ...args) {
    const p = this.runtime();
    const result = await exec(p.node, [p.helper, command, ...args]);
    let value;
    try { value = JSON.parse(result.stdout); }
    catch { throw new Error(result.stderr.trim() || this.tr('helperResponse')); }
    if (value.error || result.code !== 0) throw new Error(typeof value.error === 'string' ? value.error : value.error?.message ?? (result.stderr.trim() || this.tr('helperFailed')));
    return value;
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      if (!this.localeReady) {
        try { this.locale = uiLocale((await this.call('locale')).locale); }
        catch { this.locale = 'en'; }
        this.localeReady = true;
        cx.notify();
      }
      try {
        this.data = await this.call('status');
        this.jobs = this.data.jobs ?? [];
        this.error = null;
        if (this.role === 'summary') this.alertLowQuota();
      } catch (error) { this.error = message(error); }
      this.loading = false;
      cx.notify();
    });
  }

  openReview(provider) {
    if (!this.localeReady) return;
    const p = this.runtime();
    openOverlay({ mod: 'context-bridge', kind: 'dialog', width: 540, height: 600, props: { role: 'review', provider, sourceKey: this.selected, helper: p.helper, node: p.node, locale: this.locale } });
  }

  openDetails() {
    if (!this.localeReady) return;
    const p = this.runtime();
    openOverlay({ mod: 'context-bridge', kind: 'dialog', width: 540, height: 600, props: { role: 'details', sourceKey: this.selected, helper: p.helper, node: p.node, locale: this.locale } });
  }

  alertLowQuota() {
    const seen = shared('context-bridge.alerts') ?? {};
    const alerts = Object.values(this.data.quotas ?? {}).flatMap((quota) => lowQuotaAlerts(quota, this.data.config?.threshold ?? 10, Date.now(), seen));
    if (!alerts.length) return;
    const alert = alerts[0];
    seen[alert.key] = alert.cycle;
    setShared('context-bridge.alerts', seen);
    if (alert.provider === 'agy') {
      notify({ title: this.tr('lowQuotaTitle', { provider: names.agy }), body: this.tr('lowUsageBody', { window: alert.window.label ?? alert.window.id, remaining: alert.window.remainingPercent }), level: 'warning' });
      return;
    }
    const automatic = this.data.bindings?.some((source) => source.provider === alert.provider && source.decision?.action === 'auto');
    notify({ title: this.tr('lowQuotaTitle', { provider: names[alert.provider] }), body: this.tr('lowQuotaBody', { window: alert.window.label ?? alert.window.id, remaining: alert.window.remainingPercent, action: this.tr(automatic ? 'autoStarted' : 'reviewPrompt') }), level: 'warning', action: { name: 'context-bridge.review' } });
    if (!automatic) this.openReview(alert.provider);
  }

  act(cx, body) {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    cx.spawn(async (cx) => {
      try { await body(); }
      catch (error) { this.error = message(error); }
      this.busy = false;
      cx.notify();
    });
    cx.notify();
  }

  configure(update, cx) {
    this.act(cx, async () => {
      this.data.config = await this.call('config', JSON.stringify({ ...this.data.config, ...update }));
    });
  }

  pickTerminal(terminal, cx) {
    this.terminal = terminal;
    this.sessions = null;
    this.selected = null;
    this.act(cx, async () => {
      this.sessions = (await this.call('sessions', terminal.provider, terminal.cwd)).sessions;
    });
  }

  bindSession(session, cx) {
    const terminal = this.terminal;
    this.act(cx, async () => {
      const result = await this.call('bind', JSON.stringify({ terminalId: terminal.terminalId, provider: session.provider, id: session.id, cwd: terminal.cwd }));
      const binding = result.binding ?? result;
      this.data.bindings = [...(this.data.bindings ?? []).filter((item) => sourceKey(item) !== sourceKey(binding)), binding];
      this.selected = sourceKey(binding);
      setShared('context-bridge.binding', binding);
      setShared('context-bridge.source', this.selected);
    });
  }

  selectedSession() {
    const current = this.data?.bindings?.find((session) => sourceKey(session) === this.selected);
    const selected = shared('context-bridge.binding');
    return current ?? (selected && sourceKey(selected) === this.selected ? selected : null);
  }

  handoff(cx) {
    const session = this.selectedSession();
    const terminal = localSources(panes(), spaces(), agents()).find((item) => item.terminalId === session?.terminalId);
    if (!session || !terminal) { this.error = this.tr('bindFirst'); cx.notify(); return; }
    const target = session.provider === 'claude' ? 'codex' : 'claude';
    this.act(cx, async () => {
      const result = await this.call('handoff', JSON.stringify({ sourceKey: sourceKey(session), target, automatic: false, space: terminal.space }));
      this.jobs = [{ id: result.jobId, status: 'preparing', target, sourceKey: sourceKey(session) }, ...this.jobs];
    });
  }

  pollJobs(cx) {
    const pending = this.jobs.filter((job) => job.status === 'preparing');
    if (!pending.length || this.polling) return;
    this.polling = true;
    cx.spawn(async (cx) => {
      try {
        for (const job of pending) {
          const update = await this.call('job', job.id);
          this.jobs = this.jobs.map((item) => item.id === job.id ? update : item);
        }
      } catch (error) { this.error = message(error); }
      this.polling = false;
      cx.notify();
    });
  }

  button(id, label, action, t, enabled = true, primary = false) {
    return h_flex().id(id).min_h(30).px(10).py(5).items_center().justify_center().rounded(7).border_1()
      .border_color(primary ? t.accent : t.border).bg(primary ? t.accent : t.raised)
      .text_color(primary ? t.accent_foreground : t.foreground).text_size(12)
      .when(!enabled || this.busy, (el) => el.opacity(0.45))
      .when(enabled && !this.busy, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)).on_click(action))
      .child(div().min_w(0).truncate().child(label));
  }

  text(text, t, color = t.muted) {
    return div().text_size(11).text_color(color).child(text);
  }

  quotaCard(provider, t) {
    const quota = this.data?.quotas?.[provider];
    const state = quotaState(quota, Date.now());
    const card = v_flex().p(12).gap(7).rounded(9).border_1().border_color(t.border).bg(t.raised)
      .child(h_flex().items_center().child(div().flex_1().font_semibold().child(names[provider]))
        .child(this.text(this.tr(state === 'fresh' ? 'fresh' : state === 'stale' ? 'stale' : 'unavailable'), t, state === 'fresh' ? t.ansi2 : t.ansi3)));
    for (const window of quota?.windows ?? []) {
      const known = !window.disabled && Number.isFinite(window.remainingPercent) && window.remainingPercent >= 0 && window.remainingPercent <= 100;
      const expired = Number.isFinite(window.resetsAt) && window.resetsAt <= Date.now();
      const remaining = known && !expired ? Math.max(0, Math.min(100, window.remainingPercent)) : null;
      card.child(v_flex().gap(4)
        .child(h_flex().gap(8).child(div().flex_1().text_size(12).child(window.label ?? window.id))
          .child(div().font_semibold().text_color(remaining !== null && remaining <= (this.data?.config?.threshold ?? 10) ? t.ansi3 : t.foreground).child(this.tr(remaining === null ? 'unavailable' : 'remaining', { remaining }))))
        .child(div().h(4).w_full().rounded(2).bg(t.input).when(remaining !== null, (bar) => bar.child(div().h_full().w(`${remaining}%`).rounded(2).bg(state === 'fresh' ? t.accent : t.dim))))
        .child(this.text(expired ? this.tr('resetPending') : this.tr('resetAt', { time: this.stamp(window.resetsAt) }), t)));
    }
    if (!quota?.windows?.length) card.child(this.text(this.tr('noUsage'), t));
    if (quota?.error) card.child(this.text(message(quota.error), t, t.ansi1));
    if (state === 'stale') card.child(this.text(this.tr(provider === 'agy' ? 'staleUsageHint' : 'staleHint'), t, t.ansi3));
    card.child(this.text(this.tr('updatedAt', { time: this.stamp(quota?.observedAt) }), t));
    if (provider === 'claude') card.child(this.text(this.tr('claudeStatusHint'), t));
    return card;
  }

  settingsCard(t) {
    const config = this.data.config;
    const session = this.selectedSession();
    const armed = config.autoSessions ?? [];
    const card = v_flex().gap(8).child(div().font_semibold().child(this.tr('settings')))
      .child(h_flex().items_center().gap(6).child(div().flex_1().text_size(12).child(this.tr('threshold', { threshold: config.threshold })))
        .child(this.button('threshold-down', '−', (_e, cx) => this.configure({ threshold: Math.max(1, config.threshold - 5) }, cx), t, config.threshold > 1))
        .child(this.button('threshold-up', '+', (_e, cx) => this.configure({ threshold: Math.min(50, config.threshold + 5) }, cx), t, config.threshold < 50)))
      .child(v_flex().gap(6)
        .child(this.button('mode-ask', `${config.mode === 'ask' ? '✓ ' : ''}${this.tr('modeAsk')}`, (_e, cx) => this.configure({ mode: 'ask', autoSessions: [] }, cx), t))
        .child(this.button('mode-auto', this.tr('modeAuto'), (_e, cx) => this.configure({ mode: 'auto', autoSessions: [...new Set([...armed, sourceKey(session)])] }, cx), t, Boolean(session) && !session.autoOrigin)))
      .child(this.text(this.tr('autoHint'), t));
    if (config.mode === 'auto') for (const key of armed) {
      card.child(h_flex().items_center().gap(6)
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.ansi3).child(this.tr('autoArmed', { key })))
        .child(this.button(`disarm-${key}`, this.tr('disarm'), (_e, cx) => this.configure({ autoSessions: armed.filter((item) => item !== key), mode: armed.length === 1 ? 'ask' : 'auto' }, cx), t)));
      const binding = this.data.bindings?.find((item) => sourceKey(item) === key);
      if (binding?.decision?.reason) card.child(this.text(binding.decision.reason, t));
    }
    return card;
  }

  sessionPicker(t) {
    const available = localSources(panes(), spaces(), agents()).filter((item) => !props()?.provider || item.provider === props().provider);
    const card = v_flex().gap(7).child(div().font_semibold().child(this.tr('sourcePicker')));
    if (!available.length) card.child(this.text(this.tr('openTerminal'), t));
    for (const terminal of available) card.child(this.button(`terminal-${terminal.terminalId}`, `${names[terminal.provider]} · ${terminal.title || terminal.terminalId} · ${terminal.cwd}`, (_e, cx) => this.pickTerminal(terminal, cx), t));
    if (this.terminal && this.sessions === null) card.child(this.text(this.tr('findingSessions'), t));
    if (this.sessions?.length === 0) card.child(this.text(this.tr('noSessions'), t));
    for (const session of this.sessions ?? []) card.child(this.button(`session-${session.id}`, `${session.title ?? session.id} · ${this.stamp(session.updatedAt)}`, (_e, cx) => this.bindSession(session, cx), t));
    for (const session of this.data.bindings ?? []) {
      if (props()?.provider && session.provider !== props().provider) continue;
      card.child(this.button(`bound-${sourceKey(session)}`, `${this.selected === sourceKey(session) ? '✓ ' : ''}${names[session.provider]} · ${session.title ?? session.id}`, (_e, cx) => { this.selected = sourceKey(session); setShared('context-bridge.binding', session); setShared('context-bridge.source', this.selected); cx.notify(); }, t));
    }
    return card;
  }

  jobCards(t) {
    return this.jobs.slice(0, 4).map((job) => v_flex().p(9).gap(4).rounded(7).bg(t.raised)
      .child(div().text_size(12).font_semibold().text_color(job.status === 'failed' ? t.ansi1 : t.foreground).child(this.tr(job.status === 'preparing' ? 'jobPreparing' : job.status === 'launched' ? 'jobLaunched' : 'jobFailed')))
      .child(this.text(job.error ? message(job.error) : this.tr(job.status === 'launched' ? 'jobConfirm' : 'jobPreserving'), t))
      .when(Boolean(job.directory), (el) => el.child(this.text(job.directory, t))));
  }

  summary(t) {
    const entries = quotaSummary(this.data?.quotas, this.data?.config?.threshold ?? 10, Date.now());
    const period = (entry) => this.tr(entry.period);
    const label = (entry) => `${period(entry) ? `${period(entry)} ` : ''}${entry.remaining === null ? '—' : `${entry.remaining}%`}${entry.warning ? ' !' : entry.state === 'stale' ? ' ~' : ''}`;
    const hint = (entry) => `${names[entry.provider]}${entry.provider === 'agy' ? ` · ${entry.label} (${entry.bucketId})` : ''} · ${period(entry)} · ${entry.remaining === null ? this.tr('unavailable') : this.tr('remaining', { remaining: entry.remaining })} · ${this.tr(entry.state === 'expired' ? 'resetPending' : entry.state === 'fresh' ? 'fresh' : entry.state === 'stale' ? entry.provider === 'agy' ? 'staleUsageHint' : 'staleHint' : 'unavailable')}${entry.provider === 'agy' ? ` · ${this.tr('resetAt', { time: this.stamp(entry.resetsAt) })}` : ''}${entry.warning ? ` · ${this.tr('threshold', { threshold: this.data?.config?.threshold ?? 10 })}` : ''}`;
    const tooltip = [this.tr('openDetails'), ...(entries.length ? entries.map(hint) : [this.tr('awaitingUsage')]), ...(this.error ? [this.error] : [])].join('\n');
    const root = h_flex().id('context-bridge-summary').size_full().min_w(0).items_center().gap(8).px(6)
      .bg(t.chrome).text_color(t.foreground).text_size(11).overflow_hidden().cursor_pointer()
      .tooltip(tooltip).accessibility_label(tooltip).on_click(() => this.openDetails());
    root.child(div().id('open-details').w(20).h_full().flex_shrink_0().items_center().justify_center().flex()
      .text_color(this.error ? t.ansi3 : t.muted).tooltip(this.tr('openDetails')).accessibility_label(this.tr('openDetails'))
      .on_click((_event, cx) => { cx?.stop_propagation(); this.openDetails(); }).child(this.error ? '!' : '≡'));
    const content = h_flex().min_w(0).items_center().gap(12).overflow_hidden();
    if (!entries.length) content.child(this.text(this.localeReady ? this.tr('awaitingUsage') : '…', t));
    for (const provider of [...new Set(entries.map((entry) => entry.provider))]) {
      const group = h_flex().items_center().gap(6).flex_shrink_0().child(div().font_semibold().child(provider === 'claude' ? 'Claude' : provider === 'agy' ? 'AGY' : 'Codex'));
      for (const entry of entries.filter((item) => item.provider === provider)) group.child(div().id(`summary-${provider}-${entry.period}`)
        .text_color(entry.warning || entry.state === 'stale' ? t.ansi3 : entry.remaining === null ? t.muted : t.foreground)
        .tooltip(hint(entry)).child(this.localeReady ? label(entry) : '…'));
      content.child(group);
    }
    return root.child(content);
  }

  render(cx) {
    const t = theme();
    const review = this.role === 'review';
    if (!review) this.selected = shared('context-bridge.source') ?? this.selected;
    if (this.role === 'summary') return this.summary(t);
    const session = this.selectedSession();
    const target = session?.provider === 'claude' ? 'codex' : 'claude';
    const root = v_flex().id('context-bridge').size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(12).track_focus(this.handle);
    root.on_key_down((event, cx) => { if (event.key === 'escape') { closeOverlay(props().overlay); cx.stop_propagation(); } });
    root.child(h_flex().px(14).py(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().flex_1().font_semibold().text_size(14).child(review ? this.tr('reviewTitle') : 'Context Bridge'))
      .child(this.button('refresh', this.localeReady ? this.tr(this.loading ? 'refreshing' : 'refresh') : '…', (_e, cx) => this.refresh(cx), t, !this.loading))
      .when(!review, (el) => el.child(this.button('close-details', this.tr('close'), () => closeOverlay(props().overlay), t))));
    const body = v_flex().id('context-bridge-scroll').flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(12);
    if (this.error) body.child(div().p(10).rounded(7).bg(t.raised).text_color(t.ansi1).child(this.error));
    if (!this.data) body.child(this.text(this.localeReady ? this.tr(this.loading ? 'loadingUsage' : 'usageFailed') : '…', t));
    else {
      if (this.data.terminalError) body.child(this.text(this.tr('terminalError', { error: this.data.terminalError }), t, t.ansi1));
      if (!review) {
        const providers = Object.keys(names).filter((provider) => this.data.quotas?.[provider]);
        for (const provider of providers) body.child(this.quotaCard(provider, t));
        if (!providers.length) body.child(this.text(this.tr('awaitingUsage'), t));
      }
      if (review) body.child(this.sessionPicker(t));
      else {
        body.child(this.button('choose-source', session ? this.tr('sourceSelected', { provider: names[session.provider], id: session.id.slice(0, 12) }) : this.tr('chooseSource'), () => this.openReview(), t));
        body.child(this.settingsCard(t));
      }
      if (review && session) body.child(v_flex().gap(7).p(12).rounded(8).bg(t.raised)
        .child(div().font_semibold().child(`${names[session.provider]} → ${names[target]}`))
        .child(this.text(this.tr('sourceSession', { id: session.id }), t)).child(this.text(this.tr('workingFolder', { cwd: session.cwd }), t))
        .child(this.text(this.tr('targetQuota', { state: this.tr(quotaState(this.data.quotas?.[target], Date.now()) === 'fresh' ? 'targetFresh' : 'targetCheck') }), t))
        .child(this.text(this.tr('recordsHint'), t))
        .child(this.text(this.tr('sourceHint'), t))
        .when(!this.data.installed?.[target], (el) => el.child(this.text(this.tr('cliMissing', { provider: names[target] }), t, t.ansi1))));
      body.children(this.jobCards(t));
      if (!review) body.child(this.text(this.tr('accountHint'), t));
    }
    root.child(body);
    if (review) root.child(h_flex().px(14).py(12).gap(8).justify_end().border_t(1).border_color(t.border)
      .child(this.button('later', this.tr('later'), () => closeOverlay(props().overlay), t))
      .child(this.button('handoff', this.tr(this.busy ? 'processing' : 'handoff'), (_e, cx) => this.handoff(cx), t, Boolean(session && this.data?.installed?.[target]) && !this.jobs.some((job) => job.sourceKey === this.selected && job.status === 'preparing'), true)));
    else root.child(div().p(12).child(this.button('review', this.localeReady ? this.tr('manualReview') : '…', () => this.openReview(), t, Boolean(this.data), true)));
    return root;
  }
}
