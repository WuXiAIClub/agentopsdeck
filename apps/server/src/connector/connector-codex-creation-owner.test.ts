import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands, validConnectorOwnerInput, validConnectorOwnerOutput, connectorOwnerConfig } from './connector-owner-domain.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncCodexCreation } from './async-codex-creation.js';
import type { CodexCreationIntent, CodexCreationResult } from './connector-codex-creation-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { CodexAppServer } from '../codex/app-server.js';
import { DeckStore } from '../projection/deck-store.js';
import { AsyncCodexProjection } from './async-codex-projection.js';
import { AsyncCodexScheduling } from './async-codex-scheduling.js';
import { AsyncCodexQueue } from './async-codex-queue.js';
import { AsyncCodexHistory } from './async-codex-history.js';
import { AsyncConnectorExecutionReads } from './async-execution-reads.js';
import { registerCodexCreationHttp } from './codex-creation-http.js';
import { registerExecutionGrantRoutes } from './execution-grant-http.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';

const token = 'isolated-codex-create', authorization = `Bearer ${token}`, silence = new PerformanceDiagnostics(() => {});
const request = { authorization, commandKey: 'original', payloadJson: JSON.stringify({ title: 'Private title', model: 'model-override' }) };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(ok => { resolve = ok; }); return { promise, resolve }; }
function admitted(value: unknown): asserts value is CodexCreationResult & { intent: CodexCreationIntent } {
  assert.ok(value && typeof value === 'object' && 'intent' in value && value.intent && 'admitted' in value && value.admitted);
}
function fixture(boardTools = true) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-creation-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), token);
  const actor = tokens.authenticateAuthorization(authorization)!.tokenId;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const command = createConnectorOwnerCommands(store, tokens, undefined, undefined, undefined, boardTools);
  return { directory, tokens, actor, store, command,
    async claim(commandKey = request.commandKey) { const r = await command('codexCreationClaim', { ...request, commandKey }); admitted(r); return r; },
    close() { command.dispose(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('real Codex creation guard agrees with trusted issuer discovery; actor cannot acquire create authority', async () => {
  const f = fixture(false), app = new Hono(); let starts = 0;
  const issuer = f.tokens.create({ label: 'Synthetic Hub', delegationHubId: 'hub-permissions-test',
    scopes: ['execution:delegate', 'messages:send', 'sessions:create'] });
  const readOnly = f.tokens.create({ label: 'Synthetic no-create Hub', delegationHubId: 'hub-permissions-test',
    scopes: ['execution:delegate', 'messages:send'] });
  const actor = f.tokens.createTransient(['sessions:create'], 'actor_injected_create');
  const creation = new AsyncCodexCreation({ owner: { command: f.command }, deadlineMs: 10_000, diagnostics: silence,
    native: { available: () => true, async createSessionOwned(_intent, port) {
      await port.ready(); starts++; const id = randomUUID();
      await port.identify(id); await port.nameReady(); await port.accept();
      return { key: `codex:${id}` };
    } } });
  registerExecutionGrantRoutes(app, { nodeId: f.store.nodeId, tokens: f.tokens, grants: f.store.executionGrants });
  registerCodexCreationHttp(app, '/api/connector/v1', { creation, ready: () => true, diagnostics: silence });
  const discovery = (token: string) => app.request('/api/connector/v1/execution-grants/issuer/creation', {
    headers: { authorization: `Bearer ${token}`, [EXPECTED_NODE_HEADER]: f.store.nodeId } });
  const post = (token: string, key: string) => app.request('/api/connector/v1/agents/codex/sessions', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ label: 'Synthetic' }) });
  try {
    const allowed = await discovery(issuer.token); assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).creationAllowed, true);
    assert.equal((await post(issuer.token, 'issuer-create')).status, 201); assert.equal(starts, 1);
    assert.equal((await post(issuer.token, 'issuer-create')).status, 201); assert.equal(starts, 1);
    const denied = await discovery(readOnly.token); assert.equal(denied.status, 200);
    assert.equal((await denied.json()).creationAllowed, false);
    assert.equal((await post(readOnly.token, 'denied')).status, 403);
    assert.equal((await discovery(actor.token)).status, 403);
    assert.equal((await post(actor.token, 'actor-denied')).status, 403); assert.equal(starts, 1);
    // Preserve the established direct operator credential contract.
    assert.equal((await post(token, 'operator-create')).status, 201); assert.equal(starts, 2);
  } finally { await creation.close(); actor.dispose(); f.close(); }
});

test('fixed creation DTO refuses caller authority/SQL, forged intents and extra receipt fields', () => {
  assert.equal(validConnectorOwnerInput('codexCreationClaim', request), true);
  for (const field of ['sql', 'callback', 'actorId', 'authorized', 'boardTools', 'key', 'threadId'])
    assert.equal(validConnectorOwnerInput('codexCreationClaim', { ...request, [field]: true }), false);
  for (const payloadJson of ['[]', '{} junk', '{"model":true}', '{"authorization":"x"}', ' '.repeat(8193)])
    assert.equal(validConnectorOwnerInput('codexCreationClaim', { ...request, payloadJson }), false);
  assert.equal(validConnectorOwnerOutput('codexCreationReady', { authorized: true }), false);
  assert.equal(validConnectorOwnerOutput('codexCreationClaim', { error: '401' }), false);
  assert.equal(validConnectorOwnerInput('codexCreationAccept', { intent: { receiptId: 'x', title: 'x', model: null, boardTools: false }, threadId: 'forged' }), false);
  assert.throws(() => connectorOwnerConfig({ file: '/isolated.sqlite', codexBoardTools: 'true' }));
  assert.equal(connectorOwnerConfig({ file: '/isolated.sqlite', codexBoardTools: true }).codexBoardTools, true);
});

test('original namespace/fingerprint, once-only handoffs, tool enrollment and acceptance event share original receipts', async () => {
  const f = fixture(), threadId = randomUUID();
  try {
    const r = await f.claim(), intent = r.intent;
    assert.equal(intent.model, 'model-override'); assert.equal(intent.boardTools, true);
    const duplicate = await f.command('codexCreationClaim', request);
    assert.ok('receipt' in duplicate); assert.equal(duplicate.receipt.id, r.receipt.id); assert.equal(duplicate.intent, null);
    assert.deepEqual(await f.command('codexCreationClaim', { ...request, payloadJson: '{}' }), { error: 409 });
    assert.equal(await f.command('codexCreationIdentify', { intent, threadId }), false);
    assert.equal(await f.command('codexCreationReady', { intent, authorization }), true);
    assert.equal(await f.command('codexCreationReady', { intent, authorization }), false);
    assert.equal(await f.command('codexCreationIdentify', { intent: { ...intent, boardTools: false }, threadId }), false);
    assert.equal(await f.command('codexCreationIdentify', { intent, threadId }), true);
    assert.equal(f.store.codexExecutions.hasBoardTools(threadId), true, 'enroll before naming');
    assert.equal(await f.command('codexCreationAccept', { intent }), false);
    assert.equal(await f.command('codexCreationNameReady', { intent, authorization }), true);
    assert.equal(await f.command('codexCreationNameReady', { intent, authorization }), false);
    const accepted = await f.command('codexCreationAccept', { intent }); assert.ok(accepted);
    assert.equal(accepted.receipt.state, 'accepted'); assert.equal(accepted.receipt.result?.status, 201);
    assert.equal(f.store.codexCreations.get(intent.receiptId), undefined);
    const scope = JSON.stringify(['create', JSON.stringify([f.actor, 'codex'])]);
    assert.equal(f.store.commands.get(scope, request.commandKey)?.id, r.receipt.id);
    assert.ok(f.store.events.latestEventId());
    assert.equal(await f.command('codexCreationAccept', { intent }), false);
  } finally { f.close(); }
});

for (const boardTools of [false, true]) test(`capacity accounts for durable unknown reservations, tools=${boardTools}`, async () => {
  const f = fixture(boardTools);
  try {
    for (let i = 0; i < 2047; i++) f.store.codexExecutions.enrollBoardTools(randomUUID());
    const a = await f.claim('first');
    const b = await f.command('codexCreationClaim', { ...request, commandKey: 'second' }); assert.ok('receipt' in b);
    assert.equal(b.admitted, !boardTools);
    if (boardTools) {
      await f.command('codexCreationReady', { intent: a.intent, authorization });
      await f.command('codexCreationAbandon', { intent: a.intent });
      assert.equal(f.store.codexCreations.get(a.intent.receiptId)?.state, 'ready');
      assert.equal(f.store.codexCreations.available(true), false, 'unknown effects do not release last slot');
    }
  } finally { f.close(); }
});

test('abandon before handoff releases reservation but duplicate remains unknown, never freshly admitted', async () => {
  const f = fixture();
  try {
    const r = await f.claim(); await f.command('codexCreationAbandon', { intent: r.intent });
    assert.equal(f.store.codexCreations.get(r.intent.receiptId), undefined);
    const duplicate = await f.command('codexCreationClaim', request); assert.ok('receipt' in duplicate);
    assert.equal(duplicate.admitted, false); assert.equal(duplicate.receipt.state, 'outcome_unknown');
  } finally { f.close(); }
});

for (const stage of ['ready', 'name'] as const) for (const reason of ['revoke', 'maintenance'] as const)
  test(`current ${reason} blocks ${stage} without losing known identity`, async () => {
    const f = fixture(), threadId = randomUUID();
    try {
      const r = await f.claim();
      if (stage === 'name') { await f.command('codexCreationReady', { intent: r.intent, authorization });
        await f.command('codexCreationIdentify', { intent: r.intent, threadId }); }
      if (reason === 'revoke') f.tokens.revoke(f.actor); else await f.command('maintenancePause', {});
      assert.equal(await f.command(stage === 'ready' ? 'codexCreationReady' : 'codexCreationNameReady', { intent: r.intent, authorization }), false);
      assert.equal(f.store.codexCreations.get(r.intent.receiptId)?.state, stage === 'ready' ? 'reserved' : 'identified');
      if (stage === 'name') assert.equal(f.store.codexCreations.get(r.intent.receiptId)?.thread, threadId);
    } finally { f.close(); }
  });

test('irreversible native identity and naming ACK settle after revocation; revoked caller cannot read', async () => {
  const f = fixture(), threadId = randomUUID();
  try {
    const r = await f.claim(), intent = r.intent;
    await f.command('codexCreationReady', { intent, authorization });
    f.tokens.revoke(f.actor);
    assert.equal(await f.command('codexCreationIdentify', { intent, threadId }), true);
    assert.equal(f.store.codexCreations.get(intent.receiptId)?.thread, threadId);
    assert.deepEqual(await f.command('codexCreationReceiptRead', { authorization, commandKey: request.commandKey }), { error: 401 });
    assert.equal(await f.command('codexCreationNameReady', { intent, authorization }), false);
  } finally { f.close(); }
  const g = fixture();
  try {
    const r = await g.claim(), intent = r.intent;
    await g.command('codexCreationReady', { intent, authorization });
    await g.command('codexCreationIdentify', { intent, threadId: randomUUID() });
    await g.command('codexCreationNameReady', { intent, authorization }); g.tokens.revoke(g.actor);
    const accepted = await g.command('codexCreationAccept', { intent }); assert.ok(accepted); assert.equal(accepted.receipt.state, 'accepted');
  } finally { g.close(); }
});

test('conflicting native identity is durably blocked, never compensated or adopted', async () => {
  const f = fixture(), threadId = randomUUID();
  try {
    f.store.codexExecutions.enrollBoardTools(threadId);
    const r = await f.claim(), intent = r.intent;
    await f.command('codexCreationReady', { intent, authorization });
    assert.equal(await f.command('codexCreationIdentify', { intent, threadId }), false);
    assert.equal(f.store.codexCreations.get(intent.receiptId)?.state, 'blocked');
    assert.equal(f.store.codexCreations.get(intent.receiptId)?.thread, threadId);
    assert.equal(await f.command('codexCreationNameReady', { intent, authorization }), false);
  } finally { f.close(); }
});

for (const conflict of ['delete', 'pending-creation', 'accepted-creation'] as const)
test(`native identity cannot adopt an original ${conflict}, including without tools`, async () => {
  const f = fixture(false), threadId = randomUUID();
  try {
    if (conflict === 'delete') {
      const scope = JSON.stringify(['delete', JSON.stringify([f.actor, `codex:${threadId}`])]);
      f.store.commands.claim(scope, 'original-delete', {});
      assert.equal(f.store.commands.sessionDeletion(`codex:${threadId}`), 'outcome_unknown');
    } else {
      const first = await f.claim('first'), intent = first.intent;
      await f.command('codexCreationReady', { intent, authorization });
      assert.equal(await f.command('codexCreationIdentify', { intent, threadId }), true);
      if (conflict === 'accepted-creation') {
        await f.command('codexCreationNameReady', { intent, authorization });
        assert.ok(await f.command('codexCreationAccept', { intent }));
      }
    }
    const second = await f.claim('second'), intent = second.intent;
    await f.command('codexCreationReady', { intent, authorization });
    assert.equal(await f.command('codexCreationIdentify', { intent, threadId }), false);
    assert.equal(f.store.codexCreations.get(intent.receiptId)?.state, 'blocked');
    assert.equal(f.store.codexCreations.get(intent.receiptId)?.thread, threadId);
    assert.equal(await f.command('codexCreationNameReady', { intent, authorization }), false);
    assert.equal(f.store.codexExecutions.hasBoardTools(threadId), false);
  } finally { f.close(); }
});

test('disposed owner generation cannot hand off its original pending creation', async () => {
  const f = fixture();
  try {
    const r = await f.claim(); f.command.dispose();
    await assert.rejects(f.command('codexCreationReady', { intent: r.intent, authorization }), /unavailable/);
    assert.equal(f.store.codexCreations.get(r.intent.receiptId)?.state, 'reserved');
    const next = createConnectorOwnerCommands(f.store, f.tokens, undefined, undefined, undefined, true);
    try {
      const duplicate = await next('codexCreationClaim', request); assert.ok('receipt' in duplicate);
      assert.equal(duplicate.intent, null); assert.equal(duplicate.receipt.id, r.receipt.id);
      assert.equal(await next('codexCreationReady', { intent: r.intent, authorization }), false);
    } finally { next.dispose(); }
  } finally { f.close(); }
});

for (const participant of ['event', 'enrollment'] as const)
test(`escaped Promise from ${participant} retires connection, not a partial creation acceptance`, async () => {
  const f = fixture(), threadId = randomUUID();
  try {
    const r = await f.claim(), intent = r.intent;
    await f.command('codexCreationReady', { intent, authorization });
    if (participant === 'enrollment') {
      f.store.codexExecutions.enrollBoardTools = (() => Promise.resolve()) as any;
      await assert.rejects(f.command('codexCreationIdentify', { intent, threadId }), /synchronous/);
    } else {
      await f.command('codexCreationIdentify', { intent, threadId });
      await f.command('codexCreationNameReady', { intent, authorization });
      f.store.events.appendInTransaction = (() => Promise.resolve()) as any;
      await assert.rejects(f.command('codexCreationAccept', { intent }), /synchronous/);
    }
    assert.throws(() => f.store.codexCreations.get(intent.receiptId), /recovery required/);
  } finally { f.close(); }
});

test('201 receipt and event rollback together; original naming fact remains recoverable', async () => {
  const f = fixture(), threadId = randomUUID();
  try {
    const r = await f.claim(), intent = r.intent;
    await f.command('codexCreationReady', { intent, authorization });
    await f.command('codexCreationIdentify', { intent, threadId });
    await f.command('codexCreationNameReady', { intent, authorization });
    const original = f.store.events.appendInTransaction;
    f.store.events.appendInTransaction = () => { throw Error('synthetic rollback'); };
    await assert.rejects(f.command('codexCreationAccept', { intent }), /synthetic rollback/);
    assert.equal(f.store.codexCreations.get(intent.receiptId)?.state, 'naming');
    const read = await f.command('codexCreationReceiptRead', { authorization, commandKey: request.commandKey });
    assert.ok('receipt' in read); assert.equal(read.receipt?.state, 'outcome_unknown');
    f.store.events.appendInTransaction = original;
    const accepted = await f.command('codexCreationAccept', { intent }); assert.ok(accepted); assert.equal(accepted.receipt.state, 'accepted');
  } finally { f.close(); }
});

for (const raw of [{ title: 'x'.repeat(300) }, { title: 'line\nbreak' }, { title: 123 }, { title: { original: true } }, { label: null }])
  test(`Codex retains original title normalization, not Hermes restrictions: ${JSON.stringify(raw).slice(0, 35)}`, async () => {
    const f = fixture(false);
    try { const r = await f.command('codexCreationClaim', { ...request, payloadJson: JSON.stringify(raw) }); admitted(r);
      const p = raw as { title?: unknown; label?: unknown };
      assert.equal(r.intent.title, String(p.title ?? p.label ?? 'New chat').trim() || 'New chat');
    } finally { f.close(); }
  });

/** Actual original executor and RPC send/receive with synthetic native stdin,
 * no CLI/process/provider. All database handles remain exclusively in worker. */
async function workerFixture(boardTools = true, deadlineMs = 10_000) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-creation-worker-'));
  const config = { file: join(directory, 'original.sqlite'), tokenFile: join(directory, 'tokens.json'), bootstrapToken: token, codexBoardTools: boardTools };
  const logs: string[] = [], owner = new AsyncConnectorOwner(config, new PerformanceDiagnostics(line => logs.push(line)));
  await owner.open();
  const deck = new DeckStore(); let runtime: any;
  const projection = new AsyncCodexProjection({ owner, deck, bind: false, connectionId: () => runtime?.connectionId });
  const scheduling = new AsyncCodexScheduling(owner);
  const queuedConsumer = new AsyncCodexQueue({ owner, local() {}, dispatch: { async dispatch() { assert.fail('must not dispatch queued turn'); } }, async prepare() { return null; } });
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: 'C:\\workspace',
    defaultModel: 'default-model', modelProvider: 'original-provider', approvalPolicy: 'never', store: deck,
    ...(boardTools ? { boardToolsDirectory: directory } : {}),
    nativeJournal: projection.nativeJournal(), startup: { open: () => projection.open(), close: async () => {} }, scheduling, queuedConsumer,
    historyReader: new AsyncCodexHistory(owner), credentialExecutionReader: new AsyncConnectorExecutionReads(owner).codex,
    authorizeTurn() { assert.fail('host cannot authorize'); } });
  runtime = codex as any;
  const creation = new AsyncCodexCreation({ owner, deadlineMs, native: { available: () => !runtime.closed, createSessionOwned: (intent, port) => codex.createSessionOwned(intent, port) }, diagnostics: silence });
  const effects: any[] = [], threadId = randomUUID();
  let onWrite: ((message: any) => void) | undefined;
  const respond = (message: any, result: unknown) => runtime.receive(JSON.stringify({ id: message.id, result }));
  try {
    await codex.ready(); runtime.setConnection('owned-creation-connection'); await runtime.nativeObservations.drain();
    runtime.ensureStarted = async () => {};
    runtime.child = { stdin: { writable: true, write(line: string) {
      const message = JSON.parse(line); effects.push(message);
      if (onWrite) onWrite(message);
      else queueMicrotask(() => respond(message, message.method === 'thread/start' ? { thread: { id: threadId } } : {}));
      return true;
    } } };
  } catch (error) { runtime.child = undefined; await codex.close(); await projection.close(); await owner.close(); throw error; }
  return { owner, config, directory, deck, runtime, codex, creation, effects, threadId, logs, respond,
    intercept(fn: (message: any) => void) { onWrite = fn; },
    async close() { await creation.close(); runtime.child = undefined;
      try { await codex.close(); } finally { await queuedConsumer.close(); await projection.close(); await owner.close(); rmSync(directory, { recursive: true, force: true }); } } };
}

for (const tools of [true, false]) test(`real HTTP + exclusive worker + original executor commits exactly once, tools=${tools}`, async () => {
  const f = await workerFixture(tools), app = new Hono(); let legacy = 0;
  registerCodexCreationHttp(app, '/api', { creation: f.creation, ready: () => true, diagnostics: silence });
  app.post('/api/agents/:agentId/sessions', c => { legacy++; return c.json({ legacy: true }); });
  const send = (key = request.commandKey, title = 'PRIVATE_HTTP_TITLE') => app.request('/api/agents/codex/sessions', { method: 'POST',
    headers: { authorization, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ title, model: 'explicit-model' }) });
  try {
    const response = await send(); assert.equal(response.status, 201); assert.equal(response.headers.get('X-AgentOpsDeck-Command-Key'), request.commandKey);
    const body = await response.json() as any; assert.equal(body.key, `codex:${f.threadId}`);
    assert.equal(f.effects.length, 2); assert.equal(f.effects[0].method, 'thread/start'); assert.equal(f.effects[1].method, 'thread/name/set');
    const p = f.effects[0].params;
    assert.equal(p.cwd, 'C:\\workspace'); assert.equal(p.model, 'explicit-model'); assert.equal(p.modelProvider, 'original-provider');
    assert.equal(p.approvalPolicy, 'never'); assert.equal(p.sandbox, 'danger-full-access'); assert.ok(p.developerInstructions);
    assert.equal(Array.isArray(p.dynamicTools), tools);
    assert.equal(f.deck.getSession(body.key)?.title, 'PRIVATE_HTTP_TITLE');
    assert.equal(f.deck.getSession(body.key)?.model, 'explicit-model');
    assert.equal((await send()).status, 201); assert.equal(f.effects.length, 2); assert.equal(legacy, 0);
    assert.equal((await send(request.commandKey, 'different')).status, 409); assert.equal(f.effects.length, 2);
    const receipt = await app.request(`/api/agents/codex/sessions/creation-commands/${request.commandKey}`, { headers: { authorization } });
    assert.equal(receipt.status, 200);
    assert.equal((await app.request('/api/agents/other/sessions', { method: 'POST' })).status, 200); assert.equal(legacy, 1);
    await f.creation.close(); f.runtime.child = undefined; await f.codex.close(); await f.owner.close();
    const reopened = new ConnectorUserStore(f.config.file);
    try { assert.equal(reopened.codexExecutions.hasBoardTools(f.threadId), tools);
      const tokens = new ConnectorTokenStore(f.config.tokenFile, token), actor = tokens.authenticateAuthorization(authorization)!.tokenId;
      const scope = JSON.stringify(['create', JSON.stringify([actor, 'codex'])]); assert.equal(reopened.commands.get(scope, request.commandKey)?.state, 'accepted');
    } finally { reopened.close(); }
    assert.ok(f.logs.some(line => JSON.parse(line).step === 286));
    assert.doesNotMatch(f.logs.join(''), /PRIVATE_HTTP_TITLE|explicit-model|isolated-codex-create|owned-creation-connection/);
  } finally { await f.close(); }
});

test('waiter timeout and close do not cancel the physical original ACK; no duplicate native start', async () => {
  const f = await workerFixture(true, 50), entered = deferred(); let held: any;
  f.intercept(message => { if (message.method === 'thread/name/set') { held = message; entered.resolve(); }
    else queueMicrotask(() => f.respond(message, { thread: { id: f.threadId } })); });
  try {
    const waiting = f.creation.create(request); const observed = assert.rejects(waiting);
    await entered.promise; await observed;
    const duplicate = await f.creation.create(request); assert.ok('receipt' in duplicate); assert.equal(duplicate.receipt.state, 'outcome_unknown');
    let drained = false; const closing = f.creation.close().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
    f.respond(held, {}); await closing;
    const read = await f.creation.receipt(authorization, request.commandKey); assert.ok('receipt' in read); assert.equal(read.receipt?.state, 'accepted');
    assert.equal(f.effects.filter(e => e.method === 'thread/start').length, 1);
  } finally { if (held) f.respond(held, {}); await f.close(); }
});

test('naming failure persists the original enrolled identity across restart, without fresh dispatch', async () => {
  const f = await workerFixture(), entered = deferred();
  f.intercept(message => { queueMicrotask(() => {
    if (message.method === 'thread/start') f.respond(message, { thread: { id: f.threadId } });
    else { f.runtime.receive(JSON.stringify({ id: message.id, error: { message: 'private naming failure' } })); entered.resolve(); }
  }); });
  try {
    const result = await f.creation.create(request); assert.ok('receipt' in result); assert.equal(result.receipt.state, 'outcome_unknown');
    await entered.promise;
    await f.creation.close(); f.runtime.child = undefined; await f.codex.close(); await f.owner.close();
    const reopened = new ConnectorUserStore(f.config.file);
    try { assert.equal(reopened.codexCreations.get(result.receipt.id)?.thread, f.threadId);
      assert.equal(reopened.codexCreations.get(result.receipt.id)?.state, 'naming'); assert.equal(reopened.codexExecutions.hasBoardTools(f.threadId), true);
    } finally { reopened.close(); }
    const next = new AsyncConnectorOwner(f.config, silence); await next.open();
    try { const duplicate = await next.command('codexCreationClaim', request); assert.ok('receipt' in duplicate);
      assert.equal(duplicate.intent, null); assert.equal(duplicate.receipt.id, result.receipt.id); assert.equal(duplicate.receipt.state, 'outcome_unknown');
    } finally { await next.close(); }
    assert.equal(f.effects.length, 2);
  } finally { await f.close(); }
});

test('connection generation changing after native start still persists identity and never names it', async () => {
  const f = await workerFixture();
  f.intercept(message => { queueMicrotask(() => {
    assert.equal(message.method, 'thread/start');
    f.respond(message, { thread: { id: f.threadId } });
    f.runtime.nativeConnectionGeneration++;
  }); });
  try {
    const result = await f.creation.create(request); assert.ok('receipt' in result);
    assert.equal(result.receipt.state, 'outcome_unknown'); assert.equal(f.effects.length, 1);
    await f.creation.close(); f.runtime.child = undefined; await f.codex.close(); await f.owner.close();
    const reopened = new ConnectorUserStore(f.config.file);
    try {
      assert.equal(reopened.codexCreations.get(result.receipt.id)?.thread, f.threadId);
      assert.equal(reopened.codexCreations.get(result.receipt.id)?.state, 'identified');
      assert.equal(reopened.codexExecutions.hasBoardTools(f.threadId), true);
    } finally { reopened.close(); }
  } finally { await f.close(); }
});

for (const fault of ['new-observation', 'identify-ack', 'accept-ack'] as const)
test(`original executor handles ${fault} at worker boundary without native replay`, async () => {
  const f = await workerFixture(), release = deferred();
  let injected = false;
  const owner = { command: (async (kind: any, input: any) => {
    const result = await f.owner.command(kind, input);
    if (!injected && (fault === 'new-observation' && kind === 'codexCreationReady'
      || fault === 'identify-ack' && kind === 'codexCreationIdentify'
      || fault === 'accept-ack' && kind === 'codexCreationAccept')) {
      injected = true;
      if (fault === 'new-observation') f.runtime.nativeObservations.accept(() => release.promise, 0, 1);
      else throw Error('synthetic lost worker ACK');
    }
    return result;
  }) as typeof f.owner.command };
  const creation = new AsyncCodexCreation({ owner, deadlineMs: 10_000, diagnostics: silence,
    native: { available: () => true, createSessionOwned: (intent, port) => f.codex.createSessionOwned(intent, port) } });
  try {
    const result = await creation.create(request); assert.ok('receipt' in result); assert.equal(injected, true);
    assert.equal(result.receipt.state, fault === 'accept-ack' ? 'accepted' : 'outcome_unknown');
    assert.equal(f.effects.length, fault === 'new-observation' ? 0 : fault === 'identify-ack' ? 1 : 2);
    const duplicate = await creation.create(request); assert.ok('receipt' in duplicate);
    assert.equal(duplicate.receipt.id, result.receipt.id);
    assert.equal(f.effects.filter(e => e.method === 'thread/start').length, fault === 'new-observation' ? 0 : 1);
  } finally { release.resolve(); await creation.close(); await f.close(); }
});

test('HTTP key/authority/readiness checks keep fresh rejection separate from original accepted result', async () => {
  const f = await workerFixture(), app = new Hono(); let ready = true;
  registerCodexCreationHttp(app, '/api', { creation: f.creation, ready: () => ready, diagnostics: silence });
  const post = (body: unknown, extra: Record<string, string> = {}, auth = authorization) => app.request('/api/agents/codex/sessions', {
    method: 'POST', headers: { authorization: auth, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ idempotencyKey: 'body' }, { 'Idempotency-Key': 'header' })).status, 400);
    assert.equal((await post({}, {}, '')).status, 401);
    assert.equal((await post({}, {}, 'Bearer missing')).status, 401);
    assert.equal((await post({}, { 'x-agentopsdeck-execution-grant': 'delegated' })).status, 403);
    assert.equal(f.effects.length, 0);
    const original = { title: 'Original', idempotencyKey: 'body-key' };
    assert.equal((await post(original)).status, 201); assert.equal(f.effects.length, 2);
    ready = false;
    assert.equal((await post(original)).status, 201); assert.equal(f.effects.length, 2);
    // Original claim admission persists lifecycle refusal as a rejected 409
    // receipt. Do not replace this with a transient status or a fresh intent.
    const refused = await post({ ...original, idempotencyKey: 'fresh-key' });
    assert.equal(refused.status, 409);
    ready = true;
    assert.equal((await post({ ...original, idempotencyKey: 'fresh-key' })).status, 409);
    assert.equal(f.effects.length, 2);
  } finally { await f.close(); }
});
