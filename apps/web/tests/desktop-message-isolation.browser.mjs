// Real desktop application with synthetic, paginated history. Instrumentation
// and the boundary-disabled control exist only in a temporary build.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, preview } from 'vite';
import { resourceCaption } from './resource-caption.mjs';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const output = await mkdtemp(join(tmpdir(), 'agentopsdeck-message-isolation-'));
const baseline = process.env.AOD_MESSAGE_BASELINE === '1';
// Isolates incremental derivation, leaving memo boundaries/layout unchanged.
const derivationBaseline = process.env.AOD_DERIVATION_BASELINE === '1';
const layoutChecks = process.env.AOD_HISTORY_LAYOUT_CHECKS === '1';
const layoutBaseline = process.env.AOD_HISTORY_LAYOUT_BASELINE === '1';
// Optional previous-controller snapshot, applied ONLY to this temporary build.
// Unlike layoutBaseline this keeps the prior offscreen optimization enabled.
const controllerBaseline = process.env.AOD_HISTORY_LAYOUT_CONTROLLER;
const controllerSource = controllerBaseline ? await readFile(controllerBaseline, 'utf8') : undefined;
let browser, server;
try {
  await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'error', plugins: [{
    name: 'message-render-counters', enforce: 'pre', transform(code, id) {
      if (derivationBaseline && id.endsWith('/src/main.tsx')) {
        assert.ok(code.includes('useMemo(() => createDesktopMessageProjector(), [session.sessionKey])'));
        return code.replace('useMemo(() => createDesktopMessageProjector(), [session.sessionKey])', 'useMemo(() => desktopMessageItems, [session.sessionKey])')
          .replace('useMemo(() => createMessageSearch(messageSearchText), [session.sessionKey])', 'useMemo(() => ({ search: messageSearchMatches }), [session.sessionKey])');
      }
      if (layoutChecks && id.endsWith('/src/lib/desktop-history-layout.ts')) {
        code = controllerSource ?? code;
        const marker = 'const protectedRow =';
        assert.ok(code.includes(marker), 'controller work counter');
        return code.replace(marker, '(root as any).__historyLayoutVisits = ((root as any).__historyLayoutVisits ?? 0) + 1;\n      ' + marker)
          .replace('dirty.add(row); waiting.delete(row);', '(root as any).__historyInvalidations = ((root as any).__historyInvalidations ?? 0) + 1; dirty.add(row); waiting.delete(row);')
          + '\n(window as any).observeHistoryLayoutForTest = observeDesktopHistoryLayout;';
      }
      if (layoutBaseline && id.endsWith('/src/main.tsx')) {
        const effect = 'useEffect(() => observeDesktopHistoryLayout(scrollContainerRef.current), []);';
        assert.ok(code.includes(effect));
        return code.replace(effect, 'useEffect(() => () => {}, []);');
      }
      if (id.endsWith('/src/components/messages.tsx')) {
        const classify = 'const classifyMessageForDisplay = memoizeMessageClassification(message => {';
        assert.ok(code.includes(classify));
        code = code.replace(classify, classify + '\n(window as any).messageCounters.classifications++;');
        for (const name of ['desktopMessageItems', 'DesktopMessageBubbleContent', 'DesktopToolTimelineContent']) {
          const marker = new RegExp(`(function ${name}\\([^\\n]*\\{\\n)`);
          assert.ok(marker.test(code), name);
          code = code.replace(marker, `$1(window as any).messageCounters.${name}++;\n`);
        }
        const mount = '  const rawText = readableText(message.text);';
        // Count only the desktop bubble, not identically named locals elsewhere.
        const start = code.indexOf('function DesktopMessageBubbleContent(');
        code = code.slice(0, start) + code.slice(start).replace(mount, `${mount}
          useEffect(() => { (window as any).messageCounters.mounts++; return () => { (window as any).messageCounters.unmounts++; }; }, []);`);
        if (baseline) for (const name of ['DesktopMessageWithTools', 'DesktopToolTimeline', 'DesktopMessageBubble']) {
          const memo = `= React.memo(function ${name}(`;
          assert.ok(code.includes(memo));
          code = code.replace(memo, `= (function ${name}(`);
        }
        return code;
      }
      if (baseline && id.endsWith('/src/lib/use-message-history.ts')) {
        const memo = 'useMemo(() => expanded ? messages : visibleMessages(messages), [expanded, messages])';
        assert.ok(code.includes(memo));
        return code.replace(memo, '(expanded ? messages : visibleMessages(messages))');
      }
      if (baseline && id.endsWith('/src/main.tsx')) {
        assert.ok(code.includes('const desktopQueueControls = useMemo'));
        assert.ok(code.includes('const handleDesktopMediaLoad = useCallback'));
        assert.ok(code.includes(', desktopQueueControls, handleDesktopMediaLoad]'));
        return `const bypassMemo = (factory: any, _deps: any) => factory();
          const bypassCallback = (callback: any, _deps: any) => callback;\n` + code
          .replace('const desktopQueueControls = useMemo', 'const desktopQueueControls = bypassMemo')
          .replace('const handleDesktopMediaLoad = useCallback', 'const handleDesktopMediaLoad = bypassCallback')
          // Previously these values were inline inside the memoized pane.
          // Leaving their new dependencies here creates a worse-than-original
          // control once expanded history already has stable array identity.
          .replace(', desktopQueueControls, handleDesktopMediaLoad]', ']');
      }
    },
  }], build: { outDir: output, emptyOutDir: false } });
  server = await preview({ root, configFile: false, envFile: false, logLevel: 'error', build: { outDir: output }, preview: { host: '127.0.0.1', port: 0 } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 1800, height: 1000 }, serviceWorkers: 'block' });
  const sessions = ['one', 'two'].map(id => ({ sessionKey: `remote:${id}`, envConnectionId: 'remote', title: `Fixture ${id}`, source: 'codex', agentId: 'codex', status: 'idle', lastActiveAt: 1 }));
  const histories = new Map(sessions.map(session => [session.sessionKey, Array.from({ length: 2000 }, (_, i) => [
    ...(i % 10 === 0 ? [{ id: `tool-${i}`, sessionKey: session.sessionKey, role: 'tool', createdAt: i * 2, status: 'sent', text: `Synthetic tool output ${i}` }] : []),
    { id: `chat-${i}`, sessionKey: session.sessionKey, role: 'assistant', createdAt: i * 2 + 1, status: 'sent', text: `History ${session.sessionKey} ${i}\n\nRetained **searchable** text.${layoutChecks ? `\n\n${'Variable width paragraph with preserved selection and geometry. '.repeat(i % 7 + 1)}\n\n- List entry\n- Second entry\n\n\`inline code\`` : ''}` },
  ]).flat()]));
  const errors = [], denied = [], reads = [], layouts = new Map();
  let revision = 1;
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
    // This POST is a read projection, never a message/execution write.
    if (url.pathname === '/api/hub/v1/completions/summary' && request.method() === 'POST') {
      const body = request.postDataJSON();
      assert.deepEqual(Object.keys(body), ['sessions']);
      assert.ok(Array.isArray(body.sessions) && body.sessions.every(key => sessions.some(session => session.sessionKey === key)));
      return json({ items: [] });
    }
    if (request.method() !== 'GET') { denied.push(`${request.method()} ${url.pathname}`); return route.abort(); }
    if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } });
    if (url.pathname.endsWith('/sessions/state')) return json({ groups: [{ agentId: 'codex', sessions }], revision: '1' });
    if (url.pathname.endsWith('/messages')) {
      const key = decodeURIComponent(url.pathname.split('/').at(-2)), all = histories.get(key);
      const limit = Number(url.searchParams.get('limit')), before = url.searchParams.get('before');
      assert.ok(limit > 0 && limit <= 500);
      const end = before ? all.findIndex(row => row.id === before) : all.length;
      assert.ok(end >= 0);
      const start = Math.max(0, end - limit);
      reads.push({ key, before });
      return json({ messages: all.slice(start, end), totalCount: all.length, hiddenCount: start, revision: String(revision) });
    }
    if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
    if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
    if (url.pathname === '/api/gateway/status') return json({ connected: true });
    return route.fulfill({ status: 404, json: {} });
  });
  await context.addInitScript(() => {
    localStorage.setItem('agentopsdeck.locale', 'en');
    localStorage.setItem(`agentopsdeck.current-layout.v2:${'a'.repeat(64)}`, JSON.stringify({ id: 'current', name: 'Current', collapsedKeys: [], workspace: {
      version: 1, panes: ['one', 'two'].map(id => ({ id, sessionKey: `remote:${id}` })), floating: [], active: 'one',
      dock: { kind: 'split', axis: 'horizontal', ratio: 0.5, first: { kind: 'pane', id: 'one' }, second: { kind: 'pane', id: 'two' } },
    } }));
    window.messageCounters = { desktopMessageItems: 0, classifications: 0, DesktopMessageBubbleContent: 0, DesktopToolTimelineContent: 0, mounts: 0, unmounts: 0 };
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copiedMessage = text; } } });
    window.EventSource = class extends EventTarget {
      readyState = 1; static OPEN = 1; static CONNECTING = 0; static CLOSED = 2;
      constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); }
      close() { this.readyState = 2; }
    };
  });
  const page = await context.newPage(); page.setDefaultTimeout(25_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  for (const session of sessions) await page.locator(`[data-session-card="${session.sessionKey}"]`).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-message-search-id]').length === 400);
  const first = page.locator('[data-workspace-pane]').filter({ has: page.locator('[data-session-pane="remote:one"]') });
  const firstCaptionButton = async name => {
    const caption = first.locator('.session-pane-caption');
    const button = caption.getByRole('button', { name, exact: true });
    // A fitting action is already usable. Opening its unrelated native overflow
    // first adds a second popover lifecycle that a normal inline click does not.
    if (!await button.isVisible()) await resourceCaption(first.locator('[data-session-pane="remote:one"]'));
    return button;
  };
  const pane = first.locator('.message-selection-surface');
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const snapshot = () => page.evaluate(() => structuredClone(window.messageCounters));
  const delta = (before, after) => Object.fromEntries(Object.keys(before).map(key => [key, after[key] - before[key]]));
  const results = [];
  const memoryCdp = await context.newCDPSession(page);
  await memoryCdp.send('Performance.enable');
  async function memorySample(label) {
    await memoryCdp.send('HeapProfiler.collectGarbage');
    const metrics = Object.fromEntries((await memoryCdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
    console.log(JSON.stringify({ retainedResources: { label, heapBytes: metrics.JSHeapUsedSize, nodes: metrics.Nodes,
      ...(await page.evaluate(() => ({ elements: document.querySelectorAll('*').length, rows: document.querySelectorAll('[data-message-search-id]').length }))) } }));
  }
  async function measure(label) {
    await page.locator('[data-session-card="remote:one"]').click();
    await first.locator('.desktop-composer-dock').hover();
    const draft = first.locator('textarea').first();
    await draft.fill('preserve unsent draft'); await page.waitForTimeout(350);
    const beforeTyping = await snapshot();
    for (let i = 0; i < 12; i++) { await draft.fill(`preserve unsent draft ${i}`); await settle(); }
    const typing = delta(beforeTyping, await snapshot());
    if (!baseline) assert.equal(typing.DesktopMessageBubbleContent, 0, 'typing leaves existing bubbles alone');
    assert.equal(typing.mounts + typing.unmounts, 0);
    await (await firstCaptionButton('Search messages')).click();
    const search = page.getByRole('textbox', { name: 'Search messages', exact: true });
    await settle();
    const beforeSearch = await snapshot();
    const rowCount = await pane.locator('[data-message-search-id]').count();
    for (let i = 0; i < 6; i++) {
      await search.fill(i % 2 ? 'searchable' : 'History remote:one 1999');
      // Deferred search can take more than two frames in the unoptimized
      // 2000-row control. Wait for its committed result, not a timing guess.
      await page.waitForFunction(expected => document.querySelectorAll('[data-session-pane="remote:one"] [data-message-search-id][class*="ring-amber"]').length === expected, i % 2 ? rowCount : 1);
      await settle();
    }
    assert.ok(await pane.locator('[data-message-search-id][class*="ring-amber"]').count() > 0, 'search highlights still update');
    await search.fill('');
    await page.waitForFunction(() => !document.querySelector('[data-session-pane="remote:one"] [data-message-search-id][class*="ring-amber"]'));
    await search.press('Escape'); await settle();
    const searching = delta(beforeSearch, await snapshot());
    if (!baseline) {
      assert.equal(searching.DesktopMessageBubbleContent, 0, 'search updates frames, not bubble bodies');
      assert.equal(searching.DesktopToolTimelineContent, 0, 'search preserves tool contents');
      assert.equal(searching.desktopMessageItems, 0, 'search does not regroup history');
    } else assert.ok(searching.DesktopMessageBubbleContent > 0, 'control actually disables isolation');
    assert.equal(searching.mounts + searching.unmounts, 0);
    assert.equal(await draft.inputValue(), 'preserve unsent draft 11');
    results.push({ label, rows: await page.locator('[data-message-search-id]').count(), typing, searching });
    console.log(JSON.stringify(results.at(-1)));
  }
  await measure('initial200');
  await memorySample('twoPanes200');
  // Expand both histories through real bounded older-page requests.
  for (const session of sessions) {
    const surface = page.locator(`[data-session-pane="${session.sessionKey}"] .message-selection-surface`);
    for (let i = 0; i < 16 && !await surface.locator('[data-message-search-id="chat-0"]').count(); i++) {
      const count = await surface.locator('[data-message-search-id]').count();
      await surface.evaluate(el => { el.scrollTop = 180; }); await settle();
      await surface.evaluate(el => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true })); el.scrollTop = 40; });
      await page.waitForFunction(({ key, count }) => document.querySelector(`[data-session-pane="${key}"]`).querySelectorAll('[data-message-search-id]').length > count, { key: session.sessionKey, count });
      await settle();
    }
    assert.equal(await surface.locator('[data-message-search-id]').count(), 2000);
  }
  await measure('expanded2000');
  await memorySample('twoPanes2000');
  // Search/copy and existing node identity survive a changed latest snapshot.
  await pane.locator('[data-message-search-id="chat-0"]').scrollIntoViewIfNeeded();
  await pane.locator('[data-message-search-id="chat-0"] button[aria-label="Copy message"]').click();
  assert.match(await page.evaluate(() => window.copiedMessage), /History remote:one 0/);
  await page.evaluate(() => {
    const row = document.querySelector('[data-session-pane="remote:one"] [data-message-search-id="chat-0"]');
    window.savedRow = row;
    // Select message content, not the transient aria-live "Copied" action
    // status which legitimately expires while a long-history refresh runs.
    window.getSelection().removeAllRanges(); const range = document.createRange(); range.selectNodeContents(row.querySelector('.markdown-body')); window.getSelection().addRange(range);
  });
  const selected = await page.evaluate(() => window.getSelection().toString());
  const all = histories.get('remote:one');
  all[all.length - 1] = { ...all.at(-1), text: 'Updated latest reply with **new content**.' }; revision++;
  await (await firstCaptionButton('Force refresh messages')).click();
  await page.waitForFunction(() => document.querySelector('[data-session-pane="remote:one"] [data-message-search-id="chat-1999"]')?.textContent.includes('Updated latest reply'));
  assert.equal(await pane.locator('[data-message-search-id]').count(), 2000);
  assert.ok(await page.evaluate(() => window.savedRow === document.querySelector('[data-session-pane="remote:one"] [data-message-search-id="chat-0"]')));
  assert.equal(await page.evaluate(() => window.getSelection().toString()), selected);
  assert.ok(await pane.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop > 100), 'refresh respects reading position');
  // Once copy status has expired, isolate four real HTTP history updates. The
  // route serializes fresh objects, so this also verifies snapshot sharing.
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await page.waitForTimeout(2000);
  const beforeStream = await snapshot();
  for (let i = 0; i < 4; i++) {
    all[all.length - 1] = { ...all.at(-1), text: `Stream update ${i}` }; revision++;
    await (await firstCaptionButton('Force refresh messages')).click();
    await page.waitForFunction(i => document.querySelector('[data-session-pane="remote:one"] [data-message-search-id="chat-1999"]')?.textContent.includes(`Stream update ${i}`), i);
    await settle();
  }
  const stream = delta(beforeStream, await snapshot());
  if (!baseline && !derivationBaseline) {
    assert.equal(stream.DesktopToolTimelineContent, 0, 'unchanged historical tool groups retain array identity');
    assert.equal(stream.classifications, 4, 'only changed message objects are classified');
    assert.equal(stream.mounts + stream.unmounts, 0);
  }
  console.log(JSON.stringify({ streamingDerivation: { derivationBaseline, updates: 4, ...stream } }));
  await memorySample('twoPanes2000AfterUpdates');
  if (layoutChecks) {
    const { checkHistoryLayout, checkHistoryLayoutLifecycle, checkHistoryLayoutWork, checkHistoryPaneActivation } = await import('./fixtures/history-layout.mjs');
    await checkHistoryLayout({ page, context, pane, first, baseline: layoutBaseline, richTools: !controllerBaseline });
    if (!layoutBaseline && !controllerBaseline) await checkHistoryPaneActivation({ page, pane });
    if (!layoutBaseline) {
      await checkHistoryLayoutWork({ page, incremental: !controllerBaseline });
      await checkHistoryLayoutLifecycle({ page, incremental: !controllerBaseline });
    }
  }
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  console.log(JSON.stringify({ baseline, results, historyReads: reads.length, errors, denied, retainedSelection: true, updatedReply: true }));
} finally {
  await browser?.close(); await server?.close();
  await rm(output, { recursive: true, force: true });
}
