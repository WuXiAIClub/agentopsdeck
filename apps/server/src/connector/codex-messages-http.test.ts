import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { CodexAppServer } from '../codex/app-server.js';
import { RolloutProjection } from '../codex/rollout-projection.js';
import { createHash } from 'node:crypto';
import { loadConfig } from '../config.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { DeckStore } from '../projection/deck-store.js';
import { registerConnectorRoutes } from '../routes/connector.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncCodexHistory } from './async-codex-history.js';
import { codexMessageAdmission } from './connector-codex-message-domain.js';
import { createAsyncCodexMessageIngress } from './async-codex-message-ingress.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { registerCodexMessagesHttp } from './codex-messages-http.js';

const token = 'isolated-codex-http-token', authorization = `Bearer ${token}`, key = 'codex:original';
const silent = new PerformanceDiagnostics(() => {});
const route = '/sessions/:sessionKey', path = `/sessions/${encodeURIComponent(key)}`;
async function fixture(worker = false, fullRoutes = false, withStop = false, hydrate = false) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-message-http-'));
  const tokenFile = join(directory, 'tokens.json'), tokens = new ConnectorTokenStore(tokenFile, token, silent);
  const local = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const original = createConnectorOwnerCommands(local, tokens);
  if (withStop && worker) {
    const seed = new ConnectorUserStore(join(directory, 'connector.sqlite'));
    seed.codexExecutions.begin(key, 'original-command', 'connection');
    seed.codexExecutions.acknowledge(key, 'original-command', 'connection', 'native-turn', () => {});
    seed.close();
  }
  const owner = worker ? new AsyncConnectorOwner({ file: join(directory, 'connector.sqlite'), tokenFile, bootstrapToken: token }, silent) : undefined;
  if (owner) await owner.open();
  const commands: string[] = [], logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const hooks: { after?: (kind: string) => void; persist?: () => Promise<void>; prepare?: () => Promise<void> } = {};
  const command: AsyncConnectorOwner['command'] = async (kind, input) => {
    commands.push(kind); const result = await (owner ? owner.command(kind, input) : original(kind, input)); hooks.after?.(kind); return result;
  };
  const deck = new DeckStore({ sessionTitlesFile: join(directory, 'titles.json') });
  deck.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Original', status: 'idle' });
  const runtime = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: directory,
    defaultModel: 'test', approvalPolicy: 'never', store: deck, turnQueue: local.turns,
    executions: local.codexExecutions, authorizeTurn: () => assert.fail('HTTP must not dispatch locally') });
  runtime.send = async () => assert.fail('async HTTP must not call the original send');
  const native: string[] = [];
  if (withStop) {
    const executor = runtime as any;
    executor.setConnection('connection'); executor.ensureStarted = async () => {};
    if (!worker) {
      local.codexExecutions.begin(key, 'original-command', 'connection');
      local.codexExecutions.acknowledge(key, 'original-command', 'connection', 'native-turn', () => {});
    }
    executor.request = async (method: string) => {
      native.push(method);
      if (method === 'turn/interrupt') return {};
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      assert.equal(method, 'thread/read');
      return { thread: { id: 'original', path: 'isolated-rollout', turns: [{ id: 'native-turn', status: 'interrupted', items: [] }] } };
    };
    executor.rolloutReader.readSnapshot = async () => new RolloutProjection([]);
    if (worker) {
      local.codexExecutions.get = () => assert.fail('HTTP stop must not use main-thread execution SQL');
      local.codexExecutions.cleanupRecovered = () => assert.fail('HTTP stop must not use main-thread cleanup SQL');
    }
  }
  let effects = 0, fallback = 0;
  const ingress = createAsyncCodexMessageIngress({ owner: { command }, runtime, ...(withStop ? { stopRuntime: runtime } : {}), diagnostics, persist: async media => {
    effects++; await hooks.persist?.();
    return (media ?? []).map(() => ({ filePath: '/isolated/private.png', media: {
      type: 'image' as const, url: '/api/media/inbound/image.png', name: 'image.png', size: 1, mimeType: 'image/png' } }));
  }, ...(hydrate ? { prepareSession: async () => { native.push('read-only-hydrate'); await hooks.prepare?.();
    deck.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Restored', status: 'idle' }); } } : {}) });
  const app = new Hono();
  const routes = fullRoutes ? registerConnectorRoutes(app, { config: loadConfig({} as NodeJS.ProcessEnv), tokens, connectorUsers: local,
    store: deck, gateway: {} as any, codex: runtime, codexMessages: ingress.codexMessages,
    refreshSessions: async () => {}, refreshMessages: async () => {}, sessionSnapshotReady: () => true, historySnapshotReady: () => true,
    fallbackAgents: () => [], isAuthorizedRequest: () => true, normalizeError: () => 'private error' }) : undefined;
  if (!routes) {
    registerCodexMessagesHttp(app, route, ingress.codexMessages);
    app.post(`${route}/messages`, async c => { fallback++; return c.json({ control: await c.req.json() }); });
    app.get(`${route}/commands/:commandKey`, c => { fallback++; return c.json({ legacy: true }); });
  }
  const base = fullRoutes ? `/api/connector/v1${path}` : path;
  const post = (body: unknown, headers: Record<string, string> = {}) => app.request(`${base}/messages`, {
    method: 'POST', headers: { authorization, ...headers }, body: JSON.stringify(body),
  });
  const get = (commandKey: string, credential = authorization, queue = false) => app.request(`${base}/commands/${commandKey}${queue ? '/queue' : ''}`, {
    headers: { authorization: credential },
  });
  return { app, post, get, owner, local, tokens, original, ingress, runtime, deck, hooks, commands, logs, native,
    effects: () => effects, fallback: () => fallback,
    async close() { await ingress.close(); await routes?.close(); await runtime.close(); original.dispose();
      local.close(); await owner?.closeForShutdown(); rmSync(directory, { recursive: true, force: true }); } };
}

for (const worker of [false, true]) {
  test(`cold admission hydrates only after exact send authority, worker=${worker}`, async () => {
    const f = await fixture(worker, false, false, true);
    try {
      f.deck.removeSession(key);
      const p = { message: 'Cold first send', idempotencyKey: 'cold-first' };
      assert.equal((await f.post(p, { authorization: 'Bearer unknown' })).status, 401);
      assert.deepEqual(f.native, []); assert.equal(f.effects(), 0);
      const read = await (worker ? f.owner!.command('tokenCreate', { label: 'read', scopes: ['messages:read'] })
        : Promise.resolve(f.tokens.create({ label: 'read', scopes: ['messages:read'] })));
      assert.equal((await f.post(p, { authorization: `Bearer ${read.token}` })).status, 403);
      assert.deepEqual(f.native, []); assert.equal(f.commands.includes('codexMessageClaim'), false);
      const response = await f.post(p); assert.equal(response.status, 200);
      assert.equal((await response.json()).command.state, 'accepted');
      assert.deepEqual(f.native, ['read-only-hydrate']); assert.equal(f.effects(), 1);
      f.deck.removeSession(key);
      assert.equal((await f.post(p)).status, 200);
      assert.equal((await f.post({ ...p, message: 'Conflict' })).status, 409);
      assert.deepEqual(f.native, ['read-only-hydrate']); assert.equal(f.effects(), 1);
    } finally { await f.close(); }
  });
  test(`cold hydration failure never claims a fresh durable 404, worker=${worker}`, async () => {
    const f = await fixture(worker, false, false, true);
    try {
      f.deck.removeSession(key); f.hooks.prepare = async () => { throw new Error('Native state unknown'); };
      assert.equal((await f.post({ message: 'Unknown', idempotencyKey: 'unknown-cold' })).status, 503);
      assert.equal(f.commands.includes('codexMessageClaim'), false); assert.equal(f.effects(), 0);
      const receipt = await f.get('unknown-cold');
      assert.equal(receipt.status, 404);
      assert.equal((await receipt.json()).error, 'Command not found');
    } finally { await f.close(); }
  });
  test(`revocation during cold hydration denies before claim/files, worker=${worker}`, async () => {
    const f = await fixture(worker, false, false, true);
    try {
      const issued = await (worker ? f.owner!.command('tokenCreate', { label: 'sender', scopes: ['messages:send'] })
        : Promise.resolve(f.tokens.create({ label: 'sender', scopes: ['messages:send'] })));
      f.deck.removeSession(key);
      f.hooks.prepare = async () => {
        const revoked = worker ? await f.owner!.command('tokenRevoke', { tokenId: issued.record.id }) : f.tokens.revoke(issued.record.id);
        assert.equal(revoked, true);
      };
      assert.equal((await f.post({ message: 'Revoked', idempotencyKey: 'revoked-cold' }, { authorization: `Bearer ${issued.token}` })).status, 401);
      assert.equal(f.commands.includes('codexMessageClaim'), false); assert.equal(f.effects(), 0);
    } finally { await f.close(); }
  });
  test(`close retains entered cold hydration and denies its admission, worker=${worker}`, async () => {
    const f = await fixture(worker, false, false, true);
    try {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(r => { enter = r; }), pending = new Promise<void>(r => { release = r; });
      f.deck.removeSession(key); f.hooks.prepare = async () => { enter(); await pending; };
      const response = f.post({ message: 'Closing', idempotencyKey: 'closed-cold' }); await entered;
      let closed = false; const closing = f.ingress.close().then(() => { closed = true; });
      await new Promise<void>(r => setImmediate(r)); assert.equal(closed, false);
      release(); assert.equal((await response).status, 503); await closing;
      assert.equal(f.commands.includes('codexMessageClaim'), false); assert.equal(f.effects(), 0);
    } finally { await f.close(); }
  });
}

for (const worker of [false, true]) test(`complete stop HTTP original executor, immutable ACK, frontend response, worker=${worker}`, async () => {
  const f = await fixture(worker, true, true);
  try {
    const payload = { message: ' /stop ', expectedRunId: 'native-turn', idempotencyKey: 'stop-key', metadata: 'private-stop' };
    const response = await f.post(payload); assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true); assert.equal(body.status, 'interrupt_requested'); assert.equal(body.runId, 'native-turn');
    assert.equal(body.idempotencyKey, 'stop-key'); assert.deepEqual(body.media, []); assert.equal(body.command.state, 'accepted');
    assert.equal(response.headers.get('x-agentopsdeck-command-key'), 'stop-key');
    assert.deepEqual(await (await f.post(payload)).json(), body);
    assert.equal(f.native.filter(method => method === 'turn/interrupt').length, 1);
    assert.equal((await f.post({ ...payload, metadata: 'changed' })).status, 409);
    assert.equal(f.effects(), 0); assert.equal(f.fallback(), 0); assert.deepEqual(f.deck.getMessages(key), []);
    assert.ok(f.commands.includes('codexStopReady')); assert.ok(f.commands.includes('codexStopReceiptRead'));
    assert.equal(f.commands.includes('codexMessageClaim'), false);
    assert.doesNotMatch(f.logs.join('\n'), /private-stop|isolated-codex-http-token|native-turn|original-command/);
    const read = await f.get('stop-key'); assert.equal(read.status, 200);
    assert.equal((await read.json()).command.state, 'accepted');
    assert.equal(f.native.filter(method => method === 'turn/interrupt').length, 1);
  } finally { await f.close(); }
});

test('stop HTTP authority, expected native turn and node fences reject before native and files', async () => {
  const f = await fixture(true, true, true);
  try {
    const reader = await f.owner!.command('tokenCreate', { label: 'stop-reader', scopes: ['messages:read'] });
    const payload = { message: '/stop', expectedRunId: 'native-turn', idempotencyKey: 'stop-key' };
    assert.equal((await f.post(payload, { authorization: `Bearer ${reader.token}` })).status, 403);
    assert.equal((await f.post(payload, { 'x-agentopsdeck-expected-node-id': 'foreign' })).status, 409);
    assert.equal((await f.post({ ...payload, expectedRunId: 'original-command' })).status, 409);
    assert.equal(f.native.length, 0); assert.equal(f.effects(), 0);
  } finally { await f.close(); }
});

test('original wire response, queued frontend projection and read-only command/queue remain compatible', async () => {
  const f = await fixture();
  try {
    const payload = { message: ' original ', metadata: 'private-fingerprint', idempotencyKey: 'original-key' };
    const first = await f.post(payload); assert.equal(first.status, 200);
    const body = await first.json(); assert.equal(body.ok, true); assert.equal(body.status, 'queued');
    assert.equal(body.command.key, 'original-key'); assert.equal(body.admission.disposition, 'preparing');
    assert.equal(first.headers.get('cache-control'), 'no-store'); assert.equal(first.headers.get('x-agentopsdeck-command-key'), 'original-key');
    assert.deepEqual(f.deck.getMessages(key).map(m => [m.id, m.text, m.status, m.queueVersion, m.queueDisposition]),
      [[body.runId, 'original', 'queued', body.admission.queueVersion, 'preparing']]);
    const before = f.commands.length;
    assert.deepEqual(await (await f.post(payload)).json(), body); assert.equal(f.effects(), 1);
    assert.deepEqual(f.commands.slice(before), ['codexMessageClaim', 'codexMessageSendReceiptRead']);
    assert.equal((await f.post({ ...payload, metadata: 'changed' })).status, 409);
    const read = await f.get('original-key'); assert.equal(read.status, 200);
    assert.equal((await read.json()).command.result.body.runId, body.runId);
    const queue = await f.get('original-key', authorization, true); assert.equal(queue.status, 200);
    assert.equal((await queue.json()).queue.presence, 'present'); assert.equal(f.fallback(), 0);
    assert.equal((await f.get('missing')).status, 404);
    assert.ok(f.logs.some(line => line.includes('codex-message-http')));
    assert.ok(f.logs.some(line => line.includes('codex-message')));
    assert.doesNotMatch(f.logs.join('\n'), /private-fingerprint|original-key|isolated-codex-http-token|private.png/);
  } finally { await f.close(); }
});

for (const control of ['/stop', ' /stop ']) test(`${JSON.stringify(control)} stays on original control lane with original body`, async () => {
  const f = await fixture();
  try {
    const reader = f.tokens.create({ label: 'control-reader', scopes: ['sessions:read'] });
    const payload = { message: control, expectedRunId: 'original-run', idempotencyKey: 'control-key', metadata: 'keep' };
    const response = await f.post(payload, { authorization: `Bearer ${reader.token}` }); assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).control, payload); assert.equal(f.fallback(), 1);
    assert.equal(f.effects(), 0); assert.deepEqual(f.commands, []);
  } finally { await f.close(); }
});

for (const text of ['/status', ' /status ', '/compact', ' /compact ']) for (const image of [false, true])
test(`Codex ${JSON.stringify(text)} is an ordinary worker message, image=${image}`, async () => {
  const f = await fixture(true, true), history = new AsyncCodexHistory(f.owner!, silent);
  try {
    f.local.commands.claimAsync = async () => assert.fail('ordinary text must not claim an old receipt');
    f.local.commands.get = () => assert.fail('ordinary text must not read old receipts');
    f.local.turns.enqueueAsync = async () => assert.fail('ordinary text must not enqueue on main thread');
    f.local.turns.list = () => assert.fail('ordinary text must not list old queue');
    f.local.turns.version = () => assert.fail('ordinary text must not read old versions');
    const reader = await f.owner!.command('tokenCreate', { label: 'reader', scopes: ['sessions:read', 'messages:read'] });
    const payload = { message: text, idempotencyKey: 'ordinary-slash', metadata: 'fingerprint',
      ...(image ? { media: [{ dataUrl: 'data:image/png;base64,YQ==', name: 'private.png' }] } : {}) };
    assert.equal((await f.post(payload, { authorization: `Bearer ${reader.token}` })).status, 403);
    assert.equal(f.effects(), 0);
    const response = await f.post(payload); assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.status, 'queued');
    assert.equal(body.command.key, payload.idempotencyKey); assert.equal(body.media.length, image ? 1 : 0);
    const snapshot = await history.prepare(key, []); assert.equal(snapshot.queue.length, 1);
    assert.equal(snapshot.queue[0]!.entry.payload.text, text.trim());
    assert.equal(snapshot.queue[0]!.entry.payload.images.length, image ? 1 : 0);
    assert.equal(f.deck.getMessages(key).find(m => m.id === body.runId)?.text, text.trim());
    assert.deepEqual(await (await f.post(payload)).json(), body); assert.equal(f.effects(), 1);
    assert.equal((await f.post({ ...payload, message: text.trim() === text ? ` ${text} ` : text.trim() })).status, 409);
    assert.equal(f.effects(), 1); assert.equal((await history.prepare(key, [])).queue.length, 1);
    assert.ok(f.commands.includes('codexMessageCommit')); assert.equal(f.fallback(), 0);
  } finally { await history.close(); await f.close(); }
});

test('HTTP key validation, body errors, foreign runtime and unauthorized requests do not mint receipts', async () => {
  const f = await fixture();
  try {
    for (const body of [[], null]) assert.equal((await f.post(body)).status, 400);
    assert.equal((await f.post({ message: 'original', idempotencyKey: 'a' }, { 'idempotency-key': 'b' })).status, 400);
    assert.equal((await f.post({ message: 'original', idempotencyKey: '../bad' })).status, 400);
    assert.equal((await f.post({ message: 'original' }, { authorization: '' })).status, 401);
    assert.equal(f.effects(), 0); assert.deepEqual(f.commands, []);
    const foreign = await f.app.request('/sessions/hermes%3Aforeign/messages', { method: 'POST', body: '{"message":"foreign"}' });
    assert.equal(foreign.status, 200); assert.equal(f.fallback(), 1); assert.deepEqual(f.commands, []);
  } finally { await f.close(); }
});

test('runtime close is unavailable rather than missing; old acceptance can still be recovered without publishing again', async () => {
  const f = await fixture();
  try {
    const payload = { message: 'original', idempotencyKey: 'before-close' };
    const body = await (await f.post(payload)).json();
    await f.runtime.close();
    assert.deepEqual(await (await f.post(payload)).json(), body);
    assert.equal((await f.post({ message: 'new', idempotencyKey: 'closed' })).status, 409);
    assert.equal(f.effects(), 1);
    const read = await f.get('closed'); assert.equal(read.status, 200); assert.equal((await read.json()).command.state, 'rejected');
  } finally { await f.close(); }
});

test('lost commit delivery ACK returns unknown; read-only original command recovers acceptance without replay', async () => {
  const f = await fixture();
  try {
    f.hooks.after = kind => { if (kind === 'codexMessageCommit') throw Error('private lost ACK'); };
    const payload = { message: 'original', idempotencyKey: 'lost-commit' };
    const response = await f.post(payload); assert.equal(response.status, 503);
    assert.equal((await response.json()).status, 'outcome_unknown'); assert.equal(f.fallback(), 0);
    const read = await f.get('lost-commit'); assert.equal(read.status, 200); const original = (await read.json()).command;
    assert.equal(original.state, 'accepted');
    const duplicate = await f.post(payload); assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).runId, original.result.body.runId); assert.equal(f.effects(), 1);
  } finally { await f.close(); }
});

test('postcommit projection fault preserves receipt; delayed projection never overwrites a newer visible message', async () => {
  const f = await fixture();
  try {
    const publish = f.runtime.publishMessageAdmission.bind(f.runtime);
    f.runtime.publishMessageAdmission = () => { throw Error('private projection fault'); };
    const response = await f.post({ message: 'original', idempotencyKey: 'projection' }); assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(f.deck.getMessages(key).length, 0);
    f.deck.addMessage({ id: body.runId, sessionKey: key, role: 'user', text: 'edited', status: 'sent', createdAt: 1, updatedAt: 2 });
    const admission = { runId: body.runId, idempotencyKey: body.idempotencyKey, status: body.status,
      media: body.media, admission: body.admission };
    assert.ok(codexMessageAdmission(admission));
    publish(key, 'stale', admission);
    assert.equal(f.deck.getMessages(key)[0]?.text, 'edited'); assert.equal(f.deck.getMessages(key)[0]?.status, 'sent');
    assert.equal((await f.get('projection')).status, 200); assert.equal(f.effects(), 1);
  } finally { await f.close(); }
});

test('real worker through original Connector router publishes frontend fields and reaches original dispatch transaction without main SQL', async () => {
  const f = await fixture(true, true), reader = new AsyncCodexHistory(f.owner!, silent);
  try {
    // Registration is allowed to capture the old store, but ordinary async
    // admission/read/projection must never call its SQL or local native send.
    f.local.commands.claimAsync = async () => assert.fail('old main-thread receipt claim');
    f.local.commands.get = () => assert.fail('old main-thread receipt read');
    f.local.turns.enqueueAsync = async () => assert.fail('old main-thread enqueue');
    f.local.turns.list = () => assert.fail('old main-thread queue list');
    f.local.turns.version = () => assert.fail('old main-thread queue version');
    const payload = { media: [{ dataUrl: 'data:image/png;base64,YQ==', name: 'private.png' }], idempotencyKey: 'real-worker' };
    const response = await f.post(payload); assert.equal(response.status, 200); const body = await response.json();
    assert.deepEqual(body.media, [{ type: 'image', name: 'image.png', url: '/api/media/inbound/image.png', size: 1, mimeType: 'image/png' }]);
    assert.equal(f.deck.getMessages(key)[0]?.id, body.runId); assert.equal(f.deck.getMessages(key)[0]?.queueVersion, body.admission.queueVersion);
    assert.equal((await f.get('real-worker')).status, 200); assert.equal((await f.get('real-worker', authorization, true)).status, 200);
    const history = await reader.prepare(key, []); assert.equal(history.queue.length, 1);
    const entry = history.queue[0]!.entry;
    assert.equal(entry.id, body.runId); assert.equal(entry.payload.images.length, 1);
    const proof = { count: 1, digest: createHash('sha256').update(JSON.stringify([{ entry,
      version: history.queue[0]!.metadata.version }])).digest('hex') };
    const claimed = await f.owner!.command('codexDispatchClaim', { sessionKey: key, commandId: entry.id,
      connectionId: 'original-connection', proof, preparing: false, blockedGoalInput: false });
    assert.ok(claimed); assert.equal(claimed.execution.commandId, body.runId);
    assert.equal(await f.owner!.command('codexDispatchReady', { sessionKey: key, commandId: entry.id, connectionId: 'original-connection', proof: claimed.proof }), true);
    assert.deepEqual(await (await f.post(payload)).json(), body); assert.equal(f.effects(), 1);
    assert.equal((await f.post({ message: 'blocked-by-node' }, { 'x-agentopsdeck-expected-node-id': 'foreign' })).status, 409);
  } finally { await reader.close(); await f.close(); }
});
