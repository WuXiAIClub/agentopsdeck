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
import { AsyncNativeQueue } from './async-native-queue.js';
import { validConnectorNativeQueueInput } from './connector-native-queue-domain.js';

for (const runtime of ['codex', 'openclaw'] as const) {
const authorization = 'Bearer isolated-native-queue', key = `${runtime}:original`;
const payload = (actorId: string, text = 'Original') => ({ actorId,
  ...(runtime === 'openclaw' ? { message: text, deliveryMode: 'normal', media: [] } : { text, images: [] }), marker: 'retained' });
const storedText = (store: ConnectorUserStore) => store.turns.head<{ text: string; message: string }>(runtime, key)!.payload[runtime === 'openclaw' ? 'message' : 'text'];
const silent = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-queue-')), tokenFile = join(root, 'tokens.json');
  const tokens = new ConnectorTokenStore(tokenFile, 'isolated-native-queue');
  const actor = tokens.authenticateAuthorization(authorization)!.tokenId;
  const store = new ConnectorUserStore(':memory:', id => !!tokens.delegationHubId(id), { runtimeOwner: true });
  const db = (store as unknown as { db: DatabaseSync }).db;
  const execute = createConnectorOwnerCommands(store, tokens), changes: unknown[] = [];
  const queue = new AsyncNativeQueue({ owner: { command: execute }, changed: (...args) => { changes.push(args); } });
  const enqueue = (id = 'message', owner = actor) => {
    store.turns.enqueue(runtime, { id, sessionKey: key, createdAt: 0, payload: payload(owner) });
    return store.turns.version(runtime, key, id)!;
  };
  const input = (version: string, mutationKey = 'edit', messageId = 'message') =>
    ({ runtime: runtime, key, authorization, target: { messageId }, mutationKey, version, text: ' Updated ' });
  const scope = (id = 'message') => JSON.stringify(['queue-mutation-v1', actor, key, id]);
  return { root, tokenFile, tokens, actor, store, db, execute, queue, changes, enqueue, input, scope,
    close() { execute.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test(`${runtime}: queue original actor/payload, CAS, accepted replay and command target resolution`, async () => {
  const f = fixture();
  try {
    const input = f.input(f.enqueue());
    f.store.commands.claim(JSON.stringify([f.actor, key]), 'send', {});
    f.store.commands.settle(JSON.stringify([f.actor, key]), 'send', { status: 200, body: { idempotencyKey: 'message' } });
    const result = await f.queue.edit({ ...input, target: { commandKey: 'send' } });
    assert.ok('receipt' in result); assert.equal(result.changed, true); assert.equal(result.receipt.result?.status, 200);
    assert.deepEqual(f.store.turns.head(runtime, key)!.payload, payload(f.actor, 'Updated'));
    const replay = await f.queue.edit(input); assert.ok('receipt' in replay);
    assert.equal(replay.changed, false); assert.deepEqual(replay.receipt, result.receipt); assert.equal(f.changes.length, 1);
    assert.deepEqual(await f.queue.edit({ ...input, text: 'different' }), { error: 409 });
    const stale = await f.queue.edit({ ...input, mutationKey: 'stale' }); assert.ok('receipt' in stale);
    assert.equal(stale.receipt.result?.status, 412);
    const page = await f.queue.commandPage({ runtime: runtime, key, authorization, after: 0 });
    assert.ok('page' in page); assert.equal(page.page.items[0]!.commandKey, 'send');
    const { text: _text, version: _version, ...address } = input;
    assert.deepEqual(await f.queue.readReceipt({ ...address, purpose: 'mutation', method: 'PATCH' }),
      { key, targetId: 'message', receipt: result.receipt });
  } finally { f.close(); }
});

test(`${runtime}: queue manager raw view/cancel crosses actors but command view and edit do not`, async () => {
  const f = fixture();
  try {
    const version = f.enqueue('message', 'other');
    const manager = f.tokens.create({ label: 'manager', scopes: ['queue:manage'] });
    const auth = `Bearer ${manager.token}`;
    const raw = await f.queue.page({ runtime: runtime, key, authorization: auth, after: 0 });
    assert.ok('page' in raw); assert.equal(raw.page.items.length, 1);
    const commands = await f.queue.commandPage({ runtime: runtime, key, authorization: auth, after: 0 });
    assert.ok('page' in commands); assert.equal(commands.page.items.length, 0);
    assert.deepEqual(await f.queue.edit({ ...f.input(version), authorization: auth }), { error: 403 });
    const { text: _, ...input } = f.input(version);
    const result = await f.queue.cancel({ ...input, authorization: auth });
    assert.ok('receipt' in result); assert.equal(result.changed, true);
    assert.equal(f.store.turns.head(runtime, key), undefined);
  } finally { f.close(); }
});

for (const state of ['queued', 'blocked', 'dispatching', 'outcome_unknown'] as const) {
  test(`${runtime}: queue cancellation protects ${state} according to original state policy`, async () => {
    const f = fixture();
    try {
      f.enqueue(); if (state !== 'queued') f.db.prepare('UPDATE connector_turns SET state=?').run(state);
      const { text: _, ...input } = f.input(f.store.turns.version(runtime, key, 'message')!, 'cancel');
      const result = await f.queue.cancel(input); assert.ok('receipt' in result);
      assert.equal(result.changed, state === 'queued' || state === 'blocked');
      assert.equal(result.receipt.result?.status, result.changed ? 200 : 409);
    } finally { f.close(); }
  });
}

test(`${runtime}: delegated queue authority retains actor and revoked grant cannot mutate`, async () => {
  const f = fixture();
  try {
    const issuer = f.tokens.create({ label: 'issuer', scopes: ['execution:delegate', 'messages:read', 'messages:send'], delegationHubId: 'hub' });
    const ref = f.store.executionGrants.issue({ principalId: 'member', grantKey: 'policy', version: 1,
      runtime, sessionKey: key, issuerTokenId: issuer.record.id, hubId: 'hub' }, ['messages:send'], Date.now() + 30_000);
    const input = { ...f.input(f.enqueue('message', ref.actorId)), authorization: `Bearer ${issuer.token}`, grantRef: ref.id, expectedNode: f.store.nodeId };
    for (const invalid of [{ ...input, grantRef: '' }, { ...input, grantRef: 'foreign' }, { ...input, expectedNode: 'foreign' }])
      assert.deepEqual(await f.queue.edit(invalid), { error: 403 });
    const result = await f.queue.edit(input); assert.ok('receipt' in result); assert.equal(result.changed, true);
    assert.equal(f.store.turns.head<{ actorId: string }>(runtime, key)!.payload.actorId, ref.actorId);
    f.store.executionGrants.revoke(issuer.record.id, ref.id);
    assert.deepEqual(await f.queue.edit({ ...input, mutationKey: 'revoked' }), { error: 403 });
    const { text: _, version: _v, ...address } = input;
    const read = await f.queue.readReceipt(address); assert.ok('receipt' in read); assert.deepEqual(read.receipt, result.receipt);
    assert.deepEqual(await f.queue.page({ runtime, key, authorization: input.authorization, after: 0 }), { error: 403 });
  } finally { f.close(); }
});

for (const fault of ['receipt', 'event'] as const) test(`${runtime}: queue ${fault} failure atomically rolls back and preserves unknown without replay`, async () => {
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
    assert.equal(storedText(f.store), 'Original');
    assert.equal(f.store.turns.version(runtime, key, 'message'), input.version);
    f.db.exec('DROP TRIGGER isolated_queue_fault');
    const result = await f.queue.edit(input); assert.ok('receipt' in result);
    assert.equal(result.changed, false); assert.equal(result.receipt.state, 'outcome_unknown');
  } finally { f.close(); }
});

test(`${runtime}: queue clones before await and rechecks revoked authority after original admission wait`, async () => {
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
      assert.equal(storedText(f.store), revoke ? 'Original' : 'Updated');
    } finally { f.close(); }
  }
});

test(`${runtime}: queue physical publication drains on close and accepted fact survives publication failure`, async () => {
  const f = fixture();
  try {
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    const queue = new AsyncNativeQueue({ owner: { command: f.execute }, changed: async () => { await wait; throw Error('projection unavailable'); } });
    const pending = queue.edit(f.input(f.enqueue())); await tick();
    let closed = false; const closing = queue.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false); assert.equal(queue.close(), queue.close());
    await assert.rejects(queue.page({ runtime: runtime, key, authorization, after: 0 }));
    release(); const result = await pending; assert.ok('receipt' in result); assert.equal(result.receipt.state, 'accepted');
    await closing; assert.equal(closed, true);
  } finally { f.close(); }
});

test(`${runtime}: sole worker long edit and unknown survive physical close/reopen without replay`, async () => {
  const f = fixture(), file = join(f.root, 'worker.sqlite'); let owner: AsyncConnectorOwner | undefined;
  try {
    const setup = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
    for (const id of ['message', 'unknown']) await setup.turns.enqueueAsync(runtime, { id, sessionKey: key, createdAt: 0, payload: payload(f.actor) });
    const input = { ...f.input(setup.turns.version(runtime, key, 'message')!), text: '\u0001'.repeat(MAX_MESSAGE_CHARS) };
    const unknown = { ...input, mutationKey: 'unknown', target: { messageId: 'unknown' }, version: setup.turns.version(runtime, key, 'unknown')! };
    await setup.commands.claimAsync(f.scope('unknown'), 'unknown', { method: 'PATCH', version: unknown.version, text: unknown.text }); setup.close();
    owner = new AsyncConnectorOwner({ file, tokenFile: f.tokenFile }, silent);
    let queue = new AsyncNativeQueue({ owner, changed: () => {} });
    const accepted = await queue.edit(input); assert.ok('receipt' in accepted); assert.equal(accepted.changed, true);
    const uncertain = await queue.edit(unknown); assert.ok('receipt' in uncertain); assert.equal(uncertain.changed, false);
    await queue.close(); await owner.closeForShutdown(); owner = new AsyncConnectorOwner({ file, tokenFile: f.tokenFile }, silent);
    queue = new AsyncNativeQueue({ owner, changed: () => {} });
    const replay = await queue.edit(input); assert.ok('receipt' in replay); assert.equal(replay.changed, false); assert.deepEqual(replay.receipt, accepted.receipt);
    const original = await queue.edit(unknown); assert.ok('receipt' in original); assert.equal(original.receipt.state, 'outcome_unknown');
    await queue.close();
  } finally { await owner?.closeForShutdown(); f.close(); }
});

for (const fence of ['pause', 'settings', 'deletion', 'foreign-actor'] as const) test(`${runtime}: queue ${fence} fences fresh edits and preserves original text`, async () => {
  const f = fixture();
  try {
    const input = f.input(f.enqueue('message', fence === 'foreign-actor' ? 'other' : f.actor));
    if (fence === 'pause') f.store.pauseTurnStarts();
    if (fence === 'settings') await f.store.commands.claimAsync(JSON.stringify(['settings', JSON.stringify([f.actor, key])]), 'settings', {}, false, undefined, undefined, undefined, true);
    if (fence === 'deletion') await f.store.commands.claimAsync(JSON.stringify(['delete', JSON.stringify([f.actor, key])]), 'deletion', {});
    const result = await f.queue.edit(input); assert.ok('receipt' in result); assert.equal(result.changed, false);
    assert.equal(result.receipt.result?.status, fence === 'foreign-actor' ? 404 : 409);
    assert.equal(storedText(f.store), 'Original');
  } finally { f.close(); }
});

test(`${runtime}: queue transactional revoke rolls back edit; storage faults are not classified as authority denial`, async () => {
  const f = fixture();
  try {
    const input = f.input(f.enqueue()), original = f.tokens.authenticateAuthorization.bind(f.tokens);
    let checks = 0;
    f.tokens.authenticateAuthorization = authorization => f.db.isTransaction && ++checks === 2 ? undefined : original(authorization);
    const result = await f.queue.edit(input); assert.ok('receipt' in result); assert.equal(result.receipt.result?.status, 403);
    assert.equal(storedText(f.store), 'Original');
    f.tokens.authenticateAuthorization = () => { throw Error('isolated credential storage failure'); };
    await assert.rejects(f.queue.page({ runtime: runtime, key, authorization, after: 0 }), /isolated credential storage failure/);
  } finally { f.close(); }
});

test(`${runtime}: queue publication rechecks manager scope and returns no cross-actor page on revocation`, async () => {
  const f = fixture();
  try {
    f.enqueue('message', 'other'); const manager = f.tokens.create({ label: 'manager', scopes: ['queue:manage', 'messages:read'] });
    const original = f.tokens.authenticateAuthorization.bind(f.tokens); let checks = 0;
    f.tokens.authenticateAuthorization = value => { const p = original(value); return ++checks >= 3 && p ? { ...p, scopes: ['messages:read'] } : p; };
    assert.deepEqual(await f.queue.page({ runtime: runtime, key, authorization: `Bearer ${manager.token}`, after: 0 }), { error: 403 });
  } finally { f.close(); }
});

test(`${runtime}: queue protocol rejects caller authority and facade rejects foreign receipt, target, key and cursor`, async () => {
  const f = fixture();
  try {
    const input = f.input(f.enqueue());
    for (const extra of [{ actorId: 'forged' }, { manager: true }, { authorization: 'bad\r\nheader' }, { runtime: 'ghcp' }, { version: '0:0' }])
      assert.equal(validConnectorNativeQueueInput('nativeQueuedEdit', { ...input, ...extra }), false);
    const result = await f.queue.edit(input); assert.ok('receipt' in result);
    for (const patch of [{ key: `${runtime}:foreign` }, { targetId: 'foreign' }, { receipt: { ...result.receipt, key: 'foreign' } }]) {
      const queue = new AsyncNativeQueue({ owner: { command: (async () => ({ ...result, ...patch })) as AsyncConnectorOwner['command'] }, changed: () => { throw Error('must not publish'); } });
      await assert.rejects(queue.edit(input)); await queue.close();
    }
    const queue = new AsyncNativeQueue({ owner: { command: (async () => ({ key, page: { items: [{ id: 'message', version: '1:1', state: 'queued', createdAt: 0 }], nextCursor: null } })) as AsyncConnectorOwner['command'] }, changed: () => {} });
    await assert.rejects(queue.page({ runtime: runtime, key, authorization, after: 1 })); await queue.close();
  } finally { f.close(); }
});

test(`${runtime}: queue projection failure emits redacted bounded diagnostics without altering accepted fact`, async () => {
  const f = fixture();
  try {
    const lines: string[] = [];
    const diagnostics = new PerformanceDiagnostics(line => { lines.push(line); });
    const queue = new AsyncNativeQueue({ owner: { command: f.execute }, diagnostics,
      changed: () => { throw Error('private projection detail'); } });
    const result = await queue.edit(f.input(f.enqueue())); assert.ok('receipt' in result); assert.equal(result.receipt.state, 'accepted');
    assert.ok(lines.some(line => JSON.parse(line).operation === 'native-queue-projection' && JSON.parse(line).category === 'failed'));
    assert.ok(lines.every(line => !line.includes(key) && !line.includes(authorization) && !line.includes('private projection')));
    await queue.close();
  } finally { f.close(); }
});

if (runtime === 'openclaw') for (const method of ['PATCH', 'DELETE'] as const) for (const fault of [false, true]) {
  test(`OpenClaw mirror ${method}: receipt/event/queue/mirror share one transaction, fault=${fault}`, async () => {
    const f = fixture();
    try {
      f.store.turns.enqueue(runtime, { id: 'message', sessionKey: key, createdAt: 0,
        payload: { ...payload(f.actor), deliveryMode: 'mirror', media: [{ marker: 'original-media' }] } }, db => {
        f.store.mirrorOutbox.admitInTransaction(db, { actorId: f.actor, sessionKey: key, after: 0,
          idempotencyKey: 'message', inputText: 'Original', explicitRoute: { originatingChannel: 'test', originatingTo: 'target', outboundTarget: 'target' } });
      });
      const input = f.input(f.store.turns.version(runtime, key, 'message')!);
      const before = f.store.mirrorOutbox.get('message');
      if (fault) f.db.exec("CREATE TRIGGER isolated_mirror_receipt BEFORE UPDATE ON command_receipts BEGIN SELECT RAISE(ABORT, 'mirror receipt fault'); END");
      const { text: _text, ...cancelInput } = input;
      const mutate = () => method === 'PATCH' ? f.queue.edit(input) : f.queue.cancel(cancelInput);
      if (fault) {
        await assert.rejects(mutate(), /mirror receipt fault/);
        assert.equal(storedText(f.store), 'Original');
        assert.deepEqual(f.store.mirrorOutbox.get('message'), before);
        assert.equal(f.store.turns.version(runtime, key, 'message'), input.version);
        f.db.exec('DROP TRIGGER isolated_mirror_receipt');
        const recovered = await mutate(); assert.ok('receipt' in recovered);
        assert.equal(recovered.changed, false); assert.equal(recovered.receipt.state, 'outcome_unknown');
        assert.deepEqual(f.store.mirrorOutbox.get('message'), before);
      } else {
        const result = await mutate(); assert.ok('receipt' in result); assert.equal(result.changed, true);
        if (method === 'DELETE') {
          assert.equal(f.store.turns.head(runtime, key), undefined); assert.equal(f.store.mirrorOutbox.get('message'), undefined);
        } else {
          assert.equal(storedText(f.store), 'Updated'); assert.equal(f.store.mirrorOutbox.get('message')?.inputText, 'Updated');
          assert.deepEqual(f.store.turns.head<{ media: unknown[] }>(runtime, key)!.payload.media, [{ marker: 'original-media' }]);
        }
      }
    } finally { await f.queue.close(); f.close(); }
  });
}
}
