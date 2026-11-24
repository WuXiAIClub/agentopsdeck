// Synthetic loopback only. Exercises the actual API, recovery component and
// cache across refresh/owners; does not claim shared navigation is implemented.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT
  ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const scope = 'a'.repeat(64), sessionId = 'local:c3ludGhldGlj';
const base = owner => `/api/hub/v1/shared/${owner}/sessions/${encodeURIComponent(sessionId)}`;
let server, browser, offline = true, requests = [];
server = await createServer({ root, configFile: false, logLevel: 'error',
  plugins: [react(), tailwindcss(), { name: 'shared-address-fixture', configureServer(instance) {
    instance.middlewares.use(async (req, res, next) => {
      if (req.url?.startsWith('/__recovery')) {
        res.setHeader('content-type', 'text/html');
        res.end(await server.transformIndexHtml(req.url, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/command-recovery.fixture.tsx"></script></body></html>'));
        return;
      }
      if (!req.url?.startsWith('/api/')) return next();
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push({ path: req.url, method: req.method, body: body ? JSON.parse(body) : undefined, headers: req.headers });
      res.setHeader('content-type', 'application/json');
      if (req.headers['x-agentopsdeck-recovery-scope'] !== scope) {
        res.statusCode = 409; res.end(JSON.stringify({ error: 'Authenticated account or Hub changed; reload before continuing' })); return;
      }
      if (req.method !== 'GET' || offline) { res.statusCode = 502; res.end('{}'); return; }
      if (req.url.includes('/commands/')) {
        const key = decodeURIComponent(req.url.split('/').at(-1));
        res.end(JSON.stringify({ command: { id: 'receipt', key, state: 'accepted', createdAt: 1, updatedAt: 2,
          result: { status: 200, body: { ok: true, status: 'queued' } } } })); return;
      }
      if (req.url.includes('/queue')) { res.end(JSON.stringify({ availability: 'unavailable', items: [], nextCursor: '2:0' })); return; }
      if (req.url.endsWith('/state')) {
        res.end(JSON.stringify({ sessionKey: sessionId, status: 'running', sourceCursor: 'source:1',
          runtime: { phase: 'finalizing', connection: 'disconnected', sync: 'error', lastEventAt: 1 } })); return;
      }
      res.end(JSON.stringify({ messages: [], updatedAt: 1, sourceCursor: 'source:1' }));
    });
  } }], server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    offline = true; requests = [];
    const context = await browser.newContext({ viewport });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const notice = page.getByRole('region', { name: 'Command delivery recovery' });
    const visit = async owner => {
      await page.goto(`${origin}/__recovery?owner=${owner}`);
      await page.waitForFunction(() => Boolean(window.recoveryFixture));
    };
    await visit('owner-a');
    await page.evaluate(() => window.recoveryFixture.writeCache());
    await page.evaluate(() => window.recoveryFixture.submit());
    await notice.getByText(/Delivery unknown/).waitFor();
    assert.deepEqual(requests.map(r => [r.method, r.path]), [
      ['POST', `${base('owner-a')}/messages`], ['GET', `${base('owner-a')}/commands/synthetic-command`],
    ]);
    assert.deepEqual(requests[0].body, { message: 'synthetic body not stored in recovery', deliveryMode: 'web-only', idempotencyKey: 'synthetic-command' });
    assert.equal(await page.evaluate(() => JSON.stringify(sessionStorage).includes('synthetic body')), false);
    await visit('owner-b');
    assert.equal(await notice.count(), 0);
    assert.equal(await page.evaluate(() => window.recoveryFixture.readCache()), undefined);
    assert.equal(requests.length, 2, 'owner B must not query owner A saved commands');
    await page.evaluate(() => window.recoveryFixture.submit());
    await notice.getByText(/Delivery unknown/).waitFor();
    assert.equal(requests[2].path, `${base('owner-b')}/messages`);
    offline = false;
    await page.reload();
    await page.waitForFunction(() => window.recoveryFixture?.recovered().some(row => row.key === 'synthetic-command' && row.status === 'queued'));
    const remaining = await page.evaluate(() => window.recoveryFixture.rows());
    assert.equal(remaining.length, 1, 'recovering owner B must preserve owner A unknown delivery');
    assert.equal(remaining[0].sessionKey, JSON.stringify(['shared-session-v1', 'owner-a', sessionId]));
    assert.equal(remaining[0].state, 'outcome_unknown');
    assert.equal(await notice.count(), 0, 'confirmed receipt retires the unknown-delivery banner');
    assert.equal(requests.filter(r => r.method === 'POST').length, 2, 'reload only queries');
    await visit('owner-a');
    await page.waitForFunction(() => window.recoveryFixture.recovered().some(row => row.key === 'synthetic-command' && row.status === 'queued'));
    assert.deepEqual(await page.evaluate(() => window.recoveryFixture.rows()), []);
    assert.equal(await notice.count(), 0);
    assert.equal(requests.at(-1).path, `${base('owner-a')}/commands/synthetic-command`);
    assert.equal(await page.evaluate(() => window.recoveryFixture.readCache().messages[0].id), 'synthetic-message');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const beforeUnsupported = requests.length;
    await page.evaluate(() => window.recoveryFixture.submit(true));
    const blocked = await page.evaluate(async () => {
      const { api } = await import('/src/api.ts');
      const { sessionAddress } = await import('/src/lib/session-address.ts');
      const key = sessionAddress({ ownerUserId: 'owner-a', sessionId: 'local:c3ludGhldGlj' }).key;
      const attempts = [() => api.updateSettings(key, { title: 'title' }, 'settings', 'a'.repeat(64)), () => api.settingsCommand(key, 'settings', 'a'.repeat(64)),
        () => api.hideSession(key), () => api.archiveSession(key), () => api.pinSession(key),
        () => api.deleteSession(key), () => api.compactSession(key), () => api.queuedMessages(key),
        () => api.sessionMessages(key.slice(0, -1)), () => api.sharedQueuedMessages('owner-session'),
        () => api.sendMessage(key, 'body', 'web-only', [{ type: 'image', name: 'x', dataUrl: 'data:image/png;base64,AAAA' }])];
      let failures = 0;
      for (const attempt of attempts) { try { await attempt(); } catch { failures++; } }
      return failures;
    });
    assert.equal(blocked, 11);
    assert.equal(requests.length, beforeUnsupported, 'unsupported or damaged targets must not issue requests');
    requests = [];
    const result = await page.evaluate(async () => {
      const { api, eventStreamUrl, recoveryScope } = await import('/src/api.ts');
      const { sessionAddress } = await import('/src/lib/session-address.ts');
      const target = { ownerUserId: 'owner-a', sessionId: 'local:c3ludGhldGlj' }, key = sessionAddress(target).key;
      // Shared and owner reads cannot coalesce; object and canonical key can.
      // Routing isolation uses an explicit page size, independent of the UI's
      // default history-window tuning (currently 200, formerly 36).
      await Promise.all([api.sessionMessages(target, 36), api.sessionMessages(key, 36),
        api.sessionMessages({ ...target, ownerUserId: 'owner-b' }, 36), api.sessionMessages(target.sessionId, 36)]);
      await api.sessionMessageDetail(key, 'message/id');
      const queue = await api.sharedQueuedMessages(key);
      await api.sharedQueuedMessages(target, queue.nextCursor);
      try { await api.updateQueuedMessage(key, 'original-command', 'new text', '1:2', 'edit-key', recoveryScope()); } catch {}
      try { await api.cancelQueuedMessage(key, 'original-command', '1:2', 'cancel-key', recoveryScope()); } catch {}
      await api.queueMutationCommand(key, 'original-command', 'edit-key', recoveryScope());
      const execution = await api.sharedSessionExecution(key);
      return { execution, queue, stream: eventStreamUrl(key), ownerStream: eventStreamUrl(target.sessionId) };
    });
    assert.deepEqual(requests.slice(0, 3).map(r => r.path).sort(), [
      `${base('owner-a')}/messages?limit=36`, `${base('owner-b')}/messages?limit=36`, `/api/hub/v1/sessions/${encodeURIComponent(sessionId)}/messages?limit=36`,
    ].sort());
    assert.equal(requests[3].path, `${base('owner-a')}/messages/message%2Fid`);
    assert.equal(requests[4].path, `${base('owner-a')}/queue`);
    assert.equal(requests[5].path, `${base('owner-a')}/queue?cursor=2%3A0`);
    assert.equal(result.queue.availability, 'unavailable', 'partial unavailable is not replaced by an available empty queue');
    assert.equal(requests[6].path, `${base('owner-a')}/commands/original-command/queue`);
    assert.equal(requests[6].headers['if-match'], '"1:2"');
    assert.equal(requests[6].headers['idempotency-key'], 'edit-key');
    assert.equal(requests[7].method, 'DELETE');
    assert.equal(requests[8].path, `${base('owner-a')}/commands/original-command/queue/commands/edit-key`);
    assert.equal(requests[9].path, `${base('owner-a')}/state`);
    assert.equal(result.execution.status, 'running');
    assert.equal(result.execution.runtime.connection, 'disconnected');
    assert.equal(result.stream, `${origin}${base('owner-a')}/events/stream?recoveryScope=${scope}`);
    assert.equal(result.ownerStream, `${origin}/api/hub/v1/events/stream?recoveryScope=${scope}`);
    // A lost queue mutation ACK survives refresh in the same journal. Recovery
    // GET addresses the original browser command, never a runtime queue ID.
    requests = []; offline = true;
    await page.evaluate(async () => {
      const { api, recoveryScope } = await import('/src/api.ts');
      const { sessionAddress } = await import('/src/lib/session-address.ts');
      const { CommandJournal, mutateQueueWithJournal } = await import('/src/lib/command-recovery.ts');
      const sessionKey = sessionAddress({ ownerUserId: 'owner-a', sessionId: 'local:c3ludGhldGlj' }).key;
      const journal = new CommandJournal(sessionStorage), scope = recoveryScope();
      try { await mutateQueueWithJournal(journal, scope, sessionKey, 'lost-cancel', { messageId: 'original-command', action: 'cancel' },
        () => api.cancelQueuedMessage(sessionKey, 'original-command', '1:2', 'lost-cancel', scope),
        async () => (await api.queueMutationCommand(sessionKey, 'original-command', 'lost-cancel', scope)).command); } catch {}
      window.dispatchEvent(new CustomEvent('agentopsdeck:commands-changed'));
    });
    await notice.getByText(/Queue cancellation — outcome unknown/).waitFor();
    assert.deepEqual(requests.map(r => [r.method, r.path]), [
      ['DELETE', `${base('owner-a')}/commands/original-command/queue`],
      ['GET', `${base('owner-a')}/commands/original-command/queue/commands/lost-cancel`],
    ]);
    assert.equal(await notice.getByRole('button', { name: 'Forget locally' }).count(), 0);
    offline = false;
    await page.reload();
    await notice.getByText(/Queue cancellation — applied/).waitFor();
    assert.equal(requests.length, 3);
    assert.equal(requests[2].method, 'GET');
    assert.equal(requests[2].path, `${base('owner-a')}/commands/original-command/queue/commands/lost-cancel`);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`shared addresses/recovery/cache/API routing passed ${viewport.width}px`);
  }
} finally { await browser?.close(); await server.close(); }
