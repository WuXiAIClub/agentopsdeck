// Actual UI, synthetic loopback APIs only; no runtime, production proxy or credentials.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, preview } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT
  ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const builtRoot = process.env.AOD_TEST_WEB_ROOT;
const server = builtRoot ? await preview({ root: builtRoot, configFile: false, envFile: false, build: { outDir: builtRoot }, preview: { host: '127.0.0.1', port: 0 }, logLevel: 'error' }) : await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react(), tailwindcss()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
if (!builtRoot) await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const sessionKey = 'local:Y29kZXg6c3ludGhldGlj';
const session = { sessionKey, envConnectionId: 'local', title: 'Synthetic queue chat', agentId: 'codex', source: 'codex', status: 'running', hasActiveRun: true, lastActiveAt: 1 };
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
    const context = await browser.newContext({ viewport, hasTouch: viewport.width < 600, serviceWorkers: 'block' });
    let version = '1:1', text = 'Original queued message', removed = false, seq = 1;
    const writes = [], rejected = [], errors = [], receipts = new Map();
    let loseAck = false, receiptOffline = false, receiptReads = 0, single = false, staleHistory = false, extraCount = 1;
    const cursor = () => `ce1_11111111-1111-4111-8111-111111111111:${seq}`;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { rejected.push(url.origin); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = body => route.fulfill({ json: body });
      // Read-only completion polling uses POST for its bounded session list.
      // Keep all actual mutations confined to the queue endpoint below.
      if (request.method() === 'POST' && url.pathname === '/api/hub/v1/completions/summary') {
        assert.ok(Array.isArray(request.postDataJSON().sessions));
        return json({ items: [] });
      }
      if (request.method() !== 'GET') {
        if (!url.pathname.endsWith('/queue/queued-fixture')) { rejected.push(url.pathname); return route.abort(); }
        const key = request.headers()['idempotency-key'];
        assert.ok(key); assert.equal(request.headers()['x-agentopsdeck-recovery-scope'], 'a'.repeat(64));
        const command = { id: key, key, state: 'accepted', createdAt: 1, updatedAt: 2, result: { status: 200, body: { ok: true } } };
        writes.push({ method: request.method(), version: request.headers()['if-match'], body: request.postDataJSON(), key });
        if (writes.length === 1) {
          version = '1:2'; text = 'Edited in another tab'; seq++;
          receipts.set(key, { ...command, state: 'rejected', result: { status: 412, body: { error: 'queue version changed' } } });
          return route.fulfill({ status: 412, json: { error: 'queue version changed' } });
        }
        assert.equal(request.headers()['if-match'], JSON.stringify(version));
        if (request.method() === 'PATCH') { text = request.postDataJSON().message; version = '1:3'; }
        else if (!staleHistory) removed = true;
        seq++; receipts.set(key, command);
        if (loseAck) return route.abort('failed');
        return json({ ok: true, command });
      }
      if (url.pathname.includes('/queue/queued-fixture/commands/')) {
        receiptReads++;
        assert.equal(request.headers()['x-agentopsdeck-recovery-scope'], 'a'.repeat(64));
        if (receiptOffline) return route.abort('failed');
        const command = receipts.get(decodeURIComponent(url.pathname.split('/').at(-1)));
        return command ? json({ command }) : route.fulfill({ status: 404, json: { error: 'missing receipt' } });
      }
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } });
      if (url.pathname === '/api/hub/v1/sessions/state') return json({ updatedAt: seq, revision: `list:${seq}`, viewKey: 'queue-fixture',
        sourceStates: [{ connectionId: 'local', authority: 1, state: 'ready', cursor: cursor(), hiddenCount: 0, archivedCount: 0, pinnedCount: 0 }],
        groups: [{ agentId: 'codex', sessions: [session] }] });
      if (url.pathname.endsWith('/messages')) return json({ updatedAt: seq, revision: `messages:${seq}`, sourceCursor: cursor(), hiddenCount: 0,
        messages: [
          { id: 'assistant', sessionKey, role: 'assistant', text: 'Synthetic active conversation', createdAt: 1, status: 'sent' },
          ...(!removed && !single ? Array.from({ length: extraCount }, (_, index) => ({ id: `other-queued-${index}`, sessionKey, role: 'user', text: index ? `Additional queued message ${index}` : 'Another queued message', createdAt: 3 + index, status: 'queued', ...(version ? { queueVersion: 'other:1' } : {}) })) : []),
          ...(!removed ? [{ id: 'queued-fixture', sessionKey, role: 'user', text, createdAt: 2, status: 'queued', ...(version ? { queueVersion: version } : {}) }] : []),
        ] });
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      return route.fulfill({ status: 404, json: { error: 'Outside fixture' } });
    });
    await context.addInitScript(() => {
      localStorage.setItem('agentopsdeck.apiBaseUrl', location.origin);
      const streams = [];
      window.EventSource = class extends EventTarget {
        readyState = 1; static OPEN = 1; static CONNECTING = 0; static CLOSED = 2;
        constructor() { super(); streams.push(this); queueMicrotask(() => this.onopen?.(new Event('open'))); }
        close() { this.readyState = 2; }
      };
      window.queueEvent = event => { for (const stream of streams) if (stream.readyState === 1)
        stream.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event), lastEventId: event.id })); };
    });
    const page = await context.newPage(); page.setDefaultTimeout(10_000);
    const reloadChat = async () => {
      await page.reload();
      // Messages and session metadata revalidate independently. Wait for the
      // scenario's session title, not just a message from the previous cache.
      const card = page.locator(`[data-session-card="${sessionKey}"]`).filter({ hasText: session.title });
      await card.waitFor();
      if (viewport.width < 600) await card.click();
    };
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    // A hidden workspace selector also has the title as an <option>.
    await page.locator(`[data-session-card="${sessionKey}"]`).click();
    const row = page.locator('[data-queued-message-id="queued-fixture"]');
    const dock = page.locator('article').filter({ has: row });
    const assertNoQueueDock = async () => {
      assert.equal(await page.getByText('sent one at a time', { exact: true }).count(), 0);
      assert.equal(await page.getByText(/Waiting for queue confirmation/).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Refresh queue', exact: true }).count(), 0);
      assert.equal(await page.locator('form [data-queued-message-id]').count(), 0, 'queue controls never return to the composer');
    };
    for (const count of [2, 5, 2]) {
      extraCount = count - 1; seq++; await reloadChat();
      await row.waitFor();
      await page.waitForFunction(expected => document.querySelectorAll('article [data-delivery="queued"]').length === expected, count);
      assert.equal(await page.locator('article [data-delivery="queued"]').count(), count);
      assert.equal(await page.getByText('Another queued message', { exact: true }).count(), 1);
      assert.equal(await page.getByText(text, { exact: true }).count(), 1);
      await assertNoQueueDock();
    }
    if (process.env.AOD_TEST_SCREENSHOTS) await page.screenshot({ path: `${process.env.AOD_TEST_SCREENSHOTS}/multiple-queued-${viewport.width}.png` });
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    assert.equal(await page.locator('[data-queued-message-id="other-queued-0"]').getByRole('button', { name: 'Edit', exact: true }).isDisabled(), true, 'another message cannot overwrite the open draft');
    const editor = page.getByRole('textbox', { name: 'Edit queued message', exact: true });
    assert.equal(await row.getByRole('button', { name: 'Cancel delivery', exact: true }).count(), 0, 'delivery cancellation is hidden while editing');
    const panel = page.locator('.queue-edit-panel');
    const panelBox = await panel.boundingBox(), editorBox = await editor.boundingBox();
    assert.ok(editorBox.x >= panelBox.x && editorBox.x + editorBox.width <= panelBox.x + panelBox.width + 1, 'editor stays inside its panel');
    const save = panel.getByRole('button', { name: 'Save changes', exact: true });
    const discard = panel.getByRole('button', { name: 'Keep original', exact: true });
    assert.notEqual(await save.evaluate(node => getComputedStyle(node).backgroundColor), await discard.evaluate(node => getComputedStyle(node).backgroundColor), 'primary save differs from keep-original action');
    await editor.fill('My retained draft');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Queue version changed' }).waitFor();
    assert.equal(await editor.inputValue(), 'My retained draft');
    assert.equal(writes.length, 1); assert.equal(writes[0].version, '"1:1"');
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
    // Editing intentionally replaces the body; a refreshed conflicting version
    // is exposed by the explicit adoption control, not duplicate hidden text.
    await page.getByRole('button', { name: 'Use displayed version; keep my draft', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Save changes', exact: true }).isDisabled(), true);
    assert.equal(await editor.inputValue(), 'My retained draft'); assert.equal(writes.length, 1, 'refresh never retries a mutation');
    await page.getByRole('button', { name: 'Use displayed version; keep my draft', exact: true }).click();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await dock.getByText('My retained draft', { exact: true }).waitFor();
    assert.equal(writes[1].version, '"1:2"');
    assert.equal(writes[1].body.message, 'My retained draft');
    await row.getByRole('button', { name: 'Cancel delivery', exact: true }).click();
    await dock.getByRole('button', { name: 'Confirm cancel', exact: true }).click();
    await dock.waitFor({ state: 'hidden' });
    assert.equal(writes[2].method, 'DELETE'); assert.equal(writes[2].version, '"1:3"');

    // Old Connector/optimistic messages must not invent a fresh precondition.
    removed = false; version = ''; text = 'Legacy queued message'; seq++;
    const invalidate = () => page.evaluate(({ sessionKey, seq }) => window.queueEvent({ id: `queue-event-${seq}`,
      type: 'message.updated', sessionKey, ts: seq, payload: {} }), { sessionKey, seq });
    await invalidate();
    await page.getByText(text, { exact: true }).waitFor();
    assert.equal(await page.locator('[data-delivery="queued"]').count(), 0, 'unversioned admissions do not show queue controls');
    await assertNoQueueDock();
    assert.equal(writes.length, 3);
    version = '2:1'; seq++;
    await invalidate();
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    await editor.fill('Keep even when dequeued');
    removed = true; seq++; await invalidate();
    await page.getByText('Message is no longer queued. Your draft is kept for copying.', { exact: true }).waitFor();
    assert.equal(await editor.inputValue(), 'Keep even when dequeued');
    assert.equal(await page.getByRole('button', { name: 'Save changes', exact: true }).isDisabled(), true);
    assert.equal(writes.length, 3);
    // Dropped edit ACK plus unavailable lookup keeps the draft and blocks both
    // mutation controls. Reload queries only the original key, with no payload.
    removed = false; version = '3:1'; text = 'Recovery edit fixture'; seq++;
    await reloadChat(); await dock.getByText(text, { exact: true }).waitFor();
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    await editor.fill('Private recovery draft'); loseAck = true; receiptOffline = true;
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Queue modification not confirmed' }).waitFor();
    const notice = page.getByRole('region', { name: 'Command delivery recovery' });
    await notice.getByText(/Queue edit — outcome unknown/).waitFor();
    assert.equal(await editor.inputValue(), 'Private recovery draft');
    assert.equal(await page.getByRole('button', { name: 'Save changes', exact: true }).isDisabled(), true);
    assert.equal(await row.getByRole('button', { name: 'Cancel delivery', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Keep original', exact: true }).click();
    assert.equal(await row.getByRole('button', { name: 'Cancel delivery', exact: true }).isDisabled(), true, 'closing the editor cannot bypass an unresolved mutation');
    assert.equal(await notice.getByRole('button', { name: 'Forget locally' }).count(), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('agentopsdeck.command-recovery.v1').includes('Private recovery draft')), false);
    const readsBeforeReload = receiptReads;
    receiptOffline = false; await reloadChat();
    await notice.getByText(/Queue edit — applied/).waitFor();
    assert.ok(receiptReads > readsBeforeReload); assert.equal(writes.length, 4);

    // Cancellation recovery remains visible after the queue row is gone.
    receiptOffline = true;
    await row.getByRole('button', { name: 'Cancel delivery', exact: true }).click();
    await dock.getByRole('button', { name: 'Confirm cancel', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Queue modification not confirmed' }).waitFor();
    await notice.getByText(/Queue cancellation — outcome unknown/).waitFor();
    await reloadChat();
    await notice.getByText(/Queue cancellation — outcome unknown/).waitFor();
    await dock.waitFor({ state: 'hidden' }); assert.equal(writes.length, 5);
    receiptOffline = false;
    await notice.getByRole('button', { name: 'Check receipt', exact: true }).click();
    await notice.getByText(/Queue cancellation — applied/).waitFor();
    assert.equal(writes.length, 5);
    // One queued message stays in its chat bubble, with explicit delivery state
    // and real cancellation controls, not a second copy in a queue dock.
    single = true; removed = false; loseAck = false;
    session.status = 'idle'; session.hasActiveRun = false;
    session.title = 'Synthetic idle queue chat';
    for (const admissionVersion of ['', '4:1']) {
      version = admissionVersion; text = 'Idle admission stays quiet'; seq++;
      await reloadChat();
      await page.getByText(text, { exact: true }).waitFor();
      assert.equal(await page.locator('[data-delivery="queued"]').count(), 0);
      assert.equal(await page.getByText(/Waiting for queue confirmation/).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Refresh queue', exact: true }).count(), 0);
    }
    // A stale idle snapshot with several durable admissions is still not a
    // running backlog, and every message remains in the conversation.
    single = false; seq++; await reloadChat();
    await page.getByText(text, { exact: true }).waitFor();
    await page.getByText('Another queued message', { exact: true }).waitFor();
    assert.equal(await page.getByText('sent one at a time', { exact: true }).count(), 0);
    assert.equal(await page.locator('[data-delivery="queued"]').count(), 0);
    // The new run can appear before message projection catches up. An
    // unversioned admission ACK must not turn into a queue badge at that point.
    single = true; version = ''; session.status = 'running'; session.hasActiveRun = true; seq++;
    session.title = 'Synthetic running queue chat';
    await reloadChat(); await page.getByText(text, { exact: true }).waitFor();
    assert.equal(await page.locator('[data-delivery="queued"]').count(), 0);
    assert.equal(await page.getByText(/Waiting for queue confirmation/).count(), 0);
    staleHistory = true;
    version = '4:1'; text = 'Single inline queued message'; seq++;
    await reloadChat();
    const inline = page.locator('[data-delivery="queued"]');
    await inline.getByText('Queued', { exact: true }).waitFor();
    assert.equal(await page.getByText(text, { exact: true }).count(), 1);
    assert.equal(await page.getByText('sent one at a time', { exact: true }).count(), 0);
    const assertCompactHeader = async () => {
      const bodyNode = await page.getByText(text, { exact: true }).elementHandle();
      // Read one committed layout. Auto-follow can move the whole row between
      // separate browser round trips after an editor closes.
      const { label, actions, body } = await inline.evaluate((node, bodyNode) => ({
        label: node.querySelector('.queue-card-label').getBoundingClientRect().toJSON(),
        actions: node.querySelector('.queue-card-actions').getBoundingClientRect().toJSON(),
        body: bodyNode.getBoundingClientRect().toJSON(),
      }), bodyNode);
      await bodyNode.dispose();
      assert.ok(label && actions && body);
      assert.ok(Math.abs(label.y + label.height / 2 - actions.y - actions.height / 2) < 2, 'label and actions share one header row');
      assert.ok(label.x + label.width <= actions.x, 'queue label stays left of actions');
      assert.ok(actions.y + actions.height <= body.y, 'queue controls are above message content');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    };
    await assertCompactHeader();
    if (process.env.AOD_TEST_SCREENSHOTS) await page.screenshot({ path: `${process.env.AOD_TEST_SCREENSHOTS}/queue-card-${viewport.width}.png` });
    assert.equal(await page.getByText(/Queued · waiting to be sent/).count(), 0);
    assert.equal(await inline.locator('..').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(48, 75, 114)', 'queued bubble has a distinct muted background');
    await inline.getByRole('button', { name: 'Edit', exact: true }).click();
    await editor.fill('Inline edited message');
    await inline.getByRole('button', { name: 'Save changes', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });
    await page.getByText('Inline edited message', { exact: true }).waitFor();
    assert.equal(writes.length, 6); assert.equal(writes[5].version, '"4:1"');
    assert.equal(writes[5].body.message, 'Inline edited message');
    await assertCompactHeader();
    await inline.getByRole('button', { name: 'Cancel delivery', exact: true }).click();
    await assertCompactHeader();
    assert.equal(writes.length, 6, 'first click only asks for confirmation');
    await inline.getByRole('button', { name: 'Keep queued', exact: true }).click();
    assert.equal(writes.length, 6);
    await inline.getByRole('button', { name: 'Cancel delivery', exact: true }).click();
    await inline.getByRole('button', { name: 'Confirm cancel', exact: true }).click();
    await page.getByText('Cancelled · will not be sent', { exact: true }).waitFor();
    assert.equal(writes.length, 7); assert.equal(writes[6].version, '"1:3"');
    assert.equal(await inline.count(), 0, 'confirmed cancellation survives stale history');
    removed = true; staleHistory = false; seq++;
    for (const [threadActivity, label] of [
      ['running', 'Previous run finished · thread still active'],
      ['waiting', 'Previous run finished · thread waiting for approval or input'],
      ['unknown', 'Previous run finished · checking thread state…'],
    ]) {
      session.runtime = { phase: 'completed', threadActivity, connection: 'connected', sync: 'current', lastEventAt: 1 };
      session.runStartedAt = 1; session.runCompletedAt = 2; seq++;
      await reloadChat();
      await page.getByText(label, { exact: true }).waitFor().catch(async error => {
        console.error('Run notice snapshot', viewport.width, await page.locator('[data-chat-activity]').allTextContents());
        throw error;
      });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    for (const phase of ['running', 'waiting']) {
      session.runtime.phase = phase; seq++;
      await reloadChat();
      await page.getByText('Checking run state…', { exact: true }).waitFor().catch(async error => {
        console.error('Nonterminal notice snapshot', { width: viewport.width, phase,
          notices: await page.locator('[role="status"]').allTextContents() });
        throw error;
      });
    }
    delete session.runtime; delete session.runStartedAt; delete session.runCompletedAt;
    assert.deepEqual(errors, []); assert.deepEqual(rejected, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await context.close();
    console.log(`queue version UI ${viewport.width}px passed`);
  }
} finally { await browser?.close(); await server.close(); }
