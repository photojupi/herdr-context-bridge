import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as i18n from '../mods/context-bridge/i18n.js';

test('UI catalogs cover all four locales and preserve interpolation placeholders', () => {
  assert.equal(typeof i18n.translate, 'function', 'UI translation catalog must be available');
  const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  assert.deepEqual(Object.keys(i18n.catalogs).sort(), ['en', 'ja', 'ko', 'zh-CN']);
  for (const catalog of Object.values(i18n.catalogs)) {
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(i18n.catalogs.en).sort());
    for (const [key, value] of Object.entries(catalog)) {
      assert.ok(value.length > 0, key);
      assert.deepEqual(placeholders(value), placeholders(i18n.catalogs.en[key]), key);
    }
  }
});

test('unsupported UI locales fall back to English without interpreting user text as placeholders', () => {
  assert.equal(typeof i18n.translate, 'function');
  assert.equal(i18n.translate('fr', 'refresh'), 'Refresh');
  assert.equal(i18n.translate('ja', 'sourceSession', { id: '{provider} 한국어 原文' }), '元セッション: {provider} 한국어 原文');
  assert.equal(i18n.formatStamp('fr', null), 'Unavailable');
  assert.equal(i18n.formatStamp('ja', null), '確認不可');
  const time = 1_800_000_000_000;
  assert.equal(i18n.formatStamp('ja', time), new Date(time).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
});

function element() {
  const node = { content: [], attributes: {} };
  const chain = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      target.attributes[key] = args;
      if (key === 'child') target.content.push(args[0]);
      if (key === 'children') target.content.push(...args[0]);
      if (key === 'when' && args[0]) args[1](chain);
      return chain;
    };
  } });
  return chain;
}

const visible = (node) => typeof node === 'string' ? node : (node?.content ?? []).map(visible).join('\n');
const find = (node, id) => node?.attributes?.id?.[0] === id ? node : (node?.content ?? []).map((child) => find(child, id)).find(Boolean);
const settle = () => new Promise((resolve) => setImmediate(resolve));
let instance = 0;

async function loadUi({ properties = {}, exec, sharedValues = new Map(), source } = {}) {
  const calls = [], overlays = [], notifications = [], tasks = [], closed = [], timers = [], focus = [];
  const key = `__contextBridgeUi${instance++}`;
  const status = { config: { mode: 'ask', threshold: 10, autoSessions: [] }, bindings: [], quotas: {}, installed: { claude: true, codex: true }, jobs: [] };
  globalThis[key] = {
    View: class {}, div: element, h_flex: element, v_flex: element,
    agents: () => [], panes: () => [], spaces: () => [], appHome: () => '/mock-app', props: () => properties,
    theme: () => ({}), shared: (name) => sharedValues.get(name), setShared: (name, value) => sharedValues.set(name, value), notify: (value) => notifications.push(value),
    openOverlay: (value) => overlays.push(value), closeOverlay: (id) => closed.push(id), nextCommand: () => new Promise(() => {}),
    exec: async (node, args) => {
      calls.push(args[1]);
      const result = exec ? await exec(args[1], status, { node, args }) : args[1] === 'locale' ? { locale: 'ja' } : status;
      return result?.stdout !== undefined ? result : { stdout: JSON.stringify(result), stderr: '', code: 0 };
    },
  };
  source ??= await readFile(new URL('../mods/context-bridge/main.js', import.meta.url), 'utf8');
  source = source.replace(/^import .* from '(gpui-kit|gpui-base|herdr)';\r?\n/gm, '');
  source = `const { ${Object.keys(globalThis[key]).join(', ')} } = globalThis[${JSON.stringify(key)}];\n${source}`;
  for (const file of ['ui-logic.js', 'i18n.js']) source = source.replace(`'./${file}'`, JSON.stringify(new URL(`../mods/context-bridge/${file}`, import.meta.url).href));
  const { default: ContextBridge } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  delete globalThis[key];
  const cx = { focus_handle: () => ({ focus() { focus.push(true); } }), timer: { every: (delay, callback) => timers.push({ delay, callback }) }, spawn: (fn) => tasks.push(fn(cx)), notify() {}, stop_propagation() {} };
  const view = new ContextBridge();
  view.init(properties, cx);
  return { view, cx, calls, overlays, notifications, tasks, status, closed, timers, focus };
}

test('UI loader renders the real module with LF and CRLF line endings', async () => {
  const source = await readFile(new URL('../mods/context-bridge/main.js', import.meta.url), 'utf8');
  for (const lineEnding of ['\n', '\r\n']) {
    const ui = await loadUi({ properties: { role: 'details', locale: 'en' }, source: source.replace(/\r?\n/g, lineEnding) });
    await settle();
    const root = ui.view.render(ui.cx);
    assert.match(visible(root), /Handoff settings/);
    find(root, 'review').attributes.on_click[0]();
    assert.equal(ui.overlays[0].props.role, 'review');
  }
});

test('summary click opens full details with the same helper, locale and source without taking focus', async () => {
  const ui = await loadUi({ properties: { role: 'summary', locale: 'ko', helper: '/custom/cli.mjs', node: '/custom/node', sourceKey: 'claude:chosen' } });
  await settle();
  const root = ui.view.render(ui.cx);
  assert.equal(ui.focus.length, 0);
  assert.doesNotMatch(visible(root), /Claude|Codex|AGY/);
  assert.match(visible(root), /로그인 후 사용량/);
  const trigger = find(root, 'open-details');
  assert.ok(trigger);
  trigger.attributes.on_click[0]();
  assert.deepEqual(ui.overlays[0].props, { role: 'details', sourceKey: 'claude:chosen', helper: '/custom/cli.mjs', node: '/custom/node', locale: 'ko' });
  assert.equal(ui.overlays[0].kind, 'dialog');
  assert.equal(trigger.attributes.flex_shrink_0.length, 0);
});

test('directly opened details reuse installed summary paths when app PATH has no node', async () => {
  const sharedValues = new Map();
  const runtime = { node: '/installed/bin/node', helper: '/installed/helper/cli.mjs' };
  const exec = (command, status, invocation) => {
    if (invocation.node !== runtime.node) throw new Error(`herdr.exec: cannot run ${invocation.node}: No such file or directory`);
    assert.equal(invocation.args[0], runtime.helper);
    return command === 'locale' ? { locale: 'ko' } : status;
  };
  await loadUi({ properties: { role: 'summary', locale: 'ko', ...runtime }, sharedValues, exec });
  await settle();
  const details = await loadUi({ properties: { overlay: 'direct-details' }, sharedValues, exec });
  await settle();
  assert.equal(details.view.error, null);
  assert.deepEqual(details.calls, ['locale', 'status']);
  assert.match(visible(details.view.render(details.cx)), /인계 설정/);
  details.view.openReview();
  assert.equal(details.overlays[0].props.node, '/installed/bin/node');
  assert.equal(details.overlays[0].props.helper, '/installed/helper/cli.mjs');
  assert.equal(details.overlays[0].props.locale, 'ko');
  assert.deepEqual(sharedValues.get('context-bridge.runtime'), runtime);
});

test('details keeps quota cards, settings, jobs and existing review while close and Escape dismiss it', async () => {
  const ui = await loadUi({ properties: { overlay: 'details-id', locale: 'en' } });
  await settle();
  ui.view.data.quotas = { claude: { provider: 'claude', windows: [] }, codex: { provider: 'codex', windows: [] } };
  ui.view.jobs = [{ status: 'preparing' }];
  const root = ui.view.render(ui.cx);
  const text = visible(root);
  for (const expected of ['Claude Code', 'Codex', 'Handoff settings', 'Select source session', 'Preparing handoff records', 'Refresh', 'Confirm manual handoff']) assert.ok(text.includes(expected), expected);
  assert.equal(ui.focus.length, 1);
  find(root, 'review').attributes.on_click[0]();
  assert.equal(ui.overlays[0].props.role, 'review');
  assert.equal(ui.overlays[0].props.locale, 'en');
  find(root, 'close-details').attributes.on_click[0]();
  root.attributes.on_key_down[0]({ key: 'escape' }, ui.cx);
  assert.deepEqual(ui.closed, ['details-id', 'details-id']);
});

test('empty usage is localized and hides unobserved provider cards in summary and details', async () => {
  for (const [locale, hint] of [['en', /Waiting for usage after sign-in/], ['ko', /로그인 후 사용량/], ['ja', /ログイン後の使用量/], ['zh-CN', /登录后的用量/]]) {
    for (const role of ['summary', 'details']) {
      const ui = await loadUi({ properties: { role, locale } });
      await settle();
      const text = visible(ui.view.render(ui.cx));
      assert.match(text, hint);
      assert.doesNotMatch(text, /Claude Code|Codex|AGY/);
    }
  }
});

test('AGY summary shows Argon weekly only while details retain every bucket', async () => {
  const ui = await loadUi({ properties: { role: 'summary', locale: 'en' } });
  await settle();
  ui.view.data.quotas = { agy: { provider: 'agy', observedAt: Date.now(), windows: [
    { id: 'gemini-argon-wtu-weekly', label: 'gemini-argon-wtu-weekly', remainingPercent: 25, resetsAt: Date.now() + 300_000 },
    { id: '3p-weekly', label: '3p-weekly', remainingPercent: 80, resetsAt: null },
    { id: 'disabled', label: 'disabled', remainingPercent: 1, resetsAt: Date.now() + 300_000, disabled: true },
  ] } };
  const summary = ui.view.render(ui.cx);
  assert.match(visible(summary), /AGY/);
  assert.doesNotMatch(visible(summary), /Claude\n|Codex|5h|3p-weekly|disabled|argon|80%|1%/);
  assert.equal(visible(find(summary, 'summary-agy-weekly')), 'Week 25%');
  assert.match(find(summary, 'summary-agy-weekly').attributes.tooltip[0], /Gemini 4 Argon.*gemini-argon-wtu-weekly/);
  assert.match(find(summary, 'summary-agy-weekly').attributes.tooltip[0], /Resets/);
  ui.view.role = 'details';
  const details = visible(ui.view.render(ui.cx));
  assert.match(details, /AGY \(Antigravity\)/);
  assert.match(details, /gemini-argon-wtu-weekly/);
  assert.match(details, /3p-weekly/);
  assert.match(details, /80% left/);
  assert.match(details, /disabled/);
  assert.match(details, /25% left/);
  assert.doesNotMatch(details, /1% left/);
  ui.view.data.quotas.agy = { provider: 'agy', windows: [], error: 'offline' };
  ui.view.role = 'summary';
  assert.match(visible(ui.view.render(ui.cx)), /AGY\nWeek —/);
});

test('AGY compact weekly label follows all four display languages', async () => {
  for (const [locale, label] of [['en', 'Week'], ['ko', '주간'], ['ja', '週間'], ['zh-CN', '每周']]) {
    const ui = await loadUi({ properties: { role: 'summary', locale } });
    await settle();
    ui.view.data.quotas = { agy: { provider: 'agy', observedAt: Date.now(), windows: [{ id: 'gemini-argon-wtu-weekly', remainingPercent: 42, resetsAt: Date.now() + 300_000 }] } };
    assert.equal(visible(find(ui.view.render(ui.cx), 'summary-agy-weekly')), `${label} 42%`);
  }
});

test('AGY low quota alerts remain usage-only in all locales even with automatic bindings', async () => {
  for (const locale of ['en', 'ko', 'ja', 'zh-CN']) {
    const ui = await loadUi({ properties: { role: 'summary', locale } });
    await settle();
    ui.view.data.quotas = { agy: { provider: 'agy', observedAt: Date.now(), windows: [{ id: 'raw-bucket', remainingPercent: 5, resetsAt: Date.now() + 300_000 }] } };
    ui.view.data.bindings = [{ provider: 'agy', decision: { action: 'auto' } }];
    ui.view.alertLowQuota();
    assert.equal(ui.notifications.length, 1);
    assert.match(ui.notifications[0].title, /AGY/);
    assert.match(ui.notifications[0].body, /raw-bucket.*5%/);
    assert.equal(ui.notifications[0].action, undefined);
    assert.doesNotMatch(ui.notifications[0].body, /handoff|인계|引き継|交接/i);
    assert.equal(ui.overlays.length, 0);
  }
});

test('simultaneous Claude and AGY warnings both reach the user without duplicate notifications', async () => {
  const ui = await loadUi({ properties: { role: 'summary', locale: 'en' } });
  await settle();
  const observedAt = Date.now(), resetsAt = observedAt + 300_000;
  ui.view.data.quotas = {
    claude: { provider: 'claude', observedAt, windows: [{ id: 'five_hour', remainingPercent: 5, resetsAt }] },
    agy: { provider: 'agy', observedAt, windows: [{ id: 'raw-bucket', remainingPercent: 5, resetsAt }] },
  };
  ui.view.alertLowQuota();
  ui.view.alertLowQuota();
  ui.view.alertLowQuota();
  assert.equal(ui.notifications.length, 2);
  assert.match(ui.notifications[0].title, /Claude/);
  assert.match(ui.notifications[1].title, /AGY/);
  assert.equal(ui.notifications[1].action, undefined);
  assert.equal(ui.overlays.length, 1);
});

test('collapsed summary keeps the periodic refresh, job polling and low-quota alert owner', async () => {
  const ui = await loadUi({ properties: { role: 'summary', locale: 'en' } });
  await settle();
  ui.status.quotas = { claude: { provider: 'claude', observedAt: Date.now(), windows: [{ id: 'five_hour', remainingPercent: 10, resetsAt: Date.now() + 300_000 }] } };
  ui.timers.find(({ delay }) => delay === 60_000).callback(ui.cx);
  await settle();
  assert.equal(ui.notifications.length, 1);
  assert.equal(ui.overlays[0].props.role, 'review');
  assert.deepEqual(ui.calls, ['status', 'status']);
  ui.view.jobs = [{ id: 'job-1', status: 'preparing' }];
  ui.timers.find(({ delay }) => delay === 2000).callback(ui.cx);
  await settle();
  assert.equal(ui.calls.at(-1), 'job');
});

test('summary labels and warning/freshness tooltips are localized in all four languages', async () => {
  for (const [locale, fiveHour, weekly, stale] of [['en', '5h', 'Week', 'Over 10 minutes'], ['ko', '5시간', '주간', '10분 이상'], ['ja', '5時間', '週間', '10分以上'], ['zh-CN', '5小时', '每周', '超过10分钟']]) {
    const ui = await loadUi({ properties: { role: 'summary', locale } });
    await settle();
    ui.view.data.quotas = {
      claude: { provider: 'claude', observedAt: Date.now(), windows: [{ id: 'five_hour', remainingPercent: 10, resetsAt: Date.now() + 300_000 }] },
      codex: { provider: 'codex', observedAt: Date.now() - 600_000, windows: [{ id: 'codex:primary', labelParams: { minutes: 10080 }, remainingPercent: 5, resetsAt: Date.now() + 300_000 }] },
    };
    const root = ui.view.render(ui.cx);
    assert.equal(visible(find(root, 'summary-claude-fiveHour')), `${fiveHour} 10% !`);
    assert.equal(visible(find(root, 'summary-codex-weekly')), `${weekly} 5% ~`);
    assert.ok(find(root, 'summary-codex-weekly').attributes.tooltip[0].includes(stale));
    assert.equal(visible(find(root, 'summary-claude-weekly')), `${weekly} —`);
  }
});

test('startup waits for helper locale before status and passes it to the review overlay', async () => {
  let resolveLocale;
  const locale = new Promise((resolve) => { resolveLocale = resolve; });
  const ui = await loadUi({ properties: { overlay: 'details' }, exec: (command, status) => command === 'locale' ? locale : status });
  assert.deepEqual(ui.calls, ['locale']);
  assert.doesNotMatch(visible(ui.view.render(ui.cx)), /[가-힣]|Refresh|Reading account/);
  ui.view.openReview();
  assert.equal(ui.overlays.length, 0);
  resolveLocale({ locale: 'ja' });
  await settle();
  assert.deepEqual(ui.calls, ['locale', 'status']);
  assert.match(visible(ui.view.render(ui.cx)), /更新/);
  ui.view.openReview();
  assert.equal(ui.overlays[0].props.locale, 'ja');
  ui.view.refresh(ui.cx);
  await settle();
  assert.deepEqual(ui.calls, ['locale', 'status', 'status']);
});

test('overlay uses inherited locale immediately and localizes unavailable status errors', async () => {
  const ui = await loadUi({ properties: { role: 'review', locale: 'zh-CN' }, exec: async () => ({ stdout: 'invalid', stderr: '', code: 1 }) });
  assert.deepEqual(ui.calls, ['status']);
  assert.match(visible(ui.view.render(ui.cx)), /交接/);
  await settle();
  assert.match(visible(ui.view.render(ui.cx)), /无法读取辅助程序响应/);
  assert.doesNotMatch(visible(ui.view.render(ui.cx)), /[가-힣]/);
});

test('locale detection failure uses coherent English errors and leaves external details intact', async () => {
  const ui = await loadUi({ properties: { overlay: 'details' }, exec: async (command) => { if (command === 'locale') throw new Error('not available'); return { stdout: 'invalid', stderr: '', code: 1 }; } });
  await settle();
  const text = visible(ui.view.render(ui.cx));
  assert.match(text, /Unable to read helper response/);
  assert.match(text, /Refresh/);
  assert.doesNotMatch(text, /[가-힣]/);
  const external = await loadUi({ properties: { locale: 'en', role: 'review' }, exec: async () => ({ error: '외부 원문 エラー' }) });
  await settle();
  assert.match(visible(external.view.render(external.cx)), /외부 원문 エラー/);
});

test('quota notifications use selected locale and preserve provider window labels', async () => {
  const ui = await loadUi({ properties: { role: 'review', locale: 'ja' } });
  await settle();
  ui.view.data.quotas = { claude: { provider: 'claude', observedAt: Date.now(), windows: [{ id: 'five_hour', label: 'Provider label', remainingPercent: 5, resetsAt: Date.now() + 300_000 }] } };
  ui.view.alertLowQuota();
  assert.match(ui.notifications[0].title, /Claude Code/);
  assert.match(ui.notifications[0].body, /Provider label/);
  assert.match(ui.notifications[0].body, /残り/);
  assert.doesNotMatch(ui.notifications[0].title + ui.notifications[0].body, /[가-힣]/);
});

test('unsupported helper locale falls back to English', async () => {
  const ui = await loadUi({ properties: { overlay: 'details' }, exec: (command, status) => command === 'locale' ? { locale: 'fr' } : status });
  await settle();
  assert.match(visible(ui.view.render(ui.cx)), /Refresh/);
  ui.view.openReview();
  assert.equal(ui.overlays[0].props.locale, 'en');
});

test('all four locales render session review and job states without changing user content', async () => {
  for (const [locale, label] of [['en', 'Hand off'], ['ko', '인계하기'], ['ja', '引き継ぐ'], ['zh-CN', '交接']]) {
    const ui = await loadUi({ properties: { role: 'review', locale } });
    await settle();
    ui.view.data.bindings = [{ provider: 'claude', id: 'user-session', title: '사용자 제목 原文', cwd: '/사용자/原文' }];
    ui.view.selected = 'claude:user-session';
    ui.view.jobs = [{ status: 'preparing' }, { status: 'launched' }, { status: 'failed', error: '외부 오류 原文' }];
    const text = visible(ui.view.render(ui.cx));
    assert.ok(text.includes(label), locale);
    assert.match(text, /사용자 제목 原文/);
    assert.match(text, /\/사용자\/原文/);
    assert.match(text, /외부 오류 原文/);
    assert.doesNotMatch(text, /undefined|\{\w+\}/);
  }
});
