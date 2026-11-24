import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { MAX_MESSAGE_CHARS } from '@agentopsdeck/shared';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { CommandReceipts } from '../commands/receipts.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncHermesQueue } from './async-hermes-queue.js';
import { validConnectorHermesQueueInput } from './connector-hermes-queue-domain.js';

const authorization = 'Bearer isolated-hermes-queue', key = 'hermes:original';
const silent = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hermes-queue-')), tokenFile = join(root, 'tokens.json');
  const tokens = new ConnectorTokenStore(tokenFile, 'isolated-hermes-queue');
  const actor = tokens.authenticateAuthorization(authorization)!.tokenId;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  store.hermesJournal.save({ key, stored: 'stored', title: 'Original', started: true, messages: [] });
  const db = (store as unknown as { db: DatabaseSync }).db;
  const execute = createConnectorOwnerCommands(store, tokens), changes: unknown[] = [];
  const queue = new AsyncHermesQueue({ owner: { command: execute }, changed: (...args) => { changes.push(args); } });
  const enqueue = (id = 'message', owner = actor) => {
    store.turns.enqueue('hermes', { id, sessionKey: key, createdAt: 0, payload: { actorId: owner, text: 'Original', images: [], marker: 'retained' } });
    return store.turns.version('hermes', key, id)!;
  };
  const input = (version: string, mutationKey = 'edit', messageId = 'message') =>
    ({ runtime: 'hermes' as const, key, authorization, target: { messageId }, mutationKey, version, text: ' Updated ' });
  const scope = (id = 'message') => JSON.stringify(['queue-mutation-v1', actor, key, id]);
  return { root, tokenFile, tokens, actor, store, db, execute, queue, changes, enqueue, input, scope,
    close() { execute.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('Hermes queue original actor/payload, CAS, accepted replay and command target resolution', async () => {
  const f = fixture();
  try {
    const input = f.input(f.enqueue());
    f.store.commands.claim(JSON.stringify([f.actor, key]), 'send', {});
    f.store.commands.settle(JSON.stringify([f.actor, key]), 'send', { status: 200, body: { idempotencyKey: 'message' } });
    const result = await f.queue.edit({ ...input, target: { commandKey: 'send' } });
    assert.ok('receipt' in result); assert.equal(result.changed, true); assert.equal(result.receipt.result?.status, 200);
    assert.deepEqual(f.store.turns.head('hermes', key)!.payload, { actorId: f.actor, text: 'Updated', images: [], marker: 'retained' });
    const replay = await f.queue.edit(input); assert.ok('receipt' in replay);
    assert.equal(replay.changed, false); assert.deepEqual(replay.receipt, result.receipt); assert.equal(f.changes.length, 1);
    assert.deepEqual(await f.queue.edit({ ...input, text: 'different' }), { error: 409 });
    const stale = await f.queue.edit({ ...input, mutationKey: 'stale' }); assert.ok('receipt' in stale);
    assert.equal(stale.receipt.result?.status, 412);
    const page = await f.queue.commandPage({ runtime: 'hermes', key, authorization, after: 0 });
    assert.ok('page' in page); assert.equal(page.page.items[0]!.commandKey, 'send');
    const { text: _text, version: _version, ...address } = input;
    assert.deepEqual(await f.queue.readReceipt({ ...address, purpose: 'mutation', method: 'PATCH' }),
      { key, targetId: 'message', receipt: result.receipt });
  } finally { f.close(); }
});

test('Hermes queue manager raw view/cancel crosses actors but command view and edit do not', async () => {
  const f = fixture();
  try {
    const version = f.enqueue('message', 'other');
    const manager = f.tokens.create({ label: 'manager', scopes: ['queue:manage'] });
    const auth = `Bearer ${manager.token}`;
    const raw = await f.queue.page({ runtime: 'hermes', key, authorization: auth, after: 0 });
    assert.ok('page' in raw); assert.equal(raw.page.items.length, 1);
    const commands = await f.queue.commandPage({ runtime: 'hermes', key, authorization: auth, after: 0 });
    assert.ok('page' in commands); assert.equal(commands.page.items.length, 0);
    assert.deepEqual(await f.queue.edit({ ...f.input(version), authorization: auth }), { error: 403 });
    const { text: _, ...input } = f.input(version);
    const result = await f.queue.cancel({ ...input, authorization: auth });
    assert.ok('receipt' in result); assert.equal(result.changed, true);
    assert.equal(f.store.turns.head('hermes', key), undefined);
  } finally { f.close(); }
});

for (const state of ['queued', 'blocked', 'dispatching', 'outcome_unknown'] as const) {
  test(`Hermes queue cancellation protects ${state} according to original state policy`, async () => {
    const f = fixture();
    try {
      f.enqueue(); if (state !== 'queued') f.db.prepare('UPDATE connector_turns SET state=?').run(state);
      const { text: _, ...input } = f.input(f.store.turns.version('hermes', key, 'message')!, 'cancel');
      const result = await f.queue.cancel(input); assert.ok('receipt' in result);
      assert.equal(result.changed, state === 'queued' || state === 'blocked');
      assert.equal(result.receipt.result?.status, result.changed ? 200 : 409);
    } finally { f.close(); }
  });
}

test('Hermes owner-only grants and issuer references never downgrade to broad token actor', async () => {
  const f = fixture();
  try {
    const version = f.enqueue();
    for (const grantRef of ['missing', '']) assert.deepEqual(await f.queue.edit({ ...f.input(version), grantRef }), { error: 403 });
    const issuer = f.tokens.create({ label: 'issuer', scopes: ['execution:delegate', 'messages:read', 'messages:send'] });
    assert.deepEqual(await f.queue.page({ runtime: 'hermes', key, authorization: `Bearer ${issuer.token}`, after: 0 }), { error: 403 });
    assert.equal(f.store.turns.head<{ text: string }>('hermes', key)!.payload.text, 'Original');
  } finally { f.close(); }
});

for (const fault of ['receipt', 'event'] as const) test(`Hermes queue ${fault} failure atomically rolls back and preserves unknown without replay`, async () => {
  const f = fixture();
  try {
    const input = f.input(f.enqueue());
    const table = fault === 'receipt' ? 'command_receipts' : 'events';
    // Events schema name is taken from the original participant, never a substitute DB.
    const eventTable = (f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%event%'").all() as { name: string }[])
      .find(row => row.name === 'connector_events' || row.name === 'events')?.name;
    assert.ok(fault !== 'event' || eventTable);
    f.db.exec(`CREATE TRIGGER isolated_queue_fault BEFORE ${fault === 'receipt' ? 'UPDATE' : 'INSERT'} ON ${fault === 'event' ? eventTable! : table} BEGIN SELECT RAISE(ABORT,'isolated queue fault'); END`);
    await assert.rejects(f.queue.edit(input), /isolated queue fault/);
    assert.equal(f.store.turns.head<{ text: string }>('hermes', key)!.payload.text, 'Original');
    assert.equal(f.store.turns.version('hermes', key, 'message'), input.version);
    f.db.exec('DROP TRIGGER isolated_queue_fault');
    const result = await f.queue.edit(input); assert.ok('receipt' in result);
    assert.equal(result.changed, false); assert.equal(result.receipt.state, 'outcome_unknown');
  } finally { f.close(); }
});

test('Hermes queue clones before await and rechecks revoked authority after original admission wait', async () => {
  for (const revoke of [false, true]) {
    const f = fixture();
    try {
      let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
      Object.defineProperty(f.store, 'commands', { value: new CommandReceipts(f.db, undefined, undefined, undefined, undefined, silent,
        async (_bytes, write) => { await wait; return write(); }) });
      const input = f.input(f.enqueue()), pending = f.queue.edit(input); await tick();
      input.text = 'foreign'; input.target.messageId = 'foreign'; input.mutationKey = 'foreign';
      if (revoke) f.tokens.revoke(f.actor);
      release(); const result = await pending;
      if (revoke) assert.deepEqual(result, { error: 403 });
      else { assert.ok('receipt' in result); assert.equal(result.changed, true); }
      assert.equal(f.store.turns.head<{ text: string }>('hermes', key)!.payload.text, revoke ? 'Original' : 'Updated');
    } finally { f.close(); }
  }
});

test('Hermes queue physical publication drains on close and accepted fact survives publication failure', async () => {
  const f = fixture();
  try {
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    const queue = new AsyncHermesQueue({ owner: { command: f.execute }, changed: async () => { await wait; throw Error('projection unavailable'); } });
    const pending = queue.edit(f.input(f.enqueue())); await tick();
    let closed = false; const closing = queue.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false); assert.equal(queue.close(), queue.close());
    await assert.rejects(queue.page({ runtime: 'hermes', key, authorization, after: 0 }));
    release(); const result = await pending; assert.ok('receipt' in result); assert.equal(result.receipt.state, 'accepted');
    await closing; assert.equal(closed, true);
  } finally { f.close(); }
});

test('Hermes sole worker long edit and unknown survive physical close/reopen without replay', async () => {
  const f = fixture(), file = join(f.root, 'worker.sqlite'); let owner: AsyncConnectorOwner | undefined;
  try {
    const setup = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
    setup.hermesJournal.save({ key, stored: 'stored', title: 'Original', started: true, messages: [] });
    for (const id of ['message', 'unknown']) await setup.turns.enqueueAsync('hermes', { id, sessionKey: key, createdAt: 0, payload: { actorId: f.actor, text: 'Original', images: [] } });
    const input = { ...f.input(setup.turns.version('hermes', key, 'message')!), text: '\u0001'.repeat(MAX_MESSAGE_CHARS) };
    const unknown = { ...input, mutationKey: 'unknown', target: { messageId: 'unknown' }, version: setup.turns.version('hermes', key, 'unknown')! };
    await setup.commands.claimAsync(f.scope('unknown'), 'unknown', { method: 'PATCH', version: unknown.version, text: unknown.text }); setup.close();
    owner = new AsyncConnectorOwner({ file, tokenFile: f.tokenFile }, silent);
    let queue = new AsyncHermesQueue({ owner, changed: () => {} });
    const accepted = await queue.edit(input); assert.ok('receipt' in accepted); assert.equal(accepted.changed, true);
    const uncertain = await queue.edit(unknown); assert.ok('receipt' in uncertain); assert.equal(uncertain.changed, false);
    await queue.close(); await owner.closeForShutdown(); owner = new AsyncConnectorOwner({ file, tokenFile: f.tokenFile }, silent);
    queue = new AsyncHermesQueue({ owner, changed: () => {} });
    const replay = await queue.edit(input); assert.ok('receipt' in replay); assert.equal(replay.changed, false); assert.deepEqual(replay.receipt, accepted.receipt);
    const original = await queue.edit(unknown); assert.ok('receipt' in original); assert.equal(original.receipt.state, 'outcome_unknown');
    await queue.close();
  } finally { await owner?.closeForShutdown(); f.close(); }
});

for (const fence of ['pause', 'settings', 'deletion', 'foreign-actor'] as const) test(`Hermes queue ${fence} fences fresh edits and preserves original text`, async () => {
  const f = fixture();
  try {
    const input = f.input(f.enqueue('message', fence === 'foreign-actor' ? 'other' : f.actor));
    if (fence === 'pause') f.store.pauseTurnStarts();
    if (fence === 'settings') await f.store.commands.claimAsync(JSON.stringify(['settings', JSON.stringify([f.actor, key])]), 'settings', {}, false, undefined, undefined, undefined, true);
    if (fence === 'deletion') f.store.hermesJournal.beginDeletion(key);
    const result = await f.queue.edit(input); assert.ok('receipt' in result); assert.equal(result.changed, false);
    assert.equal(result.receipt.result?.status, fence === 'foreign-actor' ? 404 : 409);
    assert.equal(f.store.turns.head<{ text: string }>('hermes', key)!.payload.text, 'Original');
  } finally { f.close(); }
});

test('Hermes queue transactional revoke rolls back edit; storage faults are not classified as authority denial', async () => {
  const f = fixture();
  try {
    const input = f.input(f.enqueue()), original = f.tokens.authenticateAuthorization.bind(f.tokens);
    let checks = 0;
    f.tokens.authenticateAuthorization = authorization => f.db.isTransaction && ++checks === 2 ? undefined : original(authorization);
    const result = await f.queue.edit(input); assert.ok('receipt' in result); assert.equal(result.receipt.result?.status, 403);
    assert.equal(f.store.turns.head<{ text: string }>('hermes', key)!.payload.text, 'Original');
    f.tokens.authenticateAuthorization = () => { throw Error('isolated credential storage failure'); };
    await assert.rejects(f.queue.page({ runtime: 'hermes', key, authorization, after: 0 }), /isolated credential storage failure/);
  } finally { f.close(); }
});

test('Hermes queue publication rechecks manager scope and returns no cross-actor page on revocation', async () => {
  const f = fixture();
  try {
    f.enqueue('message', 'other'); const manager = f.tokens.create({ label: 'manager', scopes: ['queue:manage', 'messages:read'] });
    const original = f.tokens.authenticateAuthorization.bind(f.tokens); let checks = 0;
    f.tokens.authenticateAuthorization = value => { const p = original(value); return ++checks >= 3 && p ? { ...p, scopes: ['messages:read'] } : p; };
    assert.deepEqual(await f.queue.page({ runtime: 'hermes', key, authorization: `Bearer ${manager.token}`, after: 0 }), { error: 403 });
  } finally { f.close(); }
});

test('Hermes queue protocol rejects caller authority and facade rejects foreign receipt, target, key and cursor', async () => {
  const f = fixture();
  try {
    const input = f.input(f.enqueue());
    for (const extra of [{ actorId: 'forged' }, { manager: true }, { authorization: 'bad\r\nheader' }, { runtime: 'ghcp' }, { version: '0:0' }])
      assert.equal(validConnectorHermesQueueInput('hermesQueuedEdit', { ...input, ...extra }), false);
    const result = await f.queue.edit(input); assert.ok('receipt' in result);
    for (const patch of [{ key: 'hermes:foreign' }, { targetId: 'foreign' }, { receipt: { ...result.receipt, key: 'foreign' } }]) {
      const queue = new AsyncHermesQueue({ owner: { command: (async () => ({ ...result, ...patch })) as AsyncConnectorOwner['command'] }, changed: () => { throw Error('must not publish'); } });
      await assert.rejects(queue.edit(input)); await queue.close();
    }
    const queue = new AsyncHermesQueue({ owner: { command: (async () => ({ key, page: { items: [{ id: 'message', version: '1:1', state: 'queued', createdAt: 0 }], nextCursor: null } })) as AsyncConnectorOwner['command'] }, changed: () => {} });
    await assert.rejects(queue.page({ runtime: 'hermes', key, authorization, after: 1 })); await queue.close();
  } finally { f.close(); }
});

test('Hermes queue projection failure emits redacted bounded diagnostics without altering accepted fact', async () => {
  const f = fixture();
  try {
    const lines: string[] = [];
    const diagnostics = new PerformanceDiagnostics(line => { lines.push(line); });
    const queue = new AsyncHermesQueue({ owner: { command: f.execute }, diagnostics,
      changed: () => { throw Error('private projection detail'); } });
    const result = await queue.edit(f.input(f.enqueue())); assert.ok('receipt' in result); assert.equal(result.receipt.state, 'accepted');
    assert.ok(lines.some(line => JSON.parse(line).operation === 'hermes-queue-projection' && JSON.parse(line).category === 'failed'));
    assert.ok(lines.every(line => !line.includes(key) && !line.includes(authorization) && !line.includes('private projection')));
    await queue.close();
  } finally { f.close(); }
});
