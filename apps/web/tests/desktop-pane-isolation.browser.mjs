// Real application, synthetic API only. Counters exist only in the temporary
// instrumented build; the optional control removes the two isolation boundaries.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, preview } from 'vite';

const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const root = fileURLToPath(new URL('..', import.meta.url));
const output = await mkdtemp(join(tmpdir(), 'agentopsdeck-pane-isolation-'));
const baseline = process.env.AOD_PERF_BASELINE === '1';
const summaryBaseline = process.env.AOD_SUMMARY_BASELINE === '1';
let browser, server;
try {
  await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'error', plugins: [{
    name: 'pane-render-counters', enforce: 'pre', transform(code, id) {
      if (!id.endsWith('/src/main.tsx')) return;
      const marker = '  const latestSession = useRef(session);';
      assert.equal(code.split(marker).length, 2);
      code = code.replace(marker, `
        const counters = (window as any).paneCounters;
        counters.renders[session.sessionKey] = (counters.renders[session.sessionKey] || 0) + 1;
        useEffect(() => { counters.mounts++; return () => { counters.unmounts++; }; }, []);
        ${marker}`);
      code = code.replace('  const allSessions = useMemo(', `
        useEffect(() => {
          (window as any).summaryRevision = sessionsState.revision;
          (window as any).summarySelection = selected && { key: selected.sessionKey, title: selected.title };
        }, [sessionsState, selectedKey]);
        const allSessions = useMemo(`);
      // Isolate list invalidation from window focus, which intentionally also
      // refreshes each pane's own message history and read-health state.
      const refreshMarker = '  const { boost: boostSessionRefresh, schedule: scheduleSessionRefresh, prioritize: prioritizeSessionRefresh, complete: completeSessionRefresh } = useAdaptiveSessionRefresh(refresh);';
      assert.ok(code.includes(refreshMarker));
      code = code.replace(refreshMarker, `${refreshMarker}
        useEffect(() => {
          const listener = () => { void refresh(); };
          const dismiss = (event: Event) => dismissSessionView((event as CustomEvent<string>).detail);
          window.addEventListener('test-summary-refresh', listener);
          window.addEventListener('test-summary-dismiss', dismiss);
          return () => {
            window.removeEventListener('test-summary-refresh', listener);
            window.removeEventListener('test-summary-dismiss', dismiss);
          };
        }, [refresh, dismissSessionView]);`);
      if (summaryBaseline) {
        assert.ok(code.includes('setSessionsState(current => shareSessionSummaries(current, sessionData))'));
        code = code.replace('setSessionsState(current => shareSessionSummaries(current, sessionData))', 'setSessionsState(sessionData)')
          .replace('[dismissedPanes, selectSession]', '[dismissedPanes, allSessions, selectSession]');
      }
      if (baseline) {
        assert.ok(code.includes('const DesktopSessionPane = memo(function DesktopSessionPane'));
        assert.ok(code.includes('renderPane={renderSessionPane}'));
        code = code.replace('const DesktopSessionPane = memo(function DesktopSessionPane', 'const DesktopSessionPane = (function DesktopSessionPane')
          .replace('renderPane={renderSessionPane}', 'renderPane={session => renderSessionPane(session)}');
      }
      return code;
    },
  }], build: { outDir: output, emptyOutDir: false } });
  server = await preview({ root, configFile: false, envFile: false, logLevel: 'error', build: { outDir: output }, preview: { host: '127.0.0.1', port: 0 } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 1800, height: 1000 }, serviceWorkers: 'block' });
  let revision = 1;
  let sourceAuthority = 1, sourceState = 'ready';
  const sessions = ['one', 'two', 'three'].map(id => ({ sessionKey: `remote:${id}`, envConnectionId: 'remote', title: `Fixture ${id}`, source: id === 'two' ? 'ghcp' : 'codex', controlCapabilities: { compact: true, attachments: true }, agentId: 'codex', status: 'idle', lastActiveAt: 1 }));
  const errors = [], denied = [], reads = [], layouts = new Map();
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { denied.push(url.href); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = body => route.fulfill({ json: body });
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
    if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } });
    if (url.pathname.endsWith('/sessions/state')) return json({ groups: sourceState === 'ready' ? [{ agentId: 'codex', sessions }] : [], revision: String(revision), viewKey: 'fixture/default',
      sourceStates: [{ connectionId: 'remote', authority: sourceAuthority, state: sourceState, cursor: `ce1_00000000-0000-4000-8000-000000000001:${revision}`, hiddenCount: 0, archivedCount: 0, pinnedCount: 0 }] });
    if (url.pathname.endsWith('/messages')) {
      const key = decodeURIComponent(url.pathname.split('/').at(-2)); reads.push(key);
      return json({ messages: Array.from({ length: 200 }, (_, i) => ({ id: `${key}-${i}`, sessionKey: key, role: 'assistant', createdAt: i + 1, status: 'sent', text: `History ${key} ${i}\n\n${'Retained searchable text. '.repeat(i % 8 + 1)}` })), totalCount: 200, hiddenCount: 0, revision: '1' });
    }
    if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
    if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
    if (url.pathname === '/api/gateway/status') return json({ connected: true });
    return route.fulfill({ status: 404, json: {} });
  });
  await context.addInitScript(() => {
    localStorage.setItem('agentopsdeck.locale', 'en');
    localStorage.setItem(`agentopsdeck.current-layout.v2:${'a'.repeat(64)}`, JSON.stringify({
      id: 'current', name: 'Current', collapsedKeys: [], workspace: {
        version: 1, panes: ['one', 'two', 'three'].map(id => ({ id, sessionKey: `remote:${id}` })),
        floating: [], active: 'three', dock: { kind: 'split', axis: 'horizontal', ratio: 0.5,
          first: { kind: 'pane', id: 'one' }, second: { kind: 'split', axis: 'vertical', ratio: 0.5,
            first: { kind: 'pane', id: 'two' }, second: { kind: 'pane', id: 'three' } } },
      },
    }));
    window.paneCounters = { renders: {}, mounts: 0, unmounts: 0 };
    window.EventSource = class extends EventTarget {
      readyState = 1; static OPEN = 1; static CONNECTING = 0; static CLOSED = 2;
      constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); }
      close() { this.readyState = 2; }
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  for (const session of sessions) await page.locator(`[data-session-card="${session.sessionKey}"]`).click();
  console.log('opened fixture panes');
  await page.waitForFunction(() => document.querySelectorAll('[data-message-search-id]').length === 600);
  const panes = page.locator('[data-session-pane]');
  const first = page.locator('[data-workspace-pane]').filter({ has: page.locator('[data-session-pane="remote:one"]') });
  const draft = first.locator('textarea').first();
  await first.locator('.desktop-composer-dock').hover();
  await draft.fill('preserve unsent draft');
  await page.locator('[data-session-card="remote:three"]').click();
  await page.waitForTimeout(1200);
  await page.evaluate(() => { window.originalPanes = [...document.querySelectorAll('[data-session-pane]')]; });
  const snapshot = () => page.evaluate(() => structuredClone(window.paneCounters));
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const refreshSummary = async () => {
    revision++;
    await page.evaluate(() => window.dispatchEvent(new Event('test-summary-refresh')));
    await page.waitForFunction(expected => window.summaryRevision === expected, String(revision));
    await settle();
  };
  const deltas = (before, after) => Object.fromEntries(sessions.map(s => [s.sessionKey, (after.renders[s.sessionKey] || 0) - (before.renders[s.sessionKey] || 0)]));
  const before = await snapshot();
  const search = page.getByRole('textbox', { name: 'Search sessions', exact: true });
  for (let i = 0; i < 12; i++) { await search.fill(i % 2 ? 'Fixture' : 'Fixture one'); await settle(); }
  await search.fill(''); await settle();
  const after = await snapshot();
  const searchRenders = Object.fromEntries(sessions.map(s => [s.sessionKey, (after.renders[s.sessionKey] || 0) - (before.renders[s.sessionKey] || 0)]));
  if (!baseline) assert.deepEqual(Object.values(searchRenders), [0, 0, 0], 'sidebar search does not render controllers');
  else assert.ok(Object.values(searchRenders).every(n => n > 0));
  // Active state still propagates, while the third pane is not involved.
  await page.locator('[data-session-card="remote:one"]').click(); await settle();
  const selected = await snapshot();
  assert.ok(selected.renders['remote:one'] > after.renders['remote:one']);
  assert.ok(selected.renders['remote:three'] > after.renders['remote:three']);
  if (!baseline) assert.equal(selected.renders['remote:two'], after.renders['remote:two']);
  const readCount = reads.filter(key => key === 'remote:one').length;
  await first.getByRole('button', { name: 'Force refresh messages', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-session-pane="remote:one"]').closest('[data-workspace-pane]').querySelector('button[aria-label="Force refresh messages"]').disabled);
  assert.ok(reads.filter(key => key === 'remote:one').length > readCount, 'manual refresh remains live');
  await settle();
  const beforeNoop = await snapshot();
  await refreshSummary();
  const noopRenders = deltas(beforeNoop, await snapshot());
  if (!baseline && !summaryBaseline) assert.deepEqual(Object.values(noopRenders), [0, 0, 0], 'new revision with identical rows does not render controllers');
  else assert.ok(Object.values(noopRenders).every(n => n > 0));
  // A fresh complete summary must pass through, including execution protection.
  const beforeMetadata = await snapshot();
  sessions[0] = { ...sessions[0], title: 'Updated fixture', status: 'running', hasActiveRun: true, runtime: { phase: 'running', sync: 'ready', turnId: 'new-turn', stopRequested: false } };
  await refreshSummary();
  await page.waitForFunction(() => document.querySelector('[data-session-card="remote:one"]')?.textContent.includes('Updated fixture'));
  assert.ok(await first.getByRole('button', { name: 'Stop current run', exact: true }).isEnabled());
  const metadataRenders = deltas(beforeMetadata, await snapshot());
  assert.ok(metadataRenders['remote:one'] > 0);
  if (!baseline && !summaryBaseline) assert.deepEqual([metadataRenders['remote:two'], metadataRenders['remote:three']], [0, 0], 'changed session does not render siblings');
  sessions[0] = { ...sessions[0], title: 'Protected fixture', runtime: { ...sessions[0].runtime, stopRequested: true } };
  await refreshSummary();
  await page.waitForFunction(() => document.querySelector('[data-session-card="remote:one"]')?.textContent.includes('Protected fixture'));
  assert.ok(await first.getByRole('button', { name: 'Stop current run', exact: true }).isDisabled());
  const second = page.locator('[data-session-pane="remote:two"]');
  // Inactive panes keep their composer dock hidden; inspect the retained
  // control without changing pane focus as part of this capability assertion.
  const attach = second.locator('button[aria-label="Attach file"]');
  assert.ok(await attach.isEnabled());
  sessions[1] = { ...sessions[1], title: 'Latest second title', controlCapabilities: { compact: false, attachments: false } };
  await refreshSummary();
  assert.ok(await attach.isDisabled(), 'capability revocation reaches existing pane');
  delete sessions[1].controlCapabilities;
  await refreshSummary();
  assert.ok(await attach.isDisabled(), 'removed capability is not merged back');
  for (const [button, hidden, archived] of [['Show hidden', true, false], ['Show archived', true, true], ['Hide hidden', false, true], ['Hide archived', false, false]]) {
    const response = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname.endsWith('/sessions/state') && url.searchParams.has('includeHidden') === hidden && url.searchParams.has('includeArchived') === archived;
    });
    await page.getByRole('button', { name: button, exact: true }).click(); await response;
  }
  assert.equal(await draft.inputValue(), 'preserve unsent draft');
  assert.equal(await panes.count(), 3);
  assert.ok(await page.evaluate(() => window.originalPanes.every((node, i) => node === document.querySelectorAll('[data-session-pane]')[i])));
  const final = await snapshot();
  assert.equal(final.mounts, before.mounts); assert.equal(final.unmounts, before.unmounts);
  // Test-only CSS trial: unknown variable-height rows cannot safely use a single
  // intrinsic estimate. Do not include this style in the product bundle.
  const surface = first.locator('.message-selection-surface');
  const geometry = () => surface.evaluate(el => ({ height: el.scrollHeight, top: el.scrollTop,
    tail: el.querySelector('[data-message-search-id="remote:one-199"]').getBoundingClientRect().top - el.getBoundingClientRect().top }));
  await surface.evaluate(el => { el.scrollTop = el.scrollHeight; }); await settle();
  const originalGeometry = await geometry();
  const trialStyle = await page.addStyleTag({ content: '.message-selection-surface [data-message-search-id] { content-visibility: auto; contain-intrinsic-size: auto 120px; }' });
  await settle();
  const estimatedGeometry = await geometry();
  const findRetained = await page.evaluate(() => window.find('History remote:one 0'));
  await settle();
  const foundGeometry = await geometry();
  await trialStyle.evaluate(el => el.remove());
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await settle();
  console.log(JSON.stringify({ cssTrial: { originalGeometry, estimatedGeometry, findRetained, foundGeometry, shipped: false } }));
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  console.log(JSON.stringify({ baseline, summaryBaseline, noopRenders, metadataRenders, searchRenders, selectionRenders: Object.fromEntries(sessions.map(s => [s.sessionKey, selected.renders[s.sessionKey] - after.renders[s.sessionKey]])), remounts: final.mounts - before.mounts, historyRows: await page.locator('[data-message-search-id]').count() }));
  // Exercise the actual dismissal handler after several newer snapshots. It
  // must select the latest committed fallback, not the closure's old summary.
  await page.locator('[data-session-card="remote:one"]').click();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-summary-dismiss', { detail: 'remote:one' })));
  await page.waitForFunction(() => window.summarySelection?.key === 'remote:two');
  assert.equal(await page.evaluate(() => window.summarySelection.title), 'Latest second title');
  assert.equal(await page.locator('[data-session-pane="remote:one"]').count(), 0);
  sourceAuthority++; sourceState = 'denied';
  await refreshSummary();
  await page.waitForFunction(() => document.querySelectorAll('[data-session-pane]').length === 0);
  assert.equal(await page.evaluate(() => window.summarySelection), undefined, 'source revocation clears active and cached pane selection');
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  console.log('capability removal, latest dismissal fallback and source revocation passed');
} finally {
  await browser?.close(); await server?.httpServer.close();
  await rm(output, { recursive: true, force: true });
}
