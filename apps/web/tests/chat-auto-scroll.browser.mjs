import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, preview } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT
  ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const builtRoot = process.env.AOD_TEST_WEB_ROOT;
const server = builtRoot
  ? await preview({ root: builtRoot, configFile: false, build: { outDir: builtRoot }, preview: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
  : await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false,
  plugins: [react(), tailwindcss()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
try {
  if (!builtRoot) await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true,
    ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const sessionKey = 'local:c3ludGhldGlj';
    const sourcePath = '/fixture/scroll-example.ts';
    const sourceUrl = `/api/hub/v1/sessions/${encodeURIComponent(sessionKey)}/messages/code/media/${'b'.repeat(64)}`;
    const session = { sessionKey, envConnectionId: 'local', title: 'Synthetic scroll chat', agentId: 'main', source: 'openclaw', status: 'idle', lastActiveAt: 1 };
    const otherSession = { ...session, sessionKey: 'local:b3RoZXI', title: 'Other synthetic chat' };
    let revision = 1;
    const message = (id, text) => ({ id, sessionKey, role: 'assistant', text, createdAt: 1000 + revision, status: 'sent' });
    let messages = Array.from({ length: 18 }, (_, i) => message(`initial-${i}`, `Initial ${i}\n\n${'Paragraph for scrolling. '.repeat(20)}`));
    const rejected = [], errors = [];
    let messageReads = 0;
    let paginate = false;
    const olderReads = [];
    let holdMessages = true;
    const heldMessages = [];
    const images = new Map();
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin === origin && req.method() === 'POST' && url.pathname === '/api/hub/v1/completions/summary') return route.fulfill({ json: { items: [] } });
      if (url.origin !== origin || req.method() !== 'GET') { rejected.push(req.url()); return route.abort(); }
      if (url.pathname.startsWith('/scroll-image-')) { images.set(url.pathname, route); return; }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = body => route.fulfill({ json: body });
      if (url.pathname === sourceUrl) return json({ path: sourcePath, line: 30, startLine: 1, totalLines: 80, modifiedAt: 1,
        text: Array.from({ length: 45 }, (_, i) => `const line${i + 1} = ${i};`).join('\n') });
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } });
      if (url.pathname === '/api/hub/v1/sessions/state') return json({ groups: [{ agentId: 'main', sessions: [session, otherSession] }], updatedAt: revision, revision: String(revision) });
      if (url.pathname.endsWith('/messages')) {
        if (decodeURIComponent(url.pathname).includes(otherSession.sessionKey)) return json({ messages: [{ ...message('other-message', 'Other session content'), sessionKey: otherSession.sessionKey }], hiddenCount: 0, updatedAt: revision, revision: `other-${revision}` });
        messageReads++;
        if (holdMessages) { heldMessages.push(route); return; }
        if (paginate) {
          const before = url.searchParams.get('before');
          if (before) olderReads.push(before);
          const end = before ? messages.findIndex(row => row.id === before) : messages.length;
          assert.ok(end >= 0, 'pagination anchor exists');
          const start = Math.max(0, end - Number(url.searchParams.get('limit') || 200));
          return json({ messages: messages.slice(start, end), hiddenCount: start, totalCount: messages.length, updatedAt: revision, revision: `${revision}:${before ?? 'latest'}` });
        }
        return json({ messages, hiddenCount: 0, updatedAt: revision, revision: String(revision) });
      }
      if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'main', name: 'Main' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return route.fulfill({ status: 404, json: { error: 'Not part of fixture' } });
    });
    await context.addInitScript(() => {
      localStorage.setItem('agentopsdeck.locale', 'en');
      localStorage.setItem('agentopsdeck.apiBaseUrl', location.origin);
      const streams = [];
      window.EventSource = class extends EventTarget {
        readyState = 1;
        static OPEN = 1; static CONNECTING = 0; static CLOSED = 2;
        constructor() { super(); streams.push(this); queueMicrotask(() => this.onopen?.(new Event('open'))); }
        close() { this.readyState = 2; }
      };
      window.scrollFixtureEvent = event => {
        for (const stream of streams) if (stream.readyState === 1) stream.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event), lastEventId: event.id }));
      };
      window.scrollFixtureStreams = () => streams.map(stream => stream.readyState);
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.locator(`[data-session-card="${sessionKey}"]`).click();
    const pane = page.locator('.message-selection-surface:visible');
    const latestNotice = page.locator('[data-latest-messages-loading]:visible');
    const releaseMessages = async (status = 200) => {
      holdMessages = false;
      assert.ok(heldMessages.length > 0, 'latest request is actually in flight');
      for (const route of heldMessages.splice(0)) await route.fulfill({ status, json: status === 200
        ? { messages, hiddenCount: 0, updatedAt: revision, revision: String(revision) }
        : { error: 'Synthetic latest read unavailable' } });
      await latestNotice.waitFor({ state: 'hidden' });
    };
    await latestNotice.waitFor();
    await releaseMessages();
    // Desktop refresh now belongs to the pane toolbar, not the old rail.
    if (viewport.width >= 700) {
      holdMessages = true;
      const refreshButton = page.getByRole('button', { name: 'Force refresh messages', exact: true });
      if (!await refreshButton.isVisible()) await page.getByRole('button', { name: 'Pane tools', exact: true }).click();
      await refreshButton.click();
      await page.keyboard.press('Escape');
      await latestNotice.waitFor();
      await releaseMessages();
    }
    const toggleAutoScroll = async name => {
      const toggle = page.getByRole('switch', { name, exact: true });
      // The desktop caption can put this control into its existing overflow.
      if (viewport.width >= 700 && !await toggle.isVisible()) await page.getByRole('button', { name: 'Pane tools', exact: true }).click();
      await toggle.click();
      if (viewport.width >= 700) await page.keyboard.press('Escape');
    };
    const metrics = () => pane.evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, gap: el.scrollHeight - el.clientHeight - el.scrollTop }));
    const bottom = async label => {
      await page.evaluate(() => { window.scrollFixtureBottomSince = undefined; });
      await page.waitForFunction(() => {
        const el = [...document.querySelectorAll('.message-selection-surface')].find(el => el.clientHeight);
        if (!el || el.scrollHeight <= el.clientHeight || Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) > 2) {
          window.scrollFixtureBottomSince = undefined;
          return false;
        }
        window.scrollFixtureBottomSince ??= performance.now();
        return performance.now() - window.scrollFixtureBottomSince >= 150;
      }).catch(async error => {
        await page.screenshot({ path: `/tmp/agentopsdeck-scroll-failure-${viewport.width}.png`, fullPage: true });
        const state = await pane.count() ? await metrics() : { missingPane: true, errors };
        throw new Error(`${label}: ${JSON.stringify(state)}`, { cause: error });
      });
      assert.ok(Math.abs((await metrics()).gap) <= 2, label);
    };
    const refresh = async () => {
      revision++;
      await page.evaluate(({ sessionKey, revision }) => window.scrollFixtureEvent({ id: `scroll-${revision}`, type: 'message.updated', sessionKey, ts: revision, payload: {} }), { sessionKey, revision });
    };
    const backgroundRead = async () => {
      for (let attempt = 0; !heldMessages.length && attempt < 100; attempt++) await page.waitForTimeout(50);
      assert.ok(heldMessages.length, 'background read actually started');
      assert.equal(await latestNotice.count(), 0, 'background reads never announce foreground loading');
    };
    const append = async (id, text, media) => {
      messages = [...messages, { ...message(id, text), ...(media ? { media } : {}) }];
      await refresh();
      await page.locator(`[data-message-search-id="${id}"]`).waitFor().catch(async error => {
        throw new Error(JSON.stringify({ id, messageReads, errors, state: await page.evaluate(() => ({
          visibility: document.visibilityState, streams: window.scrollFixtureStreams(),
          ids: [...document.querySelectorAll('[data-message-search-id]')].map(el => el.dataset.messageSearchId),
        })) }), { cause: error });
      });
    };
    const releaseImage = async id => {
      for (let attempt = 0; !images.has(`/scroll-image-${id}.svg`) && attempt < 100; attempt++) await page.waitForTimeout(50);
      const route = images.get(`/scroll-image-${id}.svg`);
      assert.ok(route, 'Markdown image requested');
      await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1800"><rect width="600" height="1800" fill="royalblue"/></svg>' });
      await page.locator(`img[alt="Delayed ${id}"]`).evaluate(img => img.decode());
      await page.waitForTimeout(150);
    };
    await bottom('initial transcript');
    holdMessages = true;
    await page.reload();
    if (viewport.width < 768) await page.locator(`[data-session-card="${sessionKey}"]`).click();
    // Cached content is immediately usable; its revalidation stays silent.
    await backgroundRead();
    assert.equal(await pane.locator('[data-message-search-id="initial-17"]').count(), 1, 'cached transcript remains rendered during latest read');
    await releaseMessages();
    await bottom('cached reload settles at actual bottom');
    // Background reads are silent and must not seize the reader's scroll.
    await pane.hover();
    await page.mouse.wheel(0, -900);
    await page.waitForTimeout(200);
    const readingTop = (await metrics()).top;
    holdMessages = true;
    await refresh();
    await backgroundRead();
    const beforeReadHeight = (await metrics()).height;
    await releaseMessages(503);
    assert.equal((await metrics()).height, beforeReadHeight, 'latest feedback does not change transcript geometry');
    assert.ok(Math.abs((await metrics()).top - readingTop) < 2, 'failed latest read preserves reader position');
    assert.equal(await pane.locator('[data-message-search-id="initial-17"]').count(), 1, 'failed latest read keeps cached messages');
    holdMessages = true;
    await refresh();
    await backgroundRead();
    await releaseMessages();
    assert.ok(Math.abs((await metrics()).top - readingTop) < 2, 'successful latest refresh preserves reader position');
    await toggleAutoScroll('Disable auto-scroll');
    await toggleAutoScroll('Enable auto-scroll');
    await bottom('resume after latest read feedback');
    // Releasing a transcript press outside the pane must not leave a stale
    // selection latch blocking all future resize/stream follow callbacks.
    const paragraph = await pane.locator('p').last().boundingBox();
    const paneBox = await pane.boundingBox();
    await page.mouse.move(paragraph.x + 25, Math.min(paragraph.y + 8, paneBox.y + paneBox.height - 8));
    await page.mouse.down();
    await append('during-pointer', 'Reply arriving during pointer interaction\n\n' + 'New content. '.repeat(140));
    await page.waitForTimeout(250);
    await page.mouse.move(5, 5);
    await page.mouse.up();
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await bottom('release outside transcript resumes pending follow');
    await append('long', `Long reply\n\n${'A full paragraph. '.repeat(30).concat('\n\n').repeat(24)}End of long reply`);
    await bottom('long reply ends at actual bottom');
    messages = messages.map(item => item.id === 'long' ? { ...item, text: item.text + '\n\n' + 'Streaming continuation. '.repeat(900) } : item);
    await refresh();
    await page.getByText('Streaming continuation.', { exact: false }).waitFor();
    await bottom('same message streaming growth');
    await append('image', `Delayed image\n\n![Delayed one](${origin}/scroll-image-one.svg)`);
    await page.waitForTimeout(700);
    await releaseImage('one');
    await bottom('delayed Markdown image');
    await append('code', `[Example](${sourcePath}:30)`, [{ type: 'file', name: 'scroll-example.ts', url: sourceUrl,
      sourceReference: { href: `${sourcePath}:30`, path: sourcePath, line: 30 } }]);
    const code = page.getByRole('region', { name: `Source preview ${sourcePath}:30`, exact: true });
    await code.getByRole('button', { name: 'Expand', exact: true }).click();
    await bottom('expanded inline code preview');
    const nested = code.locator('.source-inline-code');
    await nested.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await nested.hover();
    // Playwright may scroll ancestors to bring the nested target under the
    // pointer. Measure wheel isolation only after that positioning settles.
    await page.waitForFunction(() => {
      const el = [...document.querySelectorAll('.message-selection-surface')].find(el => el.clientHeight);
      if (!el) return false;
      const previous = window.nestedHoverPosition;
      if (!previous || previous.top !== el.scrollTop || previous.height !== el.scrollHeight) {
        window.nestedHoverPosition = { top: el.scrollTop, height: el.scrollHeight, since: performance.now() }; return false;
      }
      return performance.now() - previous.since >= 250;
    });
    const beforeNested = await metrics();
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(250);
    assert.ok(await nested.evaluate(el => el.scrollTop > 0 && el.scrollTop < el.scrollHeight - el.clientHeight), 'code scrolled internally');
    const afterNested = await metrics();
    assert.ok(Math.abs(afterNested.top - beforeNested.top) < 3, `code scroll does not move transcript: ${JSON.stringify({ beforeNested, afterNested })}`);
    await append('after-code', 'Following after scrolling inside code\n\n' + 'Continuation. '.repeat(120));
    await bottom('nested code wheel does not disable transcript follow');

    await append('selection-image', `Selection protection\n\n![Delayed selection](${origin}/scroll-image-selection.svg)`);
    await bottom('before selecting transcript text');
    await pane.locator('p').last().evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el);
      window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    });
    const selectedPosition = await metrics();
    await releaseImage('selection');
    assert.ok(Math.abs((await metrics()).top - selectedPosition.top) < 3, 'active text selection protects reading position');
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await bottom('clearing selection resumes layout follow without another message');
    const beforePause = await metrics();
    await pane.hover();
    await page.mouse.wheel(0, -500);
    await page.waitForTimeout(300);
    const paused = await metrics();
    assert.ok(paused.gap > 200, 'manual scroll leaves bottom');
    assert.equal(paused.height, beforePause.height, 'latest indicator does not change transcript height');
    await append('paused', 'New reply while reading history\n\n' + 'More content. '.repeat(100));
    await page.waitForTimeout(500);
    assert.ok(Math.abs((await metrics()).top - paused.top) < 3, 'manual upward scroll pauses follow');
    await page.getByRole('button', { name: 'Jump to latest messages' }).click();
    await bottom('manual jump');
    await pane.hover();
    await page.mouse.wheel(0, -60);
    await page.waitForTimeout(300);
    const smallPause = await metrics();
    assert.ok(smallPause.gap > 10, 'small upward scroll leaves bottom');
    await append('small-pause', 'New reply after small upward scroll\n\n' + 'More content. '.repeat(100));
    await page.waitForTimeout(500);
    assert.ok(Math.abs((await metrics()).top - smallPause.top) < 3, 'small upward scroll also pauses follow');
    await page.getByRole('button', { name: 'Jump to latest messages' }).click();
    await bottom('jump after small pause');
    await pane.hover();
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(300);
    await pane.evaluate(el => { el.scrollTop = el.scrollHeight - el.clientHeight - 60; });
    await page.waitForTimeout(300);
    const programmaticPause = await metrics();
    await append('programmatic-pause', 'New reply after programmatic positioning\n\n' + 'More content. '.repeat(100));
    await page.waitForTimeout(400);
    assert.ok(Math.abs((await metrics()).top - programmaticPause.top) < 3, 'programmatic positioning is not a downward user gesture');
    await page.getByRole('button', { name: 'Jump to latest messages' }).click();
    await bottom('jump after programmatic positioning');
    // Reading history and then returning into the bottom zone must re-arm
    // follow. The latest button already disappears in this zone.
    await pane.hover();
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(300);
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(300);
    assert.ok((await metrics()).gap < 140, 'user returned to bottom zone');
    await append('return-to-bottom', 'Following after returning near the bottom\n\n' + 'More content. '.repeat(100));
    await bottom('downward return to bottom zone resumes follow');
    await toggleAutoScroll('Disable auto-scroll');
    await page.waitForTimeout(250);
    assert.equal(await page.getByRole('button', { name: 'Jump to latest messages' }).count(), 0, 'turning follow off at bottom does not invent unread content');
    const disabled = await metrics();
    await append('disabled', `Disabled image\n\n![Delayed two](${origin}/scroll-image-two.svg)`);
    await releaseImage('two');
    await page.waitForTimeout(500);
    assert.ok(Math.abs((await metrics()).top - disabled.top) < 3, 'disabled toggle blocks late image and timers');
    await page.getByRole('button', { name: 'Jump to latest messages' }).click();
    await bottom('one-off jump while disabled');
    await toggleAutoScroll('Enable auto-scroll');
    await append('resumed', 'Resumed follow\n\n' + 'Final content. '.repeat(300));
    await bottom('reenabled follow');
    await page.setViewportSize({ width: viewport.width, height: viewport.height - 100 });
    await bottom('viewport resize');
    // A gesture that cannot scroll a short conversation must not silently
    // disarm follow for the first long response.
    messages = [message('short', 'Short conversation')];
    await page.reload();
    await page.locator(`[data-session-card="${sessionKey}"]`).click();
    // Do not leave the synthetic pointer over the sidebar while waiting: its
    // delayed reading preview can cover the transcript wheel-test target.
    await page.mouse.move(0, 0);
    await page.locator('.session-peek').waitFor({ state: 'hidden' });
    await page.locator('[data-message-search-id="short"]').waitFor();
    await page.waitForTimeout(400);
    assert.equal((await metrics()).top, 0, 'short conversation starts at zero');
    await pane.hover();
    await page.mouse.wheel(0, -80);
    await append('short-growth', 'First long response\n\n' + 'More content. '.repeat(600));
    await bottom('upward gesture without overflow does not disable follow');
    // Pending queue stays below streaming output without changing command ids.
    session.status = 'running';
    session.runtime = { phase: 'running', sync: 'current', connection: 'connected', threadActivity: 'running', lastEventAt: 1 };
    messages.push({ ...message('queue-one', 'Waiting input one'), role: 'user', createdAt: 1, status: 'queued', queueDisposition: 'waiting', queueVersion: 'q1' });
    messages.push({ ...message('queue-two', 'Waiting input two'), role: 'user', createdAt: 2, status: 'queued', queueDisposition: 'waiting', queueVersion: 'q2' });
    await append('predecessor-final', 'Previous run is still producing output.');
    const ids = () => pane.locator('[data-message-search-id]').evaluateAll(nodes => nodes.map(node => node.dataset.messageSearchId));
    assert.deepEqual((await ids()).slice(-3), ['predecessor-final', 'queue-one', 'queue-two']);
    await bottom('queue at transcript tail');
    await append('predecessor-more', 'Another piece of output before queued dispatch');
    assert.deepEqual((await ids()).slice(-3), ['predecessor-more', 'queue-one', 'queue-two']);
    await bottom('streaming before pending queue');
    const dispatchTime = 1000 + revision;
    messages = messages.map(row => row.id.startsWith('queue-') ? { ...row, status: 'sent', createdAt: dispatchTime, queueVersion: undefined, queueDisposition: undefined } : row);
    await append('batch-answer', 'Both queued inputs handled together');
    assert.deepEqual((await ids()).slice(-3), ['queue-one', 'queue-two', 'batch-answer']);
    await bottom('dispatch uses actual timeline position');
    session.status = 'idle'; session.runCompletedAt = dispatchTime + 1;
    session.runtime = { ...session.runtime, phase: 'completed', threadActivity: 'idle' };
    await page.reload();
    if (viewport.width < 600) await page.locator(`[data-session-card="${sessionKey}"]`).click();
    await page.locator('[data-run-outcome="completed"]').waitFor();
    assert.deepEqual((await ids()).slice(-3), ['queue-one', 'queue-two', 'batch-answer']);
    await bottom('completion and reload');
    // Toolbar occupies its own row: no reserved button column on wrapped lines.
    const composer = page.locator(viewport.width < 600 ? '.mobile-composer-textarea' : '.desktop-composer-textarea');
    await composer.fill('Full width text input. '.repeat(50));
    const geometry = await composer.evaluate(el => {
      const style = getComputedStyle(el), rect = el.getBoundingClientRect();
      const button = el.closest('form').querySelector('[aria-label="Send message"]').getBoundingClientRect();
      return { left: parseFloat(style.paddingLeft), right: parseFloat(style.paddingRight), bottom: rect.bottom, buttonTop: button.top, width: rect.width, parentWidth: el.parentElement.clientWidth };
    });
    assert.equal(geometry.left, geometry.right, 'symmetric text padding');
    assert.ok(geometry.buttonTop >= geometry.bottom - 1, 'send button below text area, never over it');
    assert.ok(geometry.width >= geometry.parentWidth - 16, 'text area uses full width');
    await composer.fill('');
    holdMessages = true;
    await refresh();
    await backgroundRead();
    if (viewport.width < 768) await page.getByRole('button', { name: 'Back to sessions' }).click();
    await page.locator(`[data-session-card="${otherSession.sessionKey}"]`).click();
    await page.locator('[data-message-search-id="other-message"]').waitFor();
    await latestNotice.waitFor({ state: 'hidden' });
    await releaseMessages();
    assert.equal(await page.locator('[data-message-search-id="other-message"]').count(), 1, 'late previous-session response cannot replace the new session');
    assert.equal(await pane.locator('[data-message-search-id="batch-second"]').count(), 0, 'previous transcript stays isolated');
    // The initial 200-row page may contain only tool events. Fill the chat
    // budget once, but do not refetch the same before-page on every live poll.
    paginate = true;
    messages = [...Array.from({ length: 200 }, (_, i) => message(`older-chat-${i}`, `Older chat ${i}`)),
      ...Array.from({ length: 200 }, (_, i) => ({ ...message(`tool-page-${i}`, '[tool exec]\noutput: done'), role: 'tool', toolName: 'exec', toolCallId: `t-${i}`, toolPhase: 'result' }))];
    // Desktop keeps both session controllers mounted. Selecting an existing
    // pane is not a new initial history read; reload to exercise initial fill
    // with an empty in-memory history, independently of the prior transcript.
    revision++;
    await page.reload();
    if (viewport.width < 768) {
      const backBtn = page.getByRole("button", { name: "Back to sessions" });
      await backBtn.waitFor();
      await backBtn.click();
      await page.locator(`[data-session-card="${sessionKey}"]`).click();
    }
    await page.locator('[data-message-search-id="older-chat-199"]').waitFor();
    assert.deepEqual(olderReads, ['tool-page-0'], 'initial fill reads one older page');
    for (let poll = 0; poll < 3; poll++) {
      const readsBefore = messageReads;
      await refresh();
      for (let wait = 0; messageReads === readsBefore && wait < 50; wait++) await page.waitForTimeout(100);
      assert.ok(messageReads > readsBefore);
      await page.waitForTimeout(250);
      assert.deepEqual(olderReads, ['tool-page-0'], 'latest refresh must retain already loaded history');
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal overflow');
    assert.deepEqual(errors, []);
    assert.deepEqual(rejected, []);
    console.log(`PASS auto-scroll ${viewport.width}x${viewport.height}: queue tail/dispatch/reload, persistent completion, full-width composer, latest-read initial/cache/error/recovery/session-switch feedback, outside pointer release, nested code scroll, selection resume, long reply, streaming, delayed images, manual pause, programmatic positioning, downward re-entry, non-layout indicator, toggle without false unread, manual jump, short transcript`);
    await context.close();
  }
} finally {
  await browser?.close();
  if (builtRoot) await new Promise(resolve => server.httpServer.close(resolve));
  else await server.close();
}
