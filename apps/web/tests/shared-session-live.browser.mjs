import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ?? 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const sessionId = 'node:c3ludGhldGlj', scope = 'a'.repeat(64);
const key = owner => JSON.stringify(['shared-session-v1', owner, sessionId]);
const hash = owner => `#/session/${encodeURIComponent(key(owner))}`;
const cursor = n => `ce1_11111111-1111-4111-8111-111111111111:${n}`;
const requests = [], streams = new Set(), states = new Map();
const state = owner => {
  if (!states.has(owner)) states.set(owner, { queueVersion: '1:1', queueConflict: true, queueReceipt: false, queueRemoved: false, queueReceipts: new Map(), version: 1, denied: false, offline: false, failSend: false, receipt: false, phase: 'running', messages: [
    { id: 'reply', sessionKey: sessionId, role: 'assistant', text: `${owner} first reply`, createdAt: 1 },
  ] });
  return states.get(owner);
};
function emit(owner, type, extra = {}, id = 'hub-delivery:1') {
  for (const stream of streams) if (stream.owner === owner) stream.res.write(`event: ${type}\nid: ${id}\ndata: ${JSON.stringify({ type, sessionKey: sessionId, ...extra })}\n\n`);
}
let server, browser;
server = await createServer({ root, configFile: false, logLevel: 'error', optimizeDeps: { force: true }, plugins: [react(), tailwindcss(), {
  name: 'shared-live-fixture', configureServer(instance) {
    instance.middlewares.use(async (req, res, next) => {
      if (req.url?.startsWith('/__shared')) {
        res.setHeader('content-type', 'text/html');
        res.end(await server.transformIndexHtml(req.url, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/shared-session-live.fixture.tsx"></script></body></html>')); return;
      }
      if (!req.url?.startsWith('/api/')) return next();
      const url = new URL(req.url, 'http://synthetic.test');
      const match = /^\/api\/hub\/v1\/shared\/([^/]+)\/sessions\/([^/]+)(.*)$/.exec(url.pathname);
      let raw = ''; for await (const chunk of req) raw += chunk;
      requests.push({ path: url.pathname, query: url.search, method: req.method, headers: req.headers, body: raw ? JSON.parse(raw) : undefined, owner: match?.[1] });
      const respond = (code, value) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
      if (!match || decodeURIComponent(match[2]) !== sessionId) return respond(404, { error: 'No owner-wide route in fixture' });
      const owner = match[1], suffix = match[3], current = state(owner);
      if ((suffix === '/events/stream' ? url.searchParams.get('recoveryScope') : req.headers['x-agentopsdeck-recovery-scope']) !== scope) return respond(401, { error: 'scope required' });
      if (current.denied) return respond(403, { error: 'revoked' });
      if (current.offline) return respond(502, { error: 'offline' });
      if (suffix === '/events/stream') {
        res.setHeader('content-type', 'text/event-stream'); res.setHeader('cache-control', 'no-store');
        res.write('event: heartbeat\ndata: \n\n');
        const stream = { owner, res }; streams.add(stream); res.on('close', () => streams.delete(stream)); return;
      }
      if (suffix === '/queue') {
        if (url.searchParams.has('cursor')) return respond(200, { availability: 'unavailable', items: [], nextCursor: null });
        const entry = (commandKey, state, version, commandState = 'accepted') => ({ commandKey, state, version, commandState, createdAt: 1 });
        return respond(200, { availability: 'available', items: current.queueRemoved ? [] : [
          entry('original-browser-command', 'queued', current.queueVersion),
          entry('already-started', 'dispatching', '2:1'), entry(null, 'queued', '3:1'),
          entry('unknown-admission', 'queued', '4:1', 'outcome_unknown'), entry('blocked-command', 'blocked', '5:1'),
        ], nextCursor: '2:0' });
      }
      if (suffix === '/commands/original-browser-command/queue' && req.method === 'DELETE') {
        const key = req.headers['idempotency-key'];
        const command = { id: key, key, state: 'accepted', createdAt: 1, updatedAt: 2, result: { status: 200, body: { ok: true } } };
        if (current.queueConflict) {
          current.queueConflict = false; current.queueVersion = '1:2';
          current.queueReceipts.set(key, { ...command, state: 'rejected', result: { status: 412, body: { error: 'version changed' } } });
          return respond(412, { error: 'version changed' });
        }
        current.queueReceipts.set(key, command);
        return respond(502, { error: 'lost cancellation acknowledgment' });
      }
      if (suffix.startsWith('/commands/original-browser-command/queue/commands/')) {
        const key = decodeURIComponent(suffix.split('/').at(-1)), command = current.queueReceipts.get(key);
        if (command?.state === 'rejected' || current.queueReceipt) return respond(200, { command });
        return respond(502, { error: 'queue receipt temporarily unavailable' });
      }
      if (suffix.startsWith('/commands/')) {
        if (!current.receipt) return respond(502, { error: 'receipt temporarily unavailable' });
        return respond(200, { command: { id: 'receipt', key: decodeURIComponent(suffix.split('/').at(-1)), state: 'accepted', createdAt: 1, updatedAt: 2, result: { status: 200, body: { ok: true, status: 'queued' } } } });
      }
      if (suffix === '/messages' && req.method === 'POST') {
        if (current.failSend) return respond(502, { error: 'lost acknowledgment' });
        return respond(200, { ok: true, status: 'queued' });
      }
      if (suffix === '/state') return respond(200, { sessionKey: sessionId, status: current.phase === 'completed' ? 'idle' : 'running',
        sourceCursor: cursor(current.version), runtime: { phase: current.phase, threadActivity: current.threadActivity, connection: 'connected', sync: 'current', lastEventAt: 1 } });
      if (suffix === '/messages') return respond(200, { messages: current.messages,
        ...(current.historyStatus ? { historyStatus: current.historyStatus } : { sourceCursor: cursor(current.version) }), updatedAt: current.version,
        ...(current.historyCursor ? { sourceCursor: current.historyCursor } : {}),
        access: current.access ?? { messagesSend: true, eventsRead: true } });
      if (suffix === '/messages/tool-result') return respond(200, { message: { id: 'tool-result', sessionKey: sessionId, role: 'tool', text: 'Exact shared tool detail', createdAt: 1 }, updatedAt: 1 });
      return respond(404, { error: 'unknown exact path' });
    });
  },
} ], server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    requests.length = 0; states.clear();
    const context = await browser.newContext({ viewport });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(), errors = []; page.setDefaultTimeout(12_000);
    page.on('pageerror', error => { errors.push(error.message); console.error('fixture page error:', error.stack); });
    state('read-only').access = { messagesSend: false, eventsRead: false };
    await page.goto(`${origin}/__shared${hash('read-only')}`);
    await page.getByText('read-only first reply', { exact: true }).waitFor();
    await page.getByText('Live link: unavailable for this access', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('textbox', { name: 'Shared message' }).isDisabled(), true);
    assert.equal(requests.filter(request => request.path.endsWith('/events/stream') || request.method === 'POST').length, 0);
    state('read-only').access = { messagesSend: true, eventsRead: true };
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByText('Live link: connected', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true, 'empty draft remains disabled');
    assert.equal(await page.getByRole('textbox', { name: 'Shared message' }).isDisabled(), false);
    state('read-only').access = { messagesSend: false, eventsRead: false };
    emit('read-only', 'session.invalidated', { sourceCursor: cursor(2) });
    await page.getByText('Live link: unavailable for this access', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Shared message' }).isDisabled(), true);
    assert.match(await page.getByTestId('shared-execution').textContent(), /Execution: run\b/);
    await page.getByText('read-only first reply', { exact: true }).waitFor();
    const subscriptions = requests.filter(request => request.path.endsWith('/events/stream')).length;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByText('Messages: stale', { exact: true }).waitFor();
    assert.equal(requests.filter(request => request.path.endsWith('/events/stream')).length, subscriptions);
    // A verified native session page deliberately has no global cursor. Known
    // invalidations must not deadlock the composer; cached text or fresh policy
    // revocation must still block sending. This is actual UI with mock HTTP,
    // not evidence of Connector/native-model acceptance.
    state('session-proof').historyStatus = 'verified-session';
    await page.goto(`${origin}/__shared${hash('session-proof')}`);
    await page.getByText('session-proof first reply', { exact: true }).waitFor();
    await page.getByText('Live link: connected', { exact: true }).waitFor();
    const proofInput = page.getByRole('textbox', { name: 'Shared message', exact: true });
    const proofSend = page.getByRole('button', { name: 'Send', exact: true });
    await proofInput.fill('session proof draft');
    for (const [historyStatus, version] of [['verified-session', 10], ['cached', 11], ['verified-session', 12]]) {
      Object.assign(state('session-proof'), { historyStatus, version, messages: [
        { id: 'reply', sessionKey: sessionId, role: 'assistant', text: `session proof ${version}`, createdAt: version },
      ] });
      emit('session-proof', 'session.invalidated', { sourceCursor: cursor(version) });
      await page.getByText(`session proof ${version}`, { exact: true }).waitFor();
      await page.getByText(`Messages: ${historyStatus === 'cached' ? 'stale' : 'ready'}`, { exact: true }).waitFor();
      assert.equal(await proofSend.isDisabled(), historyStatus === 'cached');
      assert.equal(await proofInput.inputValue(), 'session proof draft', 'history verification must preserve the unsent draft');
      await page.getByText('State sync: ready', { exact: true }).waitFor();
    }
    state('session-proof').historyCursor = cursor(13);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByText('Messages: unavailable', { exact: true }).waitFor();
    assert.equal(await proofSend.isDisabled(), true, 'malformed session proof cannot enable sending');
    assert.equal(await proofInput.inputValue(), 'session proof draft');
    await page.getByText('State sync: ready', { exact: true }).waitFor();
    delete state('session-proof').historyCursor;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByText('Messages: ready', { exact: true }).waitFor();
    assert.equal(await proofSend.isDisabled(), false, 'fresh valid proof can restore readiness without submitting');
    assert.equal(await proofInput.inputValue(), 'session proof draft');
    state('session-proof').access = { messagesSend: false, eventsRead: false };
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByText('Live link: unavailable for this access', { exact: true }).waitFor();
    await page.getByText('Messages: ready', { exact: true }).waitFor();
    assert.equal(await proofSend.isDisabled(), true, 'verified history is not send permission');
    assert.equal(await proofInput.isDisabled(), true);
    assert.equal(requests.filter(request => request.owner === 'session-proof' && request.method === 'POST').length, 0);
    requests.length = 0;
    await page.goto(`${origin}/__shared${hash('owner-a')}`);
    await page.getByText('owner-a first reply', { exact: true }).waitFor();
    await page.getByText('State sync: ready', { exact: true }).waitFor();
    await page.getByText('Live link: connected', { exact: true }).waitFor();
    assert.equal(requests.every(request => request.owner === 'owner-a'), true);
    assert.equal(await page.getByText('Owner workspace placeholder').count(), 0);
    assert.match(await page.getByTestId('shared-execution').textContent(), /Execution: run\b/);

    // Preserve a selected bubble while fresh messages are appended.
    await page.evaluate(() => {
      const node = document.querySelector('[data-message-search-id="reply"] p');
      const range = document.createRange(); range.selectNodeContents(node);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    state('owner-a').version = 2;
    state('owner-a').messages = [
      { ...state('owner-a').messages[0], text: 'owner-a changed reply' },
      { id: 'tool-result', sessionKey: sessionId, role: 'tool', text: 'tool: exec_command\nsynthetic result', toolName: 'exec_command', toolCallId: 'call-1', toolPhase: 'result', toolDetailAvailable: true, createdAt: 2 },
      { id: 'new-reply', sessionKey: sessionId, role: 'assistant', text: 'Automatic final reply', createdAt: 2, phase: 'final_answer' },
    ];
    emit('owner-a', 'session.invalidated', { sourceCursor: cursor(2) });
    await page.getByText('Automatic final reply', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => getSelection().toString()), 'owner-a first reply');
    await page.evaluate(() => getSelection().removeAllRanges());
    await page.getByText('owner-a changed reply', { exact: true }).waitFor();
    await page.getByRole('button', { name: /Click to inspect/ }).click();
    await page.getByText('Exact shared tool detail', { exact: true }).waitFor();
    assert.equal(requests.filter(request => request.path.endsWith('/messages/tool-result')).at(-1).owner, 'owner-a');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole('button', { name: 'Close tool result detail' }).click();

    // Shared queue is opt-in; never use runtime IDs or transcript text to
    // invent a mapping. Conflicts require explicit refresh, unknowns only GET.
    assert.equal(requests.filter(request => request.path.endsWith('/queue')).length, 0);
    await page.getByRole('button', { name: 'My queue', exact: true }).click();
    const queue = page.getByRole('region', { name: 'My shared queue', exact: true });
    const original = queue.getByRole('listitem').filter({ hasText: 'original-browser-command' });
    await original.waitFor();
    assert.equal(await queue.getByRole('listitem').count(), 5);
    assert.equal(await queue.getByRole('button', { name: 'Cancel queued command' }).evaluateAll(buttons => buttons.filter(button => !button.disabled).length), 2);
    assert.equal(await queue.getByRole('textbox').count(), 0, 'no unversioned text editor');
    await queue.getByRole('button', { name: 'Next segment', exact: true }).click();
    await queue.getByText(/This historical queue segment is unavailable, not empty/).waitFor();
    assert.equal(requests.filter(request => request.path.endsWith('/queue')).at(-1).query, '?cursor=2%3A0');
    await queue.getByRole('button', { name: 'First segment', exact: true }).click();
    await original.waitFor();
    await original.getByRole('button', { name: 'Cancel queued command' }).click();
    await original.getByRole('button', { name: 'Confirm cancel', exact: true }).click();
    await queue.getByText(/Queue version changed/).waitFor();
    assert.equal(requests.filter(request => request.method === 'DELETE').length, 1);
    assert.equal(requests.filter(request => request.method === 'DELETE')[0].headers['if-match'], '"1:1"');
    await queue.getByRole('button', { name: 'Refresh queue', exact: true }).click();
    await original.getByRole('button', { name: 'Cancel queued command' }).click();
    await original.getByRole('button', { name: 'Confirm cancel', exact: true }).click();
    await queue.getByText(/Queue modification not confirmed/).waitFor();
    assert.equal(requests.filter(request => request.method === 'DELETE').length, 2);
    assert.equal(requests.filter(request => request.method === 'DELETE')[1].headers['if-match'], '"1:2"');
    assert.equal(await original.getByRole('button', { name: 'Cancel queued command' }).isDisabled(), true);
    await queue.getByRole('button', { name: 'Refresh queue', exact: true }).click();
    await original.waitFor();
    assert.equal(await original.getByRole('button', { name: 'Cancel queued command' }).isDisabled(), true);
    await page.reload();
    const recovery = page.getByRole('region', { name: 'Command delivery recovery' });
    await recovery.getByText(/Queue cancellation — outcome unknown/).waitFor();
    assert.equal(await recovery.getByRole('button', { name: 'Forget locally', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'My queue', exact: true }).click();
    await original.waitFor();
    assert.equal(await original.getByRole('button', { name: 'Cancel queued command' }).isDisabled(), true);
    state('owner-a').queueReceipt = true; state('owner-a').queueRemoved = true;
    await recovery.getByRole('button', { name: 'Check receipt', exact: true }).click();
    await recovery.getByText(/Queue cancellation — applied/).waitFor();
    await queue.getByText(/No queued commands in this segment/).waitFor();
    assert.equal(requests.filter(request => request.method === 'DELETE').length, 2, 'refresh/reload/recovery never retries the cancellation');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole('button', { name: 'Hide queue', exact: true }).click();
    while (await recovery.getByRole('button', { name: 'Dismiss', exact: true }).count()) await recovery.getByRole('button', { name: 'Dismiss', exact: true }).first().click();

    state('owner-a').offline = true;
    emit('owner-a', 'stream.status', { payload: { connection: 'disconnected' } });
    await page.getByText('State sync: unavailable', { exact: true }).waitFor();
    assert.match(await page.getByTestId('shared-execution').textContent(), /Execution: run \(last known\)/);
    await page.getByText('Node link: disconnected', { exact: true }).waitFor();
    state('owner-a').offline = false; state('owner-a').version = 3; state('owner-a').phase = 'completed';
    emit('owner-a', 'session.invalidated', { sourceCursor: cursor(3) });
    await page.getByText('Execution: completed', { exact: true }).waitFor();
    for (const activity of ['running', 'waiting', 'unknown', 'idle']) {
      state('owner-a').threadActivity = activity;
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.getByText(`Thread: ${activity}`, { exact: true }).waitFor();
      await page.getByText('Execution: completed', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }

    // Close the real SSE socket: a dropped event is recovered by snapshot GET,
    // without reloading the document or inferring an execution transition.
    state('owner-a').version = 4;
    state('owner-a').messages.push({ id: 'after-drop', sessionKey: sessionId, role: 'assistant', text: 'Reply recovered after stream drop', createdAt: 4 });
    for (const stream of streams) if (stream.owner === 'owner-a') stream.res.end();
    await page.getByText('Reply recovered after stream drop', { exact: true }).waitFor();
    await page.getByText('Live link: connected', { exact: true }).waitFor();

    const forward = page.getByRole('checkbox', { name: 'Forward the original reply to this session’s channel' });
    assert.equal(await forward.count(), 0);
    state('owner-a').access = { messagesSend: true, messagesMirror: true, eventsRead: true };
    state('owner-a').version = 5;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await forward.waitFor();
    assert.equal(await forward.isChecked(), false);
    await forward.check();
    await page.getByRole('textbox', { name: 'Shared message' }).fill('synthetic secret draft');
    const beforeRevocation = requests.filter(request => request.method === 'POST').length;
    state('owner-a').access = { messagesSend: true, eventsRead: true };
    state('owner-a').version = 3;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByText('Forwarding access is unavailable. Sending is blocked; uncheck forwarding to send web-only.').waitFor();
    assert.equal(await forward.isChecked(), true);
    assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
    assert.equal(requests.filter(request => request.method === 'POST').length, beforeRevocation);
    await forward.click();
    await forward.waitFor({ state: 'detached' });
    state('owner-a').access = { messagesSend: true, messagesMirror: true, eventsRead: true };
    state('owner-a').version = 6;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await forward.waitFor();
    await page.getByText('Messages: ready', { exact: true }).waitFor();
    await forward.check();

    // No new POST on lost ACK/reload; the existing recovery UI only queries.
    state('owner-a').failSend = true;
    await page.getByRole('textbox', { name: 'Shared message' }).fill('synthetic secret draft');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('region', { name: 'Command delivery recovery' }).getByRole('button', { name: 'Check receipt', exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Shared message' }).inputValue(), '');
    assert.equal(await page.evaluate(() => JSON.stringify(sessionStorage).includes('synthetic secret draft')), false);
    const posts = requests.filter(request => request.method === 'POST').length;
    const originalMirror = requests.filter(request => request.method === 'POST').at(-1);
    assert.equal(originalMirror.owner, 'owner-a');
    assert.equal(originalMirror.body.deliveryMode, 'mirror');
    assert.equal(originalMirror.body.message, 'synthetic secret draft');
    assert.equal(Object.hasOwn(originalMirror.body, 'media'), false);
    state('owner-a').receipt = true;
    const mirrorKey = originalMirror.body.idempotencyKey;
    assert.equal(typeof mirrorKey, 'string');
    const mirrorReceipt = page.waitForResponse(response => response.request().method() === 'GET'
      && new URL(response.url()).pathname === `/api/hub/v1/shared/owner-a/sessions/${encodeURIComponent(sessionId)}/commands/${encodeURIComponent(mirrorKey)}`
      && response.status() === 200);
    await page.reload();
    await mirrorReceipt;
    await page.waitForFunction(commandKey => !JSON.parse(sessionStorage.getItem('agentopsdeck.command-recovery.v1') ?? '[]')
      .some(row => row.key === commandKey), mirrorKey);
    await page.getByRole('region', { name: 'Command delivery recovery' }).waitFor({ state: 'detached' });
    assert.equal(requests.filter(request => request.method === 'POST').length, posts);
    assert.equal(await forward.isChecked(), false, 'reload never recreates a selected delivery intent');

    // replaceState navigation is observable, closes the prior resource feed,
    // and cannot show/recover another owner's same-ID session.
    await page.evaluate(() => window.sharedFixture.navigate('owner-b'));
    await page.getByText('owner-b first reply', { exact: true }).waitFor();
    assert.equal(await page.getByText('Automatic final reply', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('region', { name: 'Command delivery recovery' }).count(), 0);
    assert.equal(await forward.count(), 0, 'another owner cannot inherit the previous mirror hint');
    assert.equal(requests.filter(request => request.owner === 'owner-b' && request.path.includes('/commands/')).length, 0);
    await page.waitForFunction(() => document.querySelector('[aria-label="Shared session status"]').textContent.includes('Live link: connected'));
    state('owner-b').denied = true;
    emit('owner-b', 'session.invalidated', { sourceCursor: cursor(2) });
    await page.getByRole('alert').getByText('Shared access is no longer available.', { exact: false }).waitFor();
    assert.equal(await page.getByText('owner-b first reply', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('input[type=file]').isDisabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

    // Actual browser FileReader -> shared composer -> one original attachment
    // command. Recovery storage contains only the reference, never image data.
    await page.evaluate(() => window.sharedFixture.navigate('owner-images'));
    await page.getByText('owner-images first reply', { exact: true }).waitFor();
    await page.getByText('Messages: ready', { exact: true }).waitFor();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
    const image = { name: 'private-original.png', mimeType: 'image/png', buffer: png };
    const images = page.locator('input[type=file]');
    await images.setInputFiles(image);
    await page.getByRole('button', { name: 'Clear attachments', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(), false, 'attachment-only message allowed');
    const imagePostsBefore = requests.filter(request => request.method === 'POST').length;
    state('owner-images').failSend = true;
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('region', { name: 'Command delivery recovery' }).getByRole('button', { name: 'Check receipt', exact: true }).waitFor();
    const sentImage = requests.filter(request => request.method === 'POST').at(-1);
    assert.equal(sentImage.owner, 'owner-images');
    assert.equal(typeof sentImage.body.idempotencyKey, 'string');
    assert.deepEqual(sentImage.body, { message: '', deliveryMode: 'web-only', idempotencyKey: sentImage.body.idempotencyKey, media: [{
      type: 'image', name: image.name, mimeType: image.mimeType, size: png.length, dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    }] });
    assert.equal(requests.filter(request => request.method === 'POST').length, imagePostsBefore + 1);
    assert.equal(await page.evaluate(() => /private-original|data:image|base64/.test(JSON.stringify(sessionStorage))), false);
    state('owner-images').receipt = true;
    const imageKey = sentImage.body.idempotencyKey;
    const imageReceipt = page.waitForResponse(response => response.request().method() === 'GET'
      && new URL(response.url()).pathname === `/api/hub/v1/shared/owner-images/sessions/${encodeURIComponent(sessionId)}/commands/${encodeURIComponent(imageKey)}`
      && response.status() === 200);
    await page.reload();
    await imageReceipt;
    await page.waitForFunction(commandKey => !JSON.parse(sessionStorage.getItem('agentopsdeck.command-recovery.v1') ?? '[]')
      .some(row => row.key === commandKey), imageKey);
    await page.getByRole('region', { name: 'Command delivery recovery' }).waitFor({ state: 'detached' });
    assert.equal(requests.filter(request => request.method === 'POST').length, imagePostsBefore + 1);
    assert.equal(await page.getByRole('button', { name: 'Clear attachments', exact: true }).count(), 0);
    await images.setInputFiles(image);
    await page.getByRole('button', { name: 'Clear attachments', exact: true }).waitFor();
    await page.evaluate(() => { window.sharedFixture.account('b'.repeat(64)); window.sharedFixture.account('a'.repeat(64)); });
    await page.getByText('owner-images first reply', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Clear attachments', exact: true }).count(), 0, 'ABA identity cannot retain selected images');
    assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

    const beforeInvalid = requests.length;
    await page.evaluate(() => { location.hash = '#/session/%5Bbroken'; });
    await page.getByText('Invalid session link. No session was opened.').waitFor();
    assert.equal(requests.length, beforeInvalid);
    await page.getByRole('link', { name: 'Back to sessions' }).click();
    await page.getByText('Owner workspace placeholder').waitFor();
    assert.deepEqual(errors, []);
    await context.close();
    assert.equal([...streams].filter(stream => !stream.res.destroyed).length, 0, 'all exact feeds close after view teardown');
    console.log(`shared actual view/navigation/SSE/snapshots/selection/receipt passed ${viewport.width}px`);
  }
} finally {
  for (const stream of streams) stream.res.end();
  await browser?.close(); await server.close();
}
