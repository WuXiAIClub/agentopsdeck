// Matched temporary builds, real React application, synthetic APIs only.
// Optional baselines replace individual modules in the temporary build only.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build, preview } from 'vite';

const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const root = fileURLToPath(new URL('..', import.meta.url));
const output = await mkdtemp(join(tmpdir(), 'agentopsdeck-cache-lifecycle-'));
const baseline = process.env.AOD_CACHE_BASELINE;
const baselineSource = baseline ? await readFile(baseline, 'utf8') : undefined;
const layoutBaseline = process.env.AOD_LAYOUT_BASELINE ? await readFile(process.env.AOD_LAYOUT_BASELINE, 'utf8') : undefined;
const fittingBaseline = process.env.AOD_FITTING_BASELINE ? await readFile(process.env.AOD_FITTING_BASELINE, 'utf8') : undefined;
const messagesBaseline = process.env.AOD_MESSAGES_BASELINE ? await readFile(process.env.AOD_MESSAGES_BASELINE, 'utf8') : undefined;
const measureClassification = process.env.AOD_CLASSIFICATION_MEASURE === '1';
const profileStartup = process.env.AOD_STARTUP_PROFILE === '1';
const coldOnly = process.env.AOD_CACHE_COLD_ONLY === '1';
const cycles = Number(process.env.AOD_CACHE_CYCLES ?? 3);
assert.ok(Number.isInteger(cycles) && cycles >= 3 && cycles <= 50);
const docked = Number(process.env.AOD_CACHE_DOCKED ?? 12);
const floating = Number(process.env.AOD_CACHE_FLOATING ?? 0);
assert.ok([6, 12].includes(docked) && [0, 4].includes(floating));
const sessionCount = docked + floating;
const scope = 'a'.repeat(64);
const sessions = Array.from({ length: sessionCount }, (_, i) => ({ sessionKey: `remote:cache-${i}`,
  envConnectionId: 'remote', title: `Cache lifecycle ${i}`, source: 'codex', agentId: 'codex', status: 'idle', lastActiveAt: 1 }));
const histories = new Map(sessions.map(session => [session.sessionKey, Array.from({ length: 240 }, (_, i) => [
  ...Array.from({ length: 4 }, (_, tool) => ({ id: `tool-${i}-${tool}`, sessionKey: session.sessionKey,
    role: 'tool', createdAt: i * 10 + tool, status: 'sent', text: `Synthetic tool output ${i}:${tool}` })),
  { id: `chat-${i}`, sessionKey: session.sessionKey, role: 'assistant', createdAt: i * 10 + 9, status: 'sent',
    text: `History ${session.sessionKey} ${i}\n\nRetained **searchable** text.\n\n- First item\n- Second item\n\n\`inline code\`` },
]).flat()]));
const historyRevisions = new Map(sessions.map(session => [session.sessionKey, 1]));
function dock(ids, depth = 0) {
  if (ids.length === 1) return { kind: 'pane', id: ids[0] };
  const half = Math.ceil(ids.length / 2);
  return { kind: 'split', axis: depth % 2 ? 'vertical' : 'horizontal', ratio: half / ids.length,
    first: dock(ids.slice(0, half), depth + 1), second: dock(ids.slice(half), depth + 1) };
}
const panes = [...sessions.map((session, i) => ({ id: `chat-${i}`, sessionKey: session.sessionKey })),
  ...Array.from({ length: 5 }, (_, i) => ({ id: `note-${i}`, kind: 'notebook', target: 'session', resourceId: sessions[i].sessionKey }))];
const layout = { id: 'current', name: 'Current', collapsedKeys: [], workspace: {
  version: 2, panes, floating: Array.from({ length: floating }, (_, i) => ({ id: `chat-${docked + i}`,
    x: .65, y: i * .17, width: .33, height: .25 })), active: 'chat-0',
  dock: dock(panes.filter(pane => !pane.sessionKey || Number(pane.id.slice(5)) < docked).map(pane => pane.id)),
} };
let server, browser;
try {
  await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'error', plugins: [{
    name: 'cache-lifecycle-test-only', enforce: 'pre', transform(source, id) {
      if (id.endsWith('/src/components/messages.tsx') && (messagesBaseline || measureClassification)) {
        let code = messagesBaseline ?? source;
        if (measureClassification) {
          for (const name of ['readableText', 'stripThinkingLines', 'countsTowardMessageWindow']) {
            const signature = new RegExp(`(function ${name}\\([^)]*\\)(?:: [^{]+)? \\{)`);
            assert.ok(signature.test(code), name);
            code = code.replace(signature, `$1 (window as any).__classification.${name}++;`);
          }
        }
        return code;
      }
      if (layoutBaseline && id.endsWith('/src/components/SessionWorkspaceView.tsx')) return layoutBaseline;
      if (fittingBaseline && id.endsWith('/src/lib/message-cache-budget.ts')) return fittingBaseline;
      if (process.env.AOD_CACHE_TRACE && id.endsWith('/src/lib/use-message-history.ts')) {
        return source.replace('if (!loadMore || loading || pending.current || hiddenCount <= 0',
          'console.log("history-debug", JSON.stringify({key, loading, pending:pending.current, count:countWindowMessages(messages)})); if (!loadMore || loading || pending.current || hiddenCount <= 0')
          .replace('const delay = autoAttempt.retryDelay(attempt, outcome);', 'const delay = autoAttempt.retryDelay(attempt, outcome); console.log("retry-debug", JSON.stringify({attempt,outcome,delay}));');
      }
      if (process.env.AOD_CACHE_TRACE && id.endsWith('/src/main.tsx')) {
        return source
          .replace('async function loadMoreHistory(schedule?: HistoryReadSchedule, signal?: AbortSignal): Promise<HistoryBackfillOutcome> {', 'async function loadMoreHistory(schedule?: HistoryReadSchedule, signal?: AbortSignal): Promise<HistoryBackfillOutcome> { console.log("older-entry", selected?.sessionKey, messageState.historyLoading, messageState.hiddenCount, messageState.items[0]?.id);')
          .replaceAll('const data = await api.sessionMessages(sessionKey, MESSAGE_HISTORY_PAGE_SIZE, signal, before, false, schedule);', 'console.log("older-start", sessionKey, before); const data = await api.sessionMessages(sessionKey, MESSAGE_HISTORY_PAGE_SIZE, signal, before, false, schedule); console.log("older-done", sessionKey, before, currentRequest());')
          .replaceAll('if (!currentRequest()) return;\n      if (!isCancelledRead(err))', 'console.log("older-debug", String(err)); if (!currentRequest()) return;\n      if (!isCancelledRead(err))');
      }
      if (id.endsWith('/src/lib/session-cache.ts')) {
        let code = baselineSource ?? source;
        assert.ok(code.includes('function enforceBounds(store: Storage): void {'));
        assert.ok(code.includes('export function writeCachedMessages('));
        code = code.replace('function enforceBounds(', 'function enforceBoundsOriginal(')
          .replace('export function writeCachedMessages(', 'function writeCachedMessagesOriginal(');
        return code + `
function cacheMeasure<T>(name: string, operation: () => T): T {
  const counters = (window as any).__cache;
  const stat = counters[name] ??= { calls: 0, ms: 0, maxMs: 0, parses: 0, parseChars: 0, stringifies: 0, stringifyChars: 0 };
  const parse = JSON.parse, stringify = JSON.stringify, start = performance.now();
  if (name === 'bounds') (JSON as any).parse = (text: string, ...args: any[]) => {
    stat.parses++; stat.parseChars += text.length; return (parse as any)(text, ...args);
  };
  if (name === 'write') (JSON as any).stringify = (...args: any[]) => {
    const result = (stringify as any)(...args); stat.stringifies++; stat.stringifyChars += result?.length ?? 0; return result;
  };
  try { return operation(); } finally {
    JSON.parse = parse; JSON.stringify = stringify;
    const ms = performance.now() - start; stat.calls++; stat.ms += ms; stat.maxMs = Math.max(stat.maxMs, ms);
  }
}
function enforceBounds(store: Storage): void { cacheMeasure('bounds', () => enforceBoundsOriginal(store)); }
export function writeCachedMessages(...args: Parameters<typeof writeCachedMessagesOriginal>): void {
  cacheMeasure('write', () => writeCachedMessagesOriginal(...args));
}
(window as any).__cacheHarness = { writeCachedMessages, readCachedMessages, clearAllCachedData, clearCachedMessages, clearCachedNodeData };
`;
      }
      if (id.endsWith('/src/lib/desktop-history-layout.ts')) {
        assert.ok(source.includes('export function observeDesktopHistoryLayout('));
        return source.replace('export function observeDesktopHistoryLayout(', 'function observeDesktopHistoryLayoutOriginal(') + `
export function observeDesktopHistoryLayout(root: HTMLElement | null) {
  const stats = (window as any).__controllers; stats.created++; stats.active++;
  const cleanup = observeDesktopHistoryLayoutOriginal(root); let done = false;
  return () => { if (!done) { done = true; cleanup(); stats.disposed++; stats.active--; } };
}
`;
      }
    },
  }], build: { outDir: output, emptyOutDir: true, sourcemap: profileStartup } });
  server = await preview({ root: output, configFile: false, envFile: false,
    build: { outDir: output }, preview: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 1800, height: 1000 }, serviceWorkers: 'block' });
  const errors = [], denied = [], reads = [], layouts = new Map(), held = [];
  let hold = false, active = 0, peak = 0;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { denied.push(`${request.method()} ${url.origin}`); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = body => route.fulfill({ json: body });
    // This POST is a read-only summary query, not a session command. Keep all
    // actual sends/stops and external requests rejected by the fixture fence.
    if (/\/workspace\/layouts\/(current|saved)$/.test(url.pathname)) {
      const previous = layouts.get(url.pathname) ?? { revision: 0, content: null };
      if (request.method() === 'PUT') layouts.set(url.pathname, { revision: previous.revision + 1, content: request.postDataJSON().content });
      else if (request.method() !== 'GET') { denied.push(request.method()); return route.abort(); }
      return json(layouts.get(url.pathname) ?? previous);
    }
    if (url.pathname === '/api/hub/v1/completions/summary' && request.method() === 'POST') {
      const body = request.postDataJSON();
      assert.deepEqual(Object.keys(body), ['sessions']);
      assert.ok(Array.isArray(body.sessions) && body.sessions.every(key => sessions.some(session => session.sessionKey === key)));
      return json({ items: [] });
    }
    if (request.method() !== 'GET') { denied.push(`${request.method()} ${url.pathname}`); return route.abort(); }
    // Native notebook ownership must be positively read. A missing overview
    // now fails closed and would test an error card rather than editor cleanup.
    if (/^\/api\/hub\/v1\/workspace\/shared-content\/[^/]+$/.test(url.pathname)) {
      assert.equal(request.headers()['x-agentopsdeck-recovery-scope'], scope);
      return json({ enabled: false, head: null, native: null, bindings: [] });
    }
    if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: scope, passkeys: { available: false, count: 0 } });
    if (url.pathname.endsWith('/sessions/state')) return json({ groups: [{ agentId: 'codex', sessions }], revision: '1', updatedAt: 1 });
    if (url.pathname.endsWith('/messages')) {
      const key = decodeURIComponent(url.pathname.split('/').at(-2)), all = histories.get(key);
      assert.ok(all);
      const limit = Number(url.searchParams.get('limit')), before = url.searchParams.get('before');
      const end = before ? all.findIndex(row => row.id === before) : all.length;
      assert.ok(limit > 0 && limit <= 500 && end >= 0);
      const start = Math.max(0, end - limit);
      const read = { key, before, startedAt: Date.now(), requestedRevision: historyRevisions.get(key) };
      reads.push(read); active++; peak = Math.max(peak, active);
      const reply = async () => { try {
        read.replyAt = Date.now(); read.replyRevision = historyRevisions.get(key);
        await json({ messages: all.slice(start, end), totalCount: all.length,
          hiddenCount: start, revision: String(read.replyRevision), updatedAt: Date.now() });
        read.fulfilledAt = Date.now();
      } finally { active--; } };
      if (hold) { held.push(reply); return; }
      await delay(40); return reply();
    }
    if (url.pathname.endsWith('/queue') || url.pathname.endsWith('/notebooks')) return json({ items: [], nextCursor: null });
    if (url.pathname.endsWith('/notebook')) return json({ resourceId: `fixture:${url.pathname}`, text: '', revision: 0, updatedAt: 1 });
    if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
    if (url.pathname === '/api/gateway/status') return json({ connected: true });
    return route.fulfill({ status: 404, json: {} });
  });
  await context.addInitScript(({ layout, scope }) => {
    // Align each navigation away from minute-boundary safety refreshes.
    // Time still advances; this does not disable live refresh or alter product code.
    const NativeDate = Date;
    const offset = NativeDate.parse('2026-09-30T10:00:01Z') - NativeDate.now();
    window.Date = class extends NativeDate {
      constructor(...args) { if (args.length) super(...args); else super(NativeDate.now() + offset); }
      static now() { return NativeDate.now() + offset; }
    };
    localStorage.setItem('agentopsdeck.locale', 'en');
    // Pin the original two-slot workload. Auto policy intentionally boosts to
    // three on capable devices; its adaptive limits have separate unit tests.
    localStorage.setItem('agentopsdeck.refresh-policy.v1', 'balanced');
    const key = `agentopsdeck.current-layout.v2:${scope}`;
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(layout));
    window.__cache = {}; window.__controllers = { active: 0, created: 0, disposed: 0 };
    // Counters retain no observers or DOM nodes. Account for target ownership,
    // including re-observation after disconnect, rather than constructor count.
    window.__observers = {};
    for (const name of ['IntersectionObserver', 'ResizeObserver', 'MutationObserver']) {
      const Native = window[name], stats = window.__observers[name] = { active: 0, targets: 0, kinds: {} };
      window[name] = class extends Native {
        targets = new WeakMap(); count = 0; kinds = {};
        observe(target, ...args) {
          super.observe(target, ...args);
          if (!this.targets.has(target)) {
            const kind = `${target.nodeName}.${typeof target.className === 'string' ? target.className.split(' ').slice(0, 2).join('.') : ''}`;
            this.targets.set(target, kind); stats.targets++;
            this.kinds[kind] = (this.kinds[kind] || 0) + 1;
            stats.kinds[kind] = (stats.kinds[kind] || 0) + 1;
            if (this.count++ === 0) stats.active++;
          }
        }
        unobserve(target) {
          super.unobserve(target);
          const kind = this.targets.get(target);
          if (this.targets.delete(target)) {
            stats.targets--; this.kinds[kind]--; if (--stats.kinds[kind] === 0) delete stats.kinds[kind];
            if (--this.count === 0) stats.active--;
          }
        }
        disconnect() {
          super.disconnect(); stats.targets -= this.count;
          if (this.count) stats.active--;
          for (const [kind, count] of Object.entries(this.kinds)) {
            stats.kinds[kind] -= count; if (!stats.kinds[kind]) delete stats.kinds[kind];
          }
          this.count = 0; this.targets = new WeakMap(); this.kinds = {};
        }
      };
    }
    window.__classification = { readableText: 0, stripThinkingLines: 0, countsTowardMessageWindow: 0 };
    window.__perf = { longTasks: [], shifts: [], lcp: [] };
    for (const [type, field] of [['longtask', 'longTasks'], ['layout-shift', 'shifts'], ['largest-contentful-paint', 'lcp']]) {
      if (!PerformanceObserver.supportedEntryTypes.includes(type)) continue;
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) window.__perf[field].push({ startTime: entry.startTime,
          duration: entry.duration, value: entry.value, hadRecentInput: entry.hadRecentInput,
          element: entry.element?.tagName, size: entry.size,
          workspace: field === 'shifts' ? [...document.querySelectorAll('.session-workspace, .session-workspace-surface, .session-workspace-controls, .saved-layouts-strip-host')].map(node => ({ class: node.className, rect: node.getBoundingClientRect().toJSON() })) : undefined,
          sources: entry.sources?.map(source => ({ tag: source.node?.nodeName, class: typeof source.node?.className === 'string' ? source.node.className : '',
            previousRect: source.previousRect?.toJSON(), currentRect: source.currentRect?.toJSON() })) });
      }).observe({ type, buffered: true });
    }
    window.EventSource = class extends EventTarget {
      readyState = 1; static OPEN = 1; static CONNECTING = 0; static CLOSED = 2;
      constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); }
      close() { this.readyState = 2; }
    };
  }, { layout, scope });
  const page = await context.newPage(); page.setDefaultTimeout(60_000);
  page.on('pageerror', error => errors.push(error.message));
  if (process.env.AOD_CACHE_TRACE) page.on('console', message => console.log(message.text()));
  const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
  async function sample(label, extra = {}) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const data = await page.evaluate(() => {
      const perf = window.__perf, shifts = perf.shifts.filter(s => !s.hadRecentInput);
      let cls = 0, score = 0, first = 0, last = -Infinity;
      for (const shift of shifts) {
        if (shift.startTime - last >= 1000 || shift.startTime - first >= 5000) { first = shift.startTime; score = 0; }
        score += shift.value; last = shift.startTime; cls = Math.max(cls, score);
      }
      let nodes = 0; const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
      while (walker.nextNode()) nodes++;
      return { elapsedMs: performance.now(), elements: document.querySelectorAll('*').length, attachedNodes: nodes,
        domAreas: Object.fromEntries(['.markdown-body', '.desktop-attached-tools', 'footer.message-footer'].map(selector =>
          [selector, [...document.querySelectorAll(selector)].reduce((n, el) => n + el.querySelectorAll('*').length + 1, 0)])),
        panes: document.querySelectorAll('[data-workspace-pane]').length,
        captionCollapseControls: document.querySelectorAll('[data-workspace-pane]:has([data-session-pane]) > .session-pane-caption > button[aria-label="Collapse floating pane"]').length,
        chats: document.querySelectorAll('[data-message-search-id^="chat-"]').length,
        tools: document.querySelectorAll('.desktop-tool-chip').length, controllers: window.__controllers, observers: window.__observers, cache: window.__cache,
        longTasks: { count: perf.longTasks.length, ms: perf.longTasks.reduce((n, e) => n + e.duration, 0), maxMs: Math.max(0, ...perf.longTasks.map(e => e.duration)) },
        lcpCandidate: perf.lcp.at(-1), clsObserved: cls, classification: window.__classification,
        largestShifts: [...perf.shifts].sort((a, b) => b.value - a.value).slice(0, 3) };
    });
    const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
    const result = { label, baseline: !!baseline, layoutBaseline: !!layoutBaseline, fittingBaseline: !!fittingBaseline,
      messagesBaseline: !!messagesBaseline, measureClassification, ...data, browserNodes: metrics.Nodes, heapBytes: metrics.JSHeapUsedSize, documents: metrics.Documents,
      mainThread: Object.fromEntries(['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount'].map(key => [key, metrics[key]])),
      docked, floating, historyReads: reads.length, activeReads: active, peakHistoryReads: peak, ...extra };
    console.log(JSON.stringify(result)); return result;
  }
  const ready = async () => {
    // Counting the full transcript on every animation frame polluted CPU
    // profiles. Readiness is diagnostic only; a 250ms poll keeps the same gate.
    try { await page.waitForFunction(count => document.querySelectorAll('[data-message-search-id^="chat-"]').length === count * 200, sessionCount, { polling: 250 }); }
    catch (error) {
      await sample('readiness-failure');
      console.error(JSON.stringify({ reads, held: held.length, errors,
        perPane: await page.locator('[data-session-pane]').evaluateAll(panes => panes.map(pane => ({ key: pane.dataset.sessionPane,
          rows: pane.querySelectorAll('[data-message-search-id^="chat-"]').length }))) }));
      throw error;
    }
  };
  const paneFor = i => page.locator('[data-workspace-pane]').filter({ has: page.locator(`[data-session-pane="remote:cache-${i}"]`) });
  const finishProfile = profileStartup ? await (await import('./fixtures/startup-profile.mjs')).startStartupProfile(cdp, output) : undefined;
  await page.goto(origin);
  await ready(); await delay(1500);
  const cold = await sample('cold-start-settled');
  // Capture page elapsed time before stopping/serializing the profile. These
  // optional diagnostics must not inflate the reported startup completion.
  await finishProfile?.();
  assert.equal(cold.panes, sessionCount + 5); assert.equal(cold.tools, sessionCount * 800); assert.equal(cold.controllers.active, sessionCount);
  assert.ok(cold.historyReads >= sessionCount * 5 && cold.historyReads <= sessionCount * 6,
    'five history pages per pane plus at most one immediate visibility/reconnect revalidation');
  assert.equal(cold.peakHistoryReads, 2);
  if (!baseline) assert.equal(cold.cache.bounds.parses, 0);
  if (!coldOnly) {
  // Cached raw records contain 40 chats/card. Revalidation must automatically
  // restore the same 200-chat window as cold startup, including after a race.
  const cachedChats = await page.evaluate(() => Object.values(localStorage).reduce((sum, raw) => {
    try { const entry = JSON.parse(raw); return sum + (entry.messages?.filter(m => m.id.startsWith('chat-')).length ?? 0); } catch { return sum; }
  }, 0));
  assert.equal(cachedChats, sessionCount * 40);
  hold = true; const readsBefore = reads.length;
  await page.reload();
  await page.waitForFunction(count => document.querySelectorAll('[data-message-search-id^="chat-"]').length === count, cachedChats, { polling: 250 });
  const cached = await sample('cached-restore-network-held');
  assert.equal(cached.chats, cachedChats); assert.equal(cached.panes, sessionCount + 5);
  for (let i = 0; i < 200 && reads.length === readsBefore; i++) await delay(25);
  assert.ok(reads.length > readsBefore); assert.equal(cached.cache.write?.calls ?? 0, 0);
  hold = false; for (const reply of held.splice(0)) await reply();
  // A racing priority read can find the same revision and legitimately avoid
  // a redundant disk write. Assert visible full-history freshness, not a fixed
  // cache-write count that would wait for the next minute calibration.
  await ready();
  await delay(1500);
  const warm = await sample('cached-start-revalidated');
  assert.equal(warm.chats, sessionCount * 200, 'automatic cached-start backfill restores the full chat window');
  assert.equal(warm.tools, sessionCount * 800); assert.equal(warm.controllers.active, sessionCount);
  if (!layoutBaseline) for (const startup of [cold, warm]) {
    assert.ok(!startup.largestShifts.some(shift => !shift.hadRecentInput && shift.value > .05
      && shift.sources?.some(source => source.class === 'session-workspace-pane')), 'startup must not paint near-zero panes then move them into place');
  }
  // Native find, text selection and draft are acceptance checks, not performance shortcuts.
  assert.equal(await page.evaluate(() => window.find('History remote:cache-0 200')), true);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  // At four floats, ordinary navigation deliberately refuses another float;
  // it must not rearrange the dock. Recycle floating slots in that scenario.
  const cyclePanes = floating ? [docked, docked + 1, docked + 2] : [0, 1, 2];
  const draftPane = cyclePanes[0];
  await page.locator(`[data-session-card="remote:cache-${draftPane}"]`).click();
  await paneFor(draftPane).locator('.desktop-composer-dock').hover();
  await paneFor(draftPane).locator('textarea').first().fill('Unsent lifecycle draft');
  for (let cycle = 1; cycle <= cycles; cycle++) {
    const start = await page.evaluate(() => performance.now());
    // Lifecycle ownership test, not pointer hit-testing: floating panes can
    // legitimately overlap. Dispatch the actual button action without moving
    // geometry solely to make a synthetic mouse reach an obscured control.
    for (const i of cyclePanes) await paneFor(i).getByRole('button', { name: 'Close pane', exact: true, includeHidden: true }).evaluate(button => button.click());
    await page.waitForFunction(count => window.__controllers.active === count - 3, sessionCount);
    const closed = await sample(`cycle-${cycle}-closed`);
    assert.equal(closed.chats, (sessionCount - 3) * 200); assert.equal(closed.panes, sessionCount + 2); assert.equal(closed.tools, (sessionCount - 3) * 800);
    // Reproduce same-SPA navigation cache staleness: the run finishes while
    // its pane is closed. Cached rows remain visible, but cannot count as a
    // successful network revalidation or wait for the minute safety timer.
    const changedKey = `remote:cache-${draftPane}`;
    const latestText = `Completed while away, cycle ${cycle}`;
    histories.get(changedKey).at(-1).text = latestText;
    historyRevisions.set(changedKey, cycle + 1);
    const beforeReopenReads = reads.length;
    const reopenStarted = Date.now();
    for (const i of cyclePanes) await page.locator(`[data-session-card="remote:cache-${i}"]`).click();
    await paneFor(draftPane).getByText(latestText, { exact: true }).waitFor({ timeout: 5_000 });
    const latestVisibleMs = Date.now() - reopenStarted;
    assert.ok(reads.slice(beforeReopenReads).some(read => read.key === changedKey), 'warm navigation must fetch the latest server messages immediately');
    await ready();
    await delay(1500);
    const reopened = await sample(`cycle-${cycle}-reopened`, { cycleStartedMs: start, latestVisibleMs });
    assert.equal(reopened.controllers.active, sessionCount); assert.equal(reopened.controllers.disposed, cycle * 3);
    assert.equal(reopened.panes, sessionCount + 5); assert.equal(reopened.chats, sessionCount * 200); assert.equal(reopened.tools, sessionCount * 800);
    const expected = structuredClone(warm.observers);
    // Reopening defaults to floating while capacity remains, adding exactly
    // one observed caption button per floating pane, not leaking observers.
    const addedButtons = reopened.captionCollapseControls - warm.captionCollapseControls;
    expected.ResizeObserver.targets += addedButtons;
    if (addedButtons) expected.ResizeObserver.kinds['BUTTON.'] = (expected.ResizeObserver.kinds['BUTTON.'] ?? 0) + addedButtons;
    assert.deepEqual(reopened.observers, expected, 'observer ownership must match mounted content and floating controls');
    assert.equal(await paneFor(draftPane).locator('textarea').first().inputValue(), 'Unsent lifecycle draft');
    // Every retained row/tool is present again; no hidden history truncation.
    assert.equal(await paneFor(0).locator('[data-message-search-id="chat-200"]').count(), 1);
  }
  // Returning to the browser must also revalidate an already-mounted pane,
  // even when the stream looks connected and no completion event was seen.
  const resumedPane = cyclePanes.at(-1), resumedKey = `remote:cache-${resumedPane}`;
  histories.get(resumedKey).at(-1).text = 'Completed while browser was away';
  historyRevisions.set(resumedKey, 100);
  const resumeStarted = Date.now(), beforeResumeReads = reads.length;
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
  try {
    await paneFor(resumedPane).getByText('Completed while browser was away', { exact: true }).waitFor({ timeout: 5_000 });
  } catch (error) {
    console.error(JSON.stringify({ label: 'focus-resume-failure', resumedKey, elapsedMs: Date.now() - resumeStarted,
      activeReads: active, errors: errors.slice(-10), reads: reads.slice(Math.max(0, beforeResumeReads - sessionCount * 2)),
      browser: await page.evaluate(key => {
        const pane = [...document.querySelectorAll('[data-session-pane]')].find(el => el.dataset.sessionPane === key);
        const cached = window.__cacheHarness.readCachedMessages(key);
        return { visibility: document.visibilityState, focused: document.hasFocus(), controllers: window.__controllers,
          paneMounted: !!pane, paneBounds: pane?.getBoundingClientRect().toJSON(),
          lastChatText: pane?.querySelector('[data-message-search-id="chat-239"]')?.textContent?.slice(-500),
          cache: cached && { revision: cached.revision, lastText: cached.messages.at(-1)?.text?.slice(-200) } };
      }, resumedKey) }));
    throw error;
  }
  assert.ok(reads.slice(beforeResumeReads).some(read => read.key === resumedKey));
  await sample('focus-resume-latest-visible', { latestVisibleMs: Date.now() - resumeStarted });
  // Diagnostic only, after normal samples. Never used to make production metrics look smaller.
  await cdp.send('HeapProfiler.collectGarbage'); await sample('diagnostic-post-gc');

  const surface = paneFor(0).locator('.message-selection-surface');
  for (let i = 0; i < 8 && await paneFor(0).locator('[data-message-search-id^="chat-"]').count() < 240; i++) {
    await surface.evaluate(el => { el.scrollTop = 180; }); await delay(50);
    await surface.evaluate(el => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: -500 })); el.scrollTop = 40; });
    await delay(300);
  }
  await paneFor(0).locator('[data-message-search-id="chat-0"]').waitFor();
  assert.equal(await paneFor(0).locator('[data-message-search-id^="chat-"]').count(), 240);
  console.log(JSON.stringify({ label: 'cached-history-explicit-reachability', chats: 240, tools: await paneFor(0).locator('.desktop-tool-chip').count() }));

  for (let i = 0; i < sessionCount; i++) await paneFor(i).getByRole('button', { name: 'Close pane', exact: true, includeHidden: true }).evaluate(button => button.click());
  await page.waitForFunction(() => window.__controllers.active === 0 && document.querySelectorAll('[data-session-pane]').length === 0);
  await delay(1500);
  const allClosed = await sample('all-sessions-closed');
  assert.equal(allClosed.chats, 0); assert.equal(allClosed.tools, 0); assert.equal(allClosed.panes, 5, 'independent notebooks remain mounted');
  assert.equal(allClosed.controllers.created, allClosed.controllers.disposed);
  assert.equal(allClosed.activeReads, 0);
  // Closing sessions intentionally leaves the five independent notebook panes.
  // Each mounted CaptionOverflow owns an observer as well as its editor's
  // MutationObserver. Check exact ownership, then unmount those owners too.
  assert.deepEqual(allClosed.observers.ResizeObserver, {
    active: 6, targets: 21, kinds: {
      'DIV.session-pane-caption': 5,
      'DIV.caption-overflow-content': 5,
      'BUTTON.session-pane-drag': 5,
      'DIV.caption-overflow': 5,
      'DIV.session-workspace-surface': 1,
    },
  }, 'only mounted notebook captions and workspace surface retain resize observers');
  assert.equal(allClosed.observers.IntersectionObserver.targets, sessionCount, 'only session-list visibility remains');
  assert.equal(allClosed.observers.MutationObserver.active, 11, 'document plus five notebook captions and editors remain');
  const closedReads = reads.length;
  await delay(2500);
  assert.equal(reads.length, closedReads, 'closed sessions do not keep fetching history');

  for (let i = 0; i < 5; i++) {
    const notebook = page.locator('[data-workspace-pane]').first();
    assert.equal(await notebook.locator('.tiptap.ProseMirror').count(), 1, 'remaining pane is a notebook');
    await notebook.getByRole('button', { name: 'Close pane', exact: true, includeHidden: true }).evaluate(button => button.click());
    await page.waitForFunction(count => document.querySelectorAll('[data-workspace-pane]').length === count, 4 - i);
  }
  await delay(1500);
  const allCardsClosed = await sample('all-cards-closed');
  assert.equal(allCardsClosed.panes, 0);
  assert.equal(allCardsClosed.controllers.active, 0);
  assert.equal(allCardsClosed.activeReads, 0);
  assert.deepEqual(allCardsClosed.observers.ResizeObserver, {
    active: 1, targets: 1, kinds: { 'DIV.session-workspace-surface': 1 },
  }, 'all caption observers are released when their panes close');
  assert.deepEqual(allCardsClosed.observers.MutationObserver, {
    active: 1, targets: 1, kinds: { '#document.': 1 },
  }, 'all notebook editor observers are released');
  assert.deepEqual(allCardsClosed.observers.IntersectionObserver, allClosed.observers.IntersectionObserver,
    'only the unchanged session-list visibility observers remain');
  assert.equal(reads.length, closedReads, 'closing notebooks does not restart closed session reads');

  const micro = await page.evaluate(() => {
    const api = window.__cacheHarness;
    api.clearAllCachedData();
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: `micro-${i}`, sessionKey: 'synthetic', role: 'assistant',
      createdAt: i, text: `Cached text ${i}: ` + '工具输出'.repeat(24) }));
    for (let i = 0; i < 17; i++) api.writeCachedMessages(`micro:${i}`, rows, { hiddenCount: 40, updatedAt: 123 });
    window.__cache = {};
    for (let pass = 0; pass < 3; pass++) for (let i = 0; i < 17; i++) api.writeCachedMessages(`micro:${i}`, rows, { hiddenCount: 40, updatedAt: 123 });
    const measured = structuredClone(window.__cache);
    const valid = Array.from({ length: 17 }, (_, i) => api.readCachedMessages(`micro:${i}`)).every(entry =>
      entry?.messages.length === 200 && entry.hiddenCount === 40 && entry.updatedAt === 123 && entry.messages.at(-1).text === rows.at(-1).text);
    api.clearCachedMessages('micro:0'); const removed = !api.readCachedMessages('micro:0');
    api.clearCachedNodeData(new Set(['micro']));
    const revoked = Array.from({ length: 17 }, (_, i) => api.readCachedMessages(`micro:${i}`)).every(entry => !entry);
    return { measured, valid, removed, revoked };
  });
  assert.ok(micro.valid && micro.removed && micro.revoked);
  assert.equal(micro.measured.bounds.calls, 51);
  assert.equal(micro.measured.bounds.parses, baseline ? 867 : 0);
  assert.equal(micro.measured.write.stringifies, fittingBaseline ? 510 : 102);
  console.log(JSON.stringify({ label: 'cache-write-microbenchmark', baseline: !!baseline, ...micro }));
  }
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  await context.close();
} finally {
  await browser?.close(); await server?.close(); await rm(output, { recursive: true, force: true });
}
