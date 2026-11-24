// Actual desktop/mobile application against synthetic HTTP responses. No real
// Hub, Connector, credentials, agent commands, or production-origin access.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT
  ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false,
  plugins: [react(), tailwindcss()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const sessionKey = 'local:Y29kZXg6c3ludGhldGlj';
const session = { sessionKey, envConnectionId: 'local', title: 'Synthetic snapshot chat', agentId: 'codex', source: 'codex', status: 'idle', lastActiveAt: 1 };
const cursor = seq => `ce1_11111111-1111-4111-8111-111111111111:${seq}`;
async function withDeadline(promise, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 10_000); })]); }
  finally { clearTimeout(timer); }
}
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    let holdNext = false, heldRoute, markHeld;
    const held = new Promise(resolve => { markHeld = resolve; });
    let newest = false;
    let reads = 0, nextReply;
    let listReads = 0;
    const listSnapshot = (localSeq, remoteSeq, denied = false) => ({ updatedAt: 1, revision: `list:${localSeq}:${remoteSeq}:${denied}`,
      viewKey: 'synthetic-view', sourceStates: ['local', 'remote'].map((connectionId, i) => ({ connectionId,
        authority: 1, state: denied && !i ? 'denied' : 'ready', cursor: cursor(i ? remoteSeq : localSeq), hiddenCount: 0, archivedCount: 0, pinnedCount: 0 })),
      groups: [{ agentId: 'codex', sessions: [
        ...(!denied ? [{ ...session, title: localSeq < 10 ? 'Regressed local list' : session.title }] : []),
        { ...session, sessionKey: 'remote:c3ludGhldGlj', envConnectionId: 'remote', title: `Remote snapshot ${remoteSeq}` },
      ] }],
    });
    let listReply = listSnapshot(10, 10);
    let resetReads = 0, resetHeld, markReset;
    const resetReady = new Promise(resolve => { markReset = resolve; });
    const initialLimit = viewport.width > 700 ? 120 : 36;
    const messages = (label, seq = newest ? 20 : 10) => ({ messages: Array.from({ length: 24 }, (_, i) => ({
      id: `message-${i}`, sessionKey, role: 'assistant', text: `${label} ${i}\n\n${'Synthetic paragraph for scrolling. '.repeat(8)}`,
      createdAt: 1000 + i, status: 'sent',
    })), updatedAt: newest ? 2 : 1, hiddenCount: newest ? 0 : 80, revision: label, sourceCursor: cursor(seq) });
    const rejectedRequests = [];
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { rejectedRequests.push(url.origin); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (route.request().method() !== 'GET') { rejectedRequests.push(url.pathname); return route.abort(); }
      const json = body => route.fulfill({ json: body });
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } });
      if (url.pathname === '/api/hub/v1/sessions/state') { listReads++; return json(listReply); }
      if (url.pathname.endsWith('/messages')) {
        if (url.pathname.includes('reset-fixture')) {
          if (++resetReads === 1) { resetHeld = route; markReset(); return; }
          return json(messages('Post-reset API read'));
        }
        reads++;
        if (holdNext) { holdNext = false; heldRoute = route; markHeld(); return; }
        if (nextReply) { const reply = nextReply; nextReply = undefined; return json(reply); }
        if (Number(url.searchParams.get('limit')) > initialLimit) newest = true;
        return json(messages(newest ? 'Fresh history' : 'Initial snapshot'));
      }
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      return route.fulfill({ status: 404, json: { error: 'Not part of the fixture' } });
    });
    await context.addInitScript(() => {
      localStorage.setItem('agentopsdeck.apiBaseUrl', location.origin);
      const streams = [];
      window.EventSource = class extends EventTarget {
        readyState = 1;
        static OPEN = 1;
        static CONNECTING = 0;
        static CLOSED = 2;
        constructor() { super(); streams.push(this); queueMicrotask(() => this.onopen?.(new Event('open'))); }
        close() { this.readyState = 2; }
      };
      window.snapshotEvent = event => {
        for (const stream of streams) if (stream.readyState === 1) {
          stream.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event), lastEventId: event.id }));
        }
      };
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.getByText(session.title, { exact: true }).first().waitFor();
    const listEvent = async (seq, withCursor = true) => page.evaluate(({ seq, watermark }) => window.snapshotEvent({
      id: `list-update-${seq}`, type: 'run.updated', sessionKey: 'remote:c3ludGhldGlj', envConnectionId: 'remote',
      ...(watermark ? { remoteEventId: watermark } : {}), ts: seq, payload: {},
    }), { seq, watermark: withCursor ? cursor(seq) : undefined });
    listReply = listSnapshot(9, 11);
    await listEvent(11);
    await page.getByText('Remote snapshot 11', { exact: true }).first().waitFor();
    assert.equal(await page.getByText('Regressed local list', { exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('Regressed local list')), false);
    await page.getByText(session.title, { exact: true }).first().waitFor();
    const coveredListReads = listReads;
    await listEvent(11);
    await page.waitForTimeout(900);
    assert.equal(listReads, coveredListReads, 'covered source event does not fetch the session list again');
    listReply = listSnapshot(10, 12, true);
    await listEvent(12);
    await page.getByText('Remote snapshot 12', { exact: true }).first().waitFor();
    assert.equal(await page.getByText(session.title, { exact: true }).count(), 0, 'denied source is removed, not retained as stale');
    listReply = listSnapshot(10, 13);
    await listEvent(13);
    await page.getByText(session.title, { exact: true }).first().waitFor();
    await page.getByText(session.title, { exact: true }).first().click().catch(async error => {
      console.error('Synthetic fixture diagnostics:', await page.locator('body').innerText(), errors, rejectedRequests);
      throw error;
    });
    await page.getByText('Initial snapshot 23', { exact: false }).waitFor();
    holdNext = true;
    await page.evaluate(key => window.snapshotEvent({ id: 'synthetic-update', type: 'message.updated', sessionKey: key, ts: 1, payload: {} }), sessionKey);
    await withDeadline(held, 'Background refresh did not start');
    await page.locator('.message-selection-surface').evaluate(element => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await page.getByText('Fresh history 23', { exact: false }).waitFor();
    const staleResponse = page.waitForResponse(response => response.request() === heldRoute.request());
    await heldRoute.fulfill({ json: messages('Stale background') });
    await (await staleResponse).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByText('Stale background', { exact: false }).count(), 0, 'late background cannot overwrite history');
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('Stale background')), false, 'late background cannot corrupt hydration cache');
    assert.equal(await page.getByText('Fresh history 23', { exact: false }).count(), 1);
    const coveredReads = reads;
    await page.evaluate(({ key, watermark }) => window.snapshotEvent({ id: 'covered', type: 'message.updated',
      sessionKey: key, envConnectionId: 'local', remoteEventId: watermark, ts: 2, payload: {} }), { key: sessionKey, watermark: cursor(20) });
    // Longer than the existing 750ms event debounce; no new timer is added to
    // production. A covered event must not schedule another HTTP snapshot.
    await page.waitForTimeout(900);
    assert.equal(reads, coveredReads);
    nextReply = messages('Regressed source snapshot', 19);
    const regressedResponse = page.waitForResponse(response => response.url().includes('/messages'));
    await page.evaluate(({ key, watermark }) => window.snapshotEvent({ id: 'uncovered', type: 'message.updated',
      sessionKey: key, envConnectionId: 'local', remoteEventId: watermark, ts: 3, payload: {} }), { key: sessionKey, watermark: cursor(21) });
    await (await regressedResponse).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByText('Regressed source snapshot', { exact: false }).count(), 0);
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('Regressed source snapshot')), false);
    // Exercise actual API coalescing: a post-reset read of the same URL must
    // proceed even while the pre-reset response is still withheld.
    await page.evaluate(async () => {
      const { api } = await import('/src/api.ts');
      window.preResetRead = api.sessionMessages('local:reset-fixture');
    });
    await withDeadline(resetReady, 'Pre-reset read did not reach the fixture');
    await page.evaluate(async () => {
      const { api, invalidateSnapshotReads } = await import('/src/api.ts');
      invalidateSnapshotReads();
      let timer;
      try {
        const fresh = await Promise.race([api.sessionMessages('local:reset-fixture'),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Post-reset read coalesced with stale request')), 2000); })]);
        if (!fresh.messages[0].text.includes('Post-reset API read')) throw new Error('Wrong post-reset body');
      } finally { clearTimeout(timer); }
    });
    assert.equal(resetReads, 2);
    await resetHeld.fulfill({ json: messages('Pre-reset API read') });
    await page.evaluate(() => window.preResetRead);
    // Explicit node denial clears the selected fallback and fences an already
    // in-flight detail response. Purge only this account/backend/node cache.
    await page.evaluate(async ({ key }) => {
      const cache = await import('/src/lib/session-cache.ts');
      const { setRecoveryScope } = await import('/src/api.ts');
      cache.writeCachedMessages('remote:cache-sentinel', [], { updatedAt: 1 });
      setRecoveryScope('b'.repeat(64));
      cache.writeCachedMessages(key, [], { updatedAt: 1 });
      setRecoveryScope('a'.repeat(64));
      localStorage.setItem('synthetic-draft-sentinel', 'preserve');
      sessionStorage.setItem('synthetic-command-sentinel', 'preserve');
    }, { key: sessionKey });
    const revokedHeld = new Promise(resolve => { markHeld = resolve; });
    holdNext = true;
    await page.evaluate(({ key, watermark }) => window.snapshotEvent({ id: 'pre-revocation', type: 'message.updated',
      sessionKey: key, envConnectionId: 'local', remoteEventId: watermark, ts: 4, payload: {} }), { key: sessionKey, watermark: cursor(30) });
    await withDeadline(revokedHeld, 'Pre-revocation detail request did not start');
    listReply = listSnapshot(10, 14, true);
    await listEvent(14);
    await page.getByText('Remote snapshot 14', { exact: true }).first().waitFor();
    assert.equal(await page.getByText('Fresh history 23', { exact: false }).count(), 0);
    assert.equal(await page.getByText(session.title, { exact: true }).count(), 0);
    const revokedResponse = page.waitForResponse(response => response.request() === heldRoute.request());
    await heldRoute.fulfill({ json: messages('Late revoked response', 40) });
    await (await revokedResponse).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByText('Late revoked response', { exact: false }).count(), 0);
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('Late revoked response')), false);
    await page.evaluate(async key => {
      const cache = await import('/src/lib/session-cache.ts');
      const { setRecoveryScope } = await import('/src/api.ts');
      if (cache.readCachedMessages(key)) throw new Error('Revoked message cache survived');
      if (!cache.readCachedMessages('remote:cache-sentinel')) throw new Error('Other node cache was removed');
      setRecoveryScope('b'.repeat(64));
      if (!cache.readCachedMessages(key)) throw new Error('Other account cache was removed');
      setRecoveryScope('a'.repeat(64));
      if (localStorage.getItem('synthetic-draft-sentinel') !== 'preserve' || sessionStorage.getItem('synthetic-command-sentinel') !== 'preserve') throw new Error('Unrelated storage was removed');
    }, sessionKey);
    assert.deepEqual(errors, []);
    assert.deepEqual(rejectedRequests, []);
    console.log(`${viewport.width}px: two-node list merge, selected-node revocation/late response/cache isolation and chat ordering/watermark/reset passed`);
    await context.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
