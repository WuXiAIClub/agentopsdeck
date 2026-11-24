import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { resolveExplicitChannelRoute, type MirrorDeliveryClaim } from '../messages/mirror.js';
import { createHash } from 'node:crypto';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands, validConnectorOwnerInput } from './connector-owner-domain.js';
import { executeConnectorNativeReply } from './connector-native-reply-domain.js';
import { AsyncMirrorDispatcher } from './async-mirror-dispatcher.js';

const key = 'agent:main:feishu:direct:original-user';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function until(check: () => boolean) { const deadline = Date.now() + 5000; while (!check()) { assert.ok(Date.now() < deadline); await tick(); } }
async function fixture(worker = false, reply = 'original private reply', gateway = false) {
  const dir = mkdtempSync(join(tmpdir(), 'async-mirror-'));
  const config = { file: join(dir, 'connector.sqlite'), tokenFile: join(dir, 'tokens.json') };
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const tokens = new ConnectorTokenStore(config.tokenFile, undefined, diagnostics);
  const actor = tokens.create({ label: 'original actor', scopes: ['messages:send', 'messages:mirror'] }).record.id;
  let store: ConnectorUserStore | undefined = new ConnectorUserStore(config.file, undefined, { runtimeOwner: true });
  const params = { actorId: actor, sessionKey: key, after: 1, inputText: 'original private input',
    idempotencyKey: 'original-command', explicitRoute: resolveExplicitChannelRoute(key, 'main')! };
  store.mirrorOutbox.upsert(params);
  assert.equal(store.openClawExecutions.begin(key, params.idempotencyKey), true);
  if (!gateway) {
    assert.equal(store.openClawExecutions.useCli(key, params.idempotencyKey), true);
    executeConnectorNativeReply('openClawCliFinalReply', { sessionKey: key, commandId: params.idempotencyKey,
      phase: 'completed', deliveryMode: 'mirror', replyText: reply }, store);
  } else {
    assert.equal(store.openClawExecutions.bindGatewayConnection(key, params.idempotencyKey, 'original-connection'), true);
    assert.equal(store.openClawExecutions.acknowledge(key, params.idempotencyKey, 'original-run'), true);
  }
  let nativeOwner: AsyncConnectorOwner | undefined;
  if (worker) { store.close(); store = undefined; nativeOwner = new AsyncConnectorOwner(config, diagnostics); await nativeOwner.open(); }
  const original = store ? createConnectorOwnerCommands(store, tokens) : undefined;
  const command: AsyncConnectorOwner['command'] = nativeOwner ? (kind, input) => nativeOwner!.command(kind, input) : original!;
  const calls: { route: unknown; text: string }[] = [], commands: string[] = [];
  const hooks: { before?: (kind: string) => Promise<void>; after?: (kind: string) => Promise<void>; send?: () => Promise<void> } = {};
  const port = { command: (async (kind, input) => { commands.push(kind); await hooks.before?.(kind);
    const result = await command(kind, input); await hooks.after?.(kind); return result; }) as AsyncConnectorOwner['command'] };
  const dispatcher = new AsyncMirrorDispatcher({ owner: port, defaultAgentId: 'main', localOpenClawCli: true, diagnostics,
    sendOutbound: async (route, text) => { calls.push({ route, text }); await hooks.send?.(); } });
  const claim = () => command('mirrorDeliveryClaim', { key, defaultAgentId: 'main', localOpenClawCli: true });
  return { command, port, dispatcher, hooks, calls, commands, logs, actor, claim, params, store,
    async reopen() { await dispatcher.close(); await nativeOwner?.close(); original?.dispose(); store?.close();
      store = new ConnectorUserStore(config.file, undefined, { runtimeOwner: true }); return store; },
    async close() { await dispatcher.close(); await nativeOwner?.close(); original?.dispose(); store?.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('fixed mirror commands reject fabricated identity, route, text and generic mutation', () => {
  const input = { key, defaultAgentId: 'main', localOpenClawCli: true };
  assert.equal(validConnectorOwnerInput('mirrorDeliveryClaim', input), true);
  for (const extra of [{ actorId: 'forged' }, { route: {} }, { nativeReply: 'forged' }, { authorized: true }, { sql: 'SELECT 1' }])
    assert.equal(validConnectorOwnerInput('mirrorDeliveryClaim', { ...input, ...extra }), false);
  assert.equal(validConnectorOwnerInput('mirrorDeliveryClaim', { ...input, key: 'codex:wrong' }), false);
});

test('claim transaction failure rolls back its durable attempt before any send', async t => {
  const f = await fixture();
  try {
    const outbox = f.store!.mirrorOutbox, save = outbox.saveJob.bind(outbox);
    const injected = t.mock.method(outbox, 'saveJob', (job: Parameters<typeof save>[0]) => { save(job); throw Error('private commit failure'); });
    await assert.rejects(f.dispatcher.reconcileSession(key));
    assert.equal(f.calls.length, 0); assert.equal(outbox.get('original-command')!.deliveryState, 'pending');
    injected.mock.restore(); await f.dispatcher.reconcileSession(key);
    assert.equal(f.calls.length, 1); assert.equal(outbox.get('original-command')!.deliveryState, 'sent');
  } finally { await f.close(); }
});

for (const worker of [false, true]) test(`original mirror events follow committed claim and exact ACK, worker=${worker}`, async () => {
  const f = await fixture(worker);
  try {
    const head = await f.command('eventReplay', { after: null });
    const claim = await f.claim(); assert.equal(claim.state, 'send');
    if (claim.state !== 'send') return;
    const started = await f.command('eventReplay', { after: head.cursor });
    assert.deepEqual(started.events.map(event => event.type), ['queued_message.created']);
    assert.deepEqual(started.events[0]?.payload, { sessionKey: key, idempotencyKey: 'original-command',
      deliveryMode: 'mirror', mirror: 'started', outboundTarget: 'user:original-user' });
    assert.equal(await f.command('mirrorDeliveryAck', { ...claim.ref, attemptedAt: claim.ref.attemptedAt + 1 }), false);
    assert.equal(await f.command('mirrorDeliveryAck', claim.ref), true);
    assert.equal(await f.command('mirrorDeliveryAck', claim.ref), true);
    const sent = await f.command('eventReplay', { after: started.cursor });
    assert.deepEqual(sent.events.map(event => event.type), ['queued_message.sent']);
    assert.deepEqual(sent.events[0]?.payload, { sessionKey: key, idempotencyKey: 'original-command', deliveryMode: 'mirror',
      outboundTarget: 'user:original-user', mirroredMessageId: claim.ref.messageId });
    assert.equal(JSON.stringify([...started.events, ...sent.events]).includes('original private'), false);
  } finally { await f.close(); }
});

for (const stage of ['claim', 'ack']) test(`mirror ${stage} and its original event roll back together`, async t => {
  const f = await fixture();
  try {
    const head = await f.command('eventReplay', { after: null });
    const events = f.store!.events, append = events.appendInTransaction.bind(events);
    let claim: MirrorDeliveryClaim | undefined;
    if (stage === 'ack') claim = await f.claim();
    const before = await f.command('eventReplay', { after: head.cursor });
    const injected = t.mock.method(events, 'appendInTransaction', (...args: Parameters<typeof append>) => {
      append(...args); throw Error('isolated event commit failure');
    });
    if (stage === 'claim') await assert.rejects(f.dispatcher.reconcileSession(key));
    else {
      assert.equal(claim?.state, 'send');
      if (claim?.state !== 'send') return;
      await assert.rejects(f.command('mirrorDeliveryAck', claim.ref));
    }
    assert.equal(f.calls.length, 0);
    assert.equal(f.store!.mirrorOutbox.get('original-command')!.deliveryState, stage === 'claim' ? 'pending' : 'outcome_unknown');
    const rolledBack = await f.command('eventReplay', { after: before.cursor });
    assert.deepEqual(rolledBack.events, []); assert.equal(rolledBack.cursor, before.cursor);
    injected.mock.restore();
    if (stage === 'claim') await f.dispatcher.reconcileSession(key);
    else if (claim?.state === 'send') assert.equal(await f.command('mirrorDeliveryAck', claim.ref), true);
    assert.equal(f.store!.mirrorOutbox.get('original-command')!.deliveryState, 'sent');
  } finally { await f.close(); }
});

test('disabled local CLI retires only the original intent without external effect', async () => {
  const f = await fixture(true);
  try {
    assert.deepEqual(await f.command('mirrorDeliveryClaim', { key, defaultAgentId: 'main', localOpenClawCli: false }), { state: 'blocked' });
    await f.dispatcher.reconcileSession(key); assert.equal(f.calls.length, 0);
    assert.equal((await f.reopen()).mirrorOutbox.get('original-command')!.deliveryState, 'blocked');
  } finally { await f.close(); }
});

for (const altered of ['route', 'key', 'digest']) test(`tampered ${altered} reply never reaches external sender`, async () => {
  const f = await fixture(true);
  const dispatcher = new AsyncMirrorDispatcher({ defaultAgentId: 'main', localOpenClawCli: true,
    owner: { command: (async (kind, input) => {
      const result = await f.command(kind, input);
      if (kind !== 'mirrorDeliveryClaim') return result;
      const claim = result as MirrorDeliveryClaim;
      if (claim.state === 'send') {
        if (altered === 'route') claim.route.outboundTarget = 'user:wrong-recipient';
        if (altered === 'key') claim.ref.key = 'agent:main:feishu:direct:wrong';
        if (altered === 'digest') claim.text = 'forged text';
      }
      return claim;
    }) as AsyncConnectorOwner['command'] }, sendOutbound: async () => { assert.fail('unexpected external send'); } });
  try {
    await assert.rejects(dispatcher.reconcileSession(key));
    assert.equal((await f.reopen()).mirrorOutbox.get('original-command')!.deliveryState, 'outcome_unknown');
  } finally { await dispatcher.close(); await f.close(); }
});

test('two physical sends bound the delivery lane and closing retains both reservations', async () => {
  const held = deferred(), calls: string[] = [];
  const dispatcher = new AsyncMirrorDispatcher({ defaultAgentId: 'main', localOpenClawCli: true,
    owner: { command: (async (kind, input) => {
      if (kind === 'mirrorDeliveryAck') return true;
      assert.equal(kind, 'mirrorDeliveryClaim'); const k = (input as { key: string }).key;
      const text = 'original text';
      return { state: 'send', ref: { key: k, id: k, messageId: 'original', attemptedAt: 1,
        digest: createHash('sha256').update(text).digest('hex') }, text, route: resolveExplicitChannelRoute(k, 'main')! };
    }) as AsyncConnectorOwner['command'] }, sendOutbound: async route => { calls.push(route.outboundTarget); await held.promise; } });
  try {
    const one = dispatcher.reconcileSession(key), two = dispatcher.reconcileSession(key + '-two');
    await until(() => calls.length === 2);
    await assert.rejects(dispatcher.reconcileSession(key + '-three'));
    assert.equal(dispatcher.reconcileSession(key), one);
    let closed = false; const close = dispatcher.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false); held.resolve(); await Promise.all([one, two, close]);
    assert.equal(calls.length, 2);
  } finally { held.resolve(); await dispatcher.close(); }
});

test('escaped original native text crosses the worker result envelope without truncation', async () => {
  const reply = 'a\u0001'.repeat(512 * 1024);
  const f = await fixture(true, reply);
  try {
    await f.dispatcher.reconcileSession(key);
    assert.equal(f.calls[0]?.text, 'Input:\noriginal private input\n\nOutput:\n' + reply);
    assert.equal((await f.reopen()).mirrorOutbox.get('original-command')!.deliveryState, 'sent');
  } finally { await f.close(); }
});

for (const worker of [false, true]) test(`original native evidence is claimed once, sent and exactly settled; worker=${worker}`, async () => {
  const f = await fixture(worker);
  try {
    const one = f.dispatcher.reconcileSession(key), two = f.dispatcher.reconcileSession(key);
    assert.equal(one, two); await one;
    assert.deepEqual(f.calls, [{ route: f.params.explicitRoute, text: 'Input:\noriginal private input\n\nOutput:\noriginal private reply' }]);
    assert.deepEqual(f.commands, ['mirrorDeliveryClaim', 'mirrorDeliveryAck']);
    await f.dispatcher.reconcileSession(key); assert.equal(f.calls.length, 1);
    const saved = (await f.reopen()).mirrorOutbox.get('original-command')!;
    assert.equal(saved.deliveryState, 'sent'); assert.equal(saved.actorId, f.actor);
    assert.equal(saved.selectedMessageId, 'cli:original-command:assistant');
    assert.ok(f.logs.some(line => line.includes('mirror-delivery')));
    for (const secret of [key, f.actor, 'original private', 'original-user', 'tokens.json'])
      assert.equal(f.logs.some(line => line.includes(secret)), false);
  } finally { await f.close(); }
});

test('competing claim cannot send again; wrong ACK is rejected and original ACK is idempotent after revocation', async () => {
  const f = await fixture(true);
  try {
    const claim = await f.claim(); assert.equal(claim.state, 'send'); if (claim.state !== 'send') return;
    assert.deepEqual(await f.claim(), { state: 'idle' });
    assert.equal(await f.command('mirrorDeliveryAck', { ...claim.ref, attemptedAt: claim.ref.attemptedAt + 1 }), false);
    await f.command('tokenRevoke', { tokenId: f.actor });
    assert.equal(await f.command('mirrorDeliveryAck', claim.ref), true);
    assert.equal(await f.command('mirrorDeliveryAck', claim.ref), true);
  } finally { await f.close(); }
});

test('current revocation blocks original saved actor without sending', async () => {
  const f = await fixture(true);
  try { await f.command('tokenRevoke', { tokenId: f.actor }); await f.dispatcher.reconcileSession(key);
    assert.equal(f.calls.length, 0); assert.equal((await f.reopen()).mirrorOutbox.get('original-command')!.deliveryState, 'blocked');
  } finally { await f.close(); }
});

for (const reply of ['NO_REPLY', '{"type":"thinking"}\nNO_REPLY']) test(`non-forwardable native output settles without effect: ${reply}`, async () => {
  const f = await fixture(false, reply);
  try { assert.deepEqual(await f.claim(), { state: 'no_output' }); assert.equal(f.calls.length, 0); }
  finally { await f.close(); }
});

test('unsettled Gateway evidence remains pending and never guesses a reply from display', async () => {
  const f = await fixture(false, 'unused', true);
  try { assert.deepEqual(await f.claim(), { state: 'idle' }); assert.equal(f.store!.mirrorOutbox.get('original-command')!.deliveryState, 'pending'); }
  finally { await f.close(); }
});

for (const failure of ['claim-ack-lost', 'send-unknown', 'settlement-lost']) test(`uncertain ${failure} survives reopen without replay`, async () => {
  const f = await fixture(true);
  try {
    if (failure === 'claim-ack-lost') f.hooks.after = async kind => { if (kind === 'mirrorDeliveryClaim') throw Error('private claim error'); };
    if (failure === 'send-unknown') f.hooks.send = async () => { throw Error('private transport error'); };
    if (failure === 'settlement-lost') f.hooks.before = async kind => { if (kind === 'mirrorDeliveryAck') throw Error('private SQL error'); };
    await assert.rejects(f.dispatcher.reconcileSession(key)); delete f.hooks.after; delete f.hooks.before; delete f.hooks.send;
    await f.dispatcher.reconcileSession(key);
    assert.equal(f.calls.length, failure === 'claim-ack-lost' ? 0 : 1);
    const store = await f.reopen(); assert.equal(store.mirrorOutbox.get('original-command')!.deliveryState, 'outcome_unknown');
    assert.equal(store.mirrorOutbox.recoveryJob(key), undefined);
    assert.equal(f.logs.some(line => line.includes('private')), false);
  } finally { await f.close(); }
});

for (const mode of ['pause', 'close']) test(`${mode} drains physical send then settles success; no new effects enter`, async () => {
  const f = await fixture(true), held = deferred(); let drained = false;
  try {
    f.hooks.send = () => held.promise;
    const send = f.dispatcher.reconcileSession(key); await until(() => f.calls.length === 1);
    const pause = mode === 'pause' ? f.dispatcher.pauseAdmissions() : undefined;
    const drain = (pause?.drained ?? f.dispatcher.close()).then(() => { drained = true; });
    await assert.rejects(f.dispatcher.reconcileSession(key)); await tick(); assert.equal(drained, false);
    assert.equal(pause?.resume() ?? false, false); held.resolve(); await send; await drain;
    assert.equal(f.commands.at(-1), 'mirrorDeliveryAck');
    if (pause) { assert.equal(pause.resume(), true); await f.dispatcher.reconcileSession(key); }
    assert.equal((await f.reopen()).mirrorOutbox.get('original-command')!.deliveryState, 'sent');
  } finally { held.resolve(); await f.close(); }
});

test('close while claim ACK is held cannot start late external send', async () => {
  const f = await fixture(true), held = deferred(); let returned = false, drained = false;
  try {
    f.hooks.after = async kind => { if (kind === 'mirrorDeliveryClaim') { returned = true; await held.promise; } };
    const task = f.dispatcher.reconcileSession(key); const rejected = assert.rejects(task);
    await until(() => returned); const close = f.dispatcher.close().then(() => { drained = true; });
    await tick(); assert.equal(drained, false); held.resolve(); await rejected; await close;
    assert.equal(f.calls.length, 0);
    assert.equal((await f.reopen()).mirrorOutbox.get('original-command')!.deliveryState, 'outcome_unknown');
  } finally { held.resolve(); await f.close(); }
});
