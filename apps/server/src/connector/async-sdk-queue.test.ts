import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Worker } from 'node:worker_threads';
import { ConnectorUserStore } from './connector-user-store.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { CommandReceipts } from '../commands/receipts.js';
import { AsyncSdkQueue } from './async-sdk-queue.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { validConnectorSdkQueueInput, validConnectorSdkQueueOutput } from './connector-sdk-queue-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { SdkAgentId } from './sdk-execution-journal.js';
import { MAX_MESSAGE_CHARS, MAX_TEXT_MESSAGE_BODY_BYTES } from '@agentopsdeck/shared';
import { connectorOwnerCommandBytes } from './connector-owner-domain.js';
import { APPLICATION_TRANSACTION_COMMAND_OVERHEAD } from '../auth/application-transaction-gate.js';
import { validConnectorSdkQueueReadInput, validConnectorSdkQueueReadOutput } from './connector-sdk-queue-read-domain.js';

const silent = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(runtime: SdkAgentId) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-queue-'));
  const tokenFile = join(root, 'tokens.json'), authorization = 'Bearer isolated-fixture-token';
  const tokens = new ConnectorTokenStore(tokenFile, 'isolated-fixture-token');
  const actorId = tokens.authenticateAuthorization(authorization)!.tokenId;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const db = (store as unknown as { db: DatabaseSync }).db;
  const journal = runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal, key = `${runtime}:session`;
  journal.create({ key, nativeSessionId: 'native', title: 'Original', createdAt: 0 });
  const owner = { command: createConnectorOwnerCommands(store, tokens) }, queue = new AsyncSdkQueue(owner);
  const enqueue = (id = 'message', actor = actorId, attachments = false) => {
    store.turns.enqueue(runtime, { id, sessionKey: key, createdAt: 0, payload: { actorId: actor, text: 'Original', images: [],
      ...(attachments ? { attachmentCount: 1 } : {}) } }, attachments ? () => {
      store.sdkAttachments.save(key, id, [{ id: 'resource', name: 'private.txt', mimeType: 'text/plain', data: Buffer.from('private fixture body').toString('base64') }]);
    } : undefined);
    return store.turns.version(runtime, key, id)!;
  };
  const input = (version: string, mutationKey = 'cancel') => ({ runtime, key, authorization, target: { messageId: 'message' }, mutationKey, version });
  const scope = (id = 'message', actor = actorId) => JSON.stringify(['queue-mutation-v1', actor, key, id]);
  const close = () => { store.close(); rmSync(root, { recursive: true, force: true }); };
  return { root, tokenFile, tokens, authorization, actorId, store, db, journal, runtime, key, owner, queue, enqueue, input, scope, close };
}
for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: edit keeps attachment and payload identity, atomic version/receipt and original PATCH fingerprint`, async () => {
    const f = fixture(runtime);
    try {
      const input = { ...f.input(f.enqueue('message', f.actorId, true), 'edit'), text: '  Updated  ' };
      const result = await f.queue.edit(input); assert.ok('receipt' in result);
      assert.equal(result.changed, true); assert.equal(result.receipt.state, 'accepted');
      const row = f.store.turns.head<{ text: string; actorId: string; attachmentCount: number }>(runtime, f.key)!;
      assert.equal(row.payload.text, 'Updated'); assert.equal(row.payload.actorId, f.actorId); assert.equal(row.payload.attachmentCount, 1);
      assert.equal(f.store.sdkAttachments.media(f.key, 'message').length, 1);
      assert.notEqual(f.store.turns.version(runtime, f.key, 'message'), input.version);
      const duplicate = await f.queue.edit({ ...input, text: 'Updated' }); assert.ok('receipt' in duplicate);
      assert.equal(duplicate.changed, false); assert.deepEqual(duplicate.receipt, result.receipt);
      assert.deepEqual(await f.queue.edit({ ...input, text: 'different' }), { error: 409 });
      const legacy = (await f.store.commands.claimAsync(f.scope(), 'edit', { method: 'PATCH', version: input.version, text: 'Updated' }));
      assert.equal(legacy.fresh, false); assert.deepEqual(legacy.receipt, result.receipt);
      const { version: _, text: __, ...read } = input;
      assert.deepEqual(await f.queue.readReceipt(read), { key: f.key, targetId: 'message', receipt: result.receipt });
    } finally { f.close(); }
  });
  test(`${runtime}: edit rejects blocked/dispatching/unknown, compact control, stale versions and foreign actors`, async () => {
    for (const scenario of ['blocked', 'dispatching', 'outcome_unknown', 'compact', 'version', 'actor', 'delegated', 'pause', 'settings', 'deleted'] as const) {
      const f = fixture(runtime);
      try {
        const version = f.enqueue('message', scenario === 'actor' ? 'other' : f.actorId);
        if (['blocked', 'dispatching', 'outcome_unknown'].includes(scenario)) f.db.prepare('UPDATE connector_turns SET state=?').run(scenario);
        if (scenario === 'delegated') f.db.prepare("UPDATE connector_turns SET payload=json_set(payload,'$.executionGrant',json('{}'))").run();
        if (scenario === 'pause') f.store.pauseTurnStarts();
        if (scenario === 'settings') (await f.store.commands.claimAsync(JSON.stringify(['settings', JSON.stringify([f.actorId, f.key])]), 'pending', {}, false, undefined, undefined, undefined, true));
        if (scenario === 'deleted') f.journal.beginDeletion(f.key, 'delete');
        const input = { ...f.input(scenario === 'version' ? '9:9' : version, 'edit'), text: scenario === 'compact' ? ' /compact now ' : 'Updated' };
        const result = await f.queue.edit(input); assert.ok('receipt' in result, scenario);
        assert.equal(result.changed, false, scenario); assert.equal(result.receipt.state, 'rejected', scenario);
        assert.equal(result.receipt.result?.status, scenario === 'actor' ? 404 : scenario === 'version' ? 412 : scenario === 'delegated' ? 403 : 409, scenario);
        assert.equal(f.store.turns.head<{ text: string }>(runtime, f.key)?.payload.text, 'Original', scenario);
      } finally { f.close(); }
    }
  });
  test(`${runtime}: failed edit receipt rolls original text/version/media back and duplicate stays unknown`, async () => {
    const f = fixture(runtime);
    try {
      const input = { ...f.input(f.enqueue('message', f.actorId, true), 'edit'), text: 'Updated' };
      f.db.exec("CREATE TRIGGER fail_edit_receipt BEFORE UPDATE ON command_receipts BEGIN SELECT RAISE(ABORT,'isolated edit receipt failure'); END");
      await assert.rejects(f.queue.edit(input), /isolated edit receipt failure/);
      assert.equal(f.store.turns.head<{ text: string }>(runtime, f.key)?.payload.text, 'Original');
      assert.equal(f.store.turns.version(runtime, f.key, 'message'), input.version);
      assert.equal(f.store.sdkAttachments.media(f.key, 'message').length, 1);
      f.db.exec('DROP TRIGGER fail_edit_receipt');
      const duplicate = await f.queue.edit(input); assert.ok('receipt' in duplicate);
      assert.equal(duplicate.changed, false); assert.equal(duplicate.receipt.state, 'outcome_unknown');
      assert.equal(f.store.turns.head<{ text: string }>(runtime, f.key)?.payload.text, 'Original');
    } finally { f.close(); }
  });
  test(`${runtime}: edit repeats transaction authority and preserves input across async admission`, async () => {
    for (const revoked of ['no', 'wait', 'transaction'] as const) {
      const f = fixture(runtime);
      try {
        const input = { ...f.input(f.enqueue(), 'edit'), text: 'Updated' };
        let release!: () => void;
        const wait = new Promise<void>(resolve => { release = resolve; });
        Object.defineProperty(f.store, 'commands', { value: new CommandReceipts(f.db, undefined, undefined, undefined, undefined, silent,
          async (_bytes, write) => { await wait; return write(); }) });
        const original = f.tokens.authenticateAuthorization.bind(f.tokens); let checks = 0;
        f.tokens.authenticateAuthorization = authorization => {
          if (f.db.isTransaction && ++checks === 2 && revoked === 'transaction') return undefined;
          return original(authorization);
        };
        const pending = f.queue.edit(input); await tick();
        input.text = 'retargeted'; input.target.messageId = 'other'; input.mutationKey = 'other'; input.version = '9:9';
        if (revoked === 'wait') f.tokens.revoke(f.actorId);
        release(); const result = await pending;
        if (revoked === 'wait') { assert.deepEqual(result, { error: 403 }); assert.equal(f.store.commands.get(f.scope(), 'edit'), undefined); }
        else { assert.ok('receipt' in result); assert.equal(result.changed, revoked === 'no'); assert.equal(result.receipt.result?.status, revoked === 'no' ? 200 : 403); }
        assert.equal(f.store.turns.head<{ text: string }>(runtime, f.key)?.payload.text, revoked === 'no' ? 'Updated' : 'Original');
      } finally { f.close(); }
    }
  });
  test(`${runtime}: real sole worker accepts long edit and preserves accepted/unknown across reopen`, async () => {
    const f = fixture(runtime), file = join(f.root, 'edit.sqlite'); let owner: AsyncConnectorOwner | undefined;
    try {
      const setup = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
      (runtime === 'ghcp' ? setup.copilotJournal : setup.claudeJournal).create({ key: f.key, nativeSessionId: 'native', title: 'Original', createdAt: 0 });
      for (const id of ['message', 'unknown']) await setup.turns.enqueueAsync(runtime, { id, sessionKey: f.key, createdAt: 0, payload: { actorId: f.actorId, text: 'Original', images: [] } });
      const input = { ...f.input(setup.turns.version(runtime, f.key, 'message')!, 'edit'), text: '\u0001'.repeat(MAX_MESSAGE_CHARS) };
      const unknown = { ...input, mutationKey: 'unknown', target: { messageId: 'unknown' }, version: setup.turns.version(runtime, f.key, 'unknown')! };
      (await setup.commands.claimAsync(f.scope('unknown'), 'unknown', { method: 'PATCH', version: unknown.version, text: unknown.text })); setup.close();
      owner = new AsyncConnectorOwner({ file, tokenFile: f.tokenFile }, silent);
      const page = await new AsyncSdkQueue(owner).page({ runtime, key: f.key, authorization: f.authorization, after: 0 });
      assert.ok('page' in page); assert.equal(page.page.items.length, 2);
      const result = await new AsyncSdkQueue(owner).edit(input); assert.ok('receipt' in result); assert.equal(result.changed, true);
      const uncertain = await new AsyncSdkQueue(owner).edit(unknown); assert.ok('receipt' in uncertain); assert.equal(uncertain.changed, false);
      await owner.closeForShutdown(); owner = new AsyncConnectorOwner({ file, tokenFile: f.tokenFile }, silent);
      const repeated = await new AsyncSdkQueue(owner).edit(input); assert.ok('receipt' in repeated); assert.equal(repeated.changed, false); assert.deepEqual(repeated.receipt, result.receipt);
      await owner.closeForShutdown();
      const verify = new ConnectorUserStore(file);
      try { assert.equal(verify.turns.head<{ text: string }>(runtime, f.key)?.payload.text, input.text);
        assert.equal(verify.turns.list<{ text: string }>(runtime, f.key).find(row => row.id === 'unknown')?.payload.text, 'Original'); }
      finally { verify.close(); }
    } finally { await owner?.closeForShutdown(); f.close(); }
  });
  test(`${runtime}: bounded queue metadata preserves raw manager and actor-only command views without loading bodies`, async () => {
    const f = fixture(runtime);
    try {
      for (let i = 0; i < 66; i++) f.enqueue(`item-${i}`);
      f.enqueue('other-actor', 'other');
      const receiptScope = JSON.stringify([f.actorId, f.key]);
      (await f.store.commands.claimAsync(receiptScope, 'send', {}));
      f.store.commands.settle(receiptScope, 'send', { status: 202, body: { idempotencyKey: 'item-0' } });
      const input = { runtime, key: f.key, authorization: f.authorization, after: 0 };
      const first = await f.queue.commandPage(input); assert.ok('page' in first);
      assert.equal(first.page.items.length, 64); assert.ok(first.page.nextCursor);
      assert.equal(first.page.items[0]?.commandKey, 'send');
      assert.equal(first.page.items[1]?.commandKey, null);
      assert.equal(JSON.stringify(first).includes('item-0'), false); assert.equal(JSON.stringify(first).includes('Original'), false);
      const next = await f.queue.commandPage({ ...input, after: Number(first.page.nextCursor) }); assert.ok('page' in next);
      assert.equal(next.page.items.length, 2); assert.equal(next.page.nextCursor, null);
      const manager = f.tokens.create({ label: 'manager', scopes: ['queue:manage'] });
      const raw = await f.queue.page({ ...input, authorization: `Bearer ${manager.token}`, after: Number(first.page.nextCursor) }); assert.ok('page' in raw);
      assert.equal(raw.page.items.length, 3); assert.equal(raw.page.items.at(-1)?.id, 'other-actor');
      const reader = f.tokens.create({ label: 'reader', scopes: ['messages:read'] });
      f.enqueue('reader-only', reader.record.id);
      f.store.pauseTurnStarts();
      const paused = await f.queue.commandPage(input); assert.deepEqual(paused, first);
      const own = await f.queue.page({ ...input, authorization: `Bearer ${reader.token}` }); assert.ok('page' in own);
      assert.deepEqual(own.page.items.map(row => row.id), ['reader-only']);
      assert.deepEqual(await f.queue.page({ ...input, authorization: 'Bearer missing' }), { error: 401 });
    } finally { f.close(); }
  });
  test(`${runtime}: queue read checks fresh publication authority including lost manager scope`, async () => {
    for (const revoked of ['token', 'manager'] as const) {
      const f = fixture(runtime);
      try {
        f.enqueue('other', 'other');
        const manager = f.tokens.create({ label: 'manager', scopes: ['queue:manage', 'messages:read'] });
        const original = f.tokens.authenticateAuthorization.bind(f.tokens); let checks = 0;
        f.tokens.authenticateAuthorization = authorization => {
          const principal = original(authorization);
          if (++checks >= 3) return revoked === 'token' ? undefined : principal && { ...principal, scopes: ['messages:read'] };
          return principal;
        };
        assert.deepEqual(await f.queue.page({ runtime, key: f.key, authorization: `Bearer ${manager.token}`, after: 0 }), { error: 403 });
      } finally { f.close(); }
    }
  });
  test(`${runtime}: damaged stored queue metadata fails closed without editing originals`, async () => {
    const f = fixture(runtime);
    try {
      f.enqueue(); f.db.prepare('UPDATE connector_turns SET revision=0').run();
      await assert.rejects(f.queue.page({ runtime, key: f.key, authorization: f.authorization, after: 0 }), /unavailable/);
      assert.equal(f.store.turns.head<{ text: string }>(runtime, f.key)?.payload.text, 'Original');
    } finally { f.close(); }
  });
  test(`${runtime}: cancellation atomically removes queue/media and accepts original receipt; duplicate does not replay`, async () => {
    const f = fixture(runtime);
    try {
      const input = f.input(f.enqueue('message', f.actorId, true));
      const result = await f.queue.cancel(input); assert.ok('receipt' in result);
      assert.equal(result.changed, true); assert.equal(result.receipt.state, 'accepted');
      assert.deepEqual(result.receipt.result, { status: 200, body: { ok: true } });
      assert.equal(f.store.turns.head(runtime, f.key), undefined); assert.deepEqual(f.store.sdkAttachments.media(f.key, 'message'), []);
      const duplicate = await f.queue.cancel(input); assert.ok('receipt' in duplicate);
      assert.equal(duplicate.changed, false); assert.deepEqual(duplicate.receipt, result.receipt);
      const { version: _, ...read } = input;
      assert.deepEqual(await f.queue.readReceipt(read), { key: f.key, targetId: 'message', receipt: result.receipt });
      const row = f.db.prepare('SELECT fingerprint FROM command_receipts WHERE scope=? AND command_key=?').get(f.scope(), 'cancel');
      assert.ok(row); // the old scope and original DELETE fingerprint remain usable
      assert.deepEqual(await f.queue.cancel({ ...input, version: '1:999' }), { error: 409 });
      const abort = new AbortController(); abort.abort();
      assert.throws(() => f.queue.cancel({ ...input, mutationKey: 'aborted' }, abort.signal), /abort/i);
      assert.equal(f.store.commands.get(f.scope(), 'aborted'), undefined);
    } finally { f.close(); }
  });
  for (const state of ['queued', 'blocked', 'dispatching', 'outcome_unknown'] as const) {
    test(`${runtime}: ${state} cancellation only permits provably unsent queue rows`, async () => {
      const f = fixture(runtime);
      try {
        f.enqueue();
        if (state === 'blocked') f.store.turns.block(runtime, 'message');
        if (state === 'dispatching' || state === 'outcome_unknown') {
          f.journal.begin({ key: f.key, id: 'execution', epoch: 'epoch' }, ['message'], f.store.turns);
          if (state === 'outcome_unknown') f.store.turns.recoverInterrupted(runtime);
        }
        const result = await f.queue.cancel(f.input(f.store.turns.version(runtime, f.key, 'message')!));
        assert.ok('receipt' in result);
        const unsent = state === 'queued' || state === 'blocked';
        assert.equal(result.changed, unsent); assert.equal(result.receipt.state, unsent ? 'accepted' : 'rejected');
        assert.equal(f.store.turns.hasPending(runtime, f.key), !unsent);
      } finally { f.close(); }
    });
  }
  test(`${runtime}: wrong actor, stale version and maintenance leave original queue intact`, async () => {
    const f = fixture(runtime);
    try {
      const version = f.enqueue();
      const other = f.tokens.create({ label: 'Other', scopes: ['messages:send', 'messages:read', 'queue:manage'] });
      const denied = await f.queue.cancel({ ...f.input(version), authorization: `Bearer ${other.token}` });
      assert.ok('receipt' in denied); assert.equal(denied.receipt.result?.status, 404);
      const stale = await f.queue.cancel(f.input('1:999', 'stale')); assert.ok('receipt' in stale);
      assert.equal(stale.receipt.result?.status, 412);
      const resume = f.store.pauseTurnStarts();
      const paused = await f.queue.cancel(f.input(version, 'paused')); assert.ok('receipt' in paused);
      assert.equal(paused.receipt.result?.status, 409); assert.equal(f.store.turns.hasPending(runtime, f.key), true);
      assert.equal(resume(), true);
      const done = await f.queue.cancel(f.input(version)); assert.ok('receipt' in done); assert.equal(done.changed, true);
      f.store.pauseTurnStarts();
      const repeated = await f.queue.cancel(f.input(version)); assert.ok('receipt' in repeated); assert.equal(repeated.changed, false);
      assert.deepEqual(repeated.receipt, done.receipt); // settled receipt survives maintenance
    } finally { f.close(); }
  });
  test(`${runtime}: preexisting uncertain receipt is not a license to cancel or replay`, async () => {
    const f = fixture(runtime);
    try {
      const input = f.input(f.enqueue());
      const first = (await f.store.commands.claimAsync(f.scope(), input.mutationKey, { method: 'DELETE', version: input.version, text: '' }));
      const result = await f.queue.cancel(input); assert.ok('receipt' in result);
      assert.deepEqual(result.receipt, first.receipt); assert.equal(result.changed, false);
      assert.equal(f.store.turns.head(runtime, f.key)?.state, 'queued');
    } finally { f.close(); }
  });
  test(`${runtime}: attachment/receipt write fault rolls back queue and attachments; unknown never auto-retries`, async () => {
    const f = fixture(runtime);
    try {
      const input = f.input(f.enqueue('message', f.actorId, true));
      f.db.exec("CREATE TRIGGER fixture_cancel_failure BEFORE UPDATE OF state ON command_receipts WHEN NEW.state='accepted' BEGIN SELECT RAISE(ABORT, 'isolated fault'); END");
      await assert.rejects(f.queue.cancel(input), /isolated fault/);
      assert.equal(f.store.turns.head(runtime, f.key)?.state, 'queued'); assert.equal(f.store.sdkAttachments.media(f.key, 'message').length, 1);
      assert.equal(f.store.commands.get(f.scope(), 'cancel')?.state, 'outcome_unknown');
      f.db.exec('DROP TRIGGER fixture_cancel_failure');
      const repeated = await f.queue.cancel(input); assert.ok('receipt' in repeated);
      assert.equal(repeated.changed, false); assert.equal(repeated.receipt.state, 'outcome_unknown');
      assert.equal(f.store.turns.head(runtime, f.key)?.state, 'queued');
    } finally { f.close(); }
  });
  test(`${runtime}: post-commit notification failure keeps accepted receipt; late abort cannot undo cancellation`, async () => {
    const f = fixture(runtime);
    try {
      const input = f.input(f.enqueue());
      Object.defineProperty(f.store.turns, 'notifyAdmission', { value: () => { throw Error('isolated notification failure'); } });
      const abort = new AbortController();
      const pending = f.queue.cancel(input, abort.signal); abort.abort();
      const result = await pending; assert.ok('receipt' in result);
      assert.equal(result.changed, true); assert.equal(result.receipt.state, 'accepted');
      assert.equal(f.store.turns.hasPending(runtime, f.key), false);
      const duplicate = await f.queue.cancel(input); assert.ok('receipt' in duplicate);
      assert.equal(duplicate.changed, false); assert.deepEqual(duplicate.receipt, result.receipt);
    } finally { f.close(); }
  });
  test(`${runtime}: authorization is repeated under original claim and queue transactions`, async () => {
    const f = fixture(runtime);
    try {
      const input = f.input(f.enqueue());
      const original = f.tokens.authenticateAuthorization.bind(f.tokens);
      let claimChecks = 0;
      f.tokens.authenticateAuthorization = authorization => {
        if (f.db.isTransaction) { claimChecks++; if (claimChecks === 2) return undefined; }
        return original(authorization);
      };
      const result = await f.queue.cancel(input); assert.ok('receipt' in result);
      assert.equal(result.receipt.state, 'rejected'); assert.equal(result.receipt.result?.status, 403);
      assert.equal(claimChecks, 2); assert.equal(f.store.turns.head(runtime, f.key)?.state, 'queued');
    } finally { f.close(); }
  });
  test(`${runtime}: token revoked across async volume wait produces no receipt or cancellation`, async () => {
    const f = fixture(runtime);
    try {
      const input = f.input(f.enqueue());
      let release!: () => void;
      const wait = new Promise<void>(resolve => { release = resolve; });
      const receipts = new CommandReceipts(f.db, undefined, undefined, undefined, undefined, silent,
        async (_bytes, write) => { await wait; return write(); });
      Object.defineProperty(f.store, 'commands', { value: receipts });
      const pending = f.queue.cancel(input); await tick(); f.tokens.revoke(f.actorId); release();
      assert.deepEqual(await pending, { error: 403 }); assert.equal(receipts.get(f.scope(), 'cancel'), undefined);
      assert.equal(f.store.turns.head(runtime, f.key)?.state, 'queued');
    } finally { f.close(); }
  });
  test(`${runtime}: admission await cannot retarget mutable request identity`, async () => {
    const f = fixture(runtime);
    try {
      const input = f.input(f.enqueue());
      let release!: () => void;
      const wait = new Promise<void>(resolve => { release = resolve; });
      Object.defineProperty(f.store, 'commands', { value: new CommandReceipts(f.db, undefined, undefined, undefined, undefined, silent,
        async (_bytes, write) => { await wait; return write(); }) });
      const pending = f.queue.cancel(input); await tick();
      input.key = `${runtime}:other`; input.target.messageId = 'other'; input.mutationKey = 'other'; input.version = '9:9';
      release(); const result = await pending; assert.ok('receipt' in result);
      assert.equal(result.changed, true); assert.equal(result.receipt.key, 'cancel');
      assert.equal(f.store.turns.hasPending(runtime, f.key), false); assert.ok(f.store.commands.get(f.scope(), 'cancel'));
    } finally { f.close(); }
  });
  test(`${runtime}: command-addressed cancellation preserves actor-owned admission scope after row removal`, async () => {
    const f = fixture(runtime);
    try {
      const version = f.enqueue();
      const scope = JSON.stringify([f.actorId, f.key]);
      (await f.store.commands.claimAsync(scope, 'send', {}));
      f.store.commands.settle(scope, 'send', { status: 202, body: { idempotencyKey: 'message' } });
      const input = { ...f.input(version), target: { commandKey: 'send' } };
      const result = await f.queue.cancel(input); assert.ok('receipt' in result); assert.equal(result.changed, true);
      const { version: _, ...read } = input;
      assert.deepEqual(await f.queue.readReceipt(read), { key: f.key, targetId: 'message', receipt: result.receipt });
      assert.deepEqual(await f.queue.cancel({ ...input, target: { commandKey: 'missing' } }), { error: 404 });
    } finally { f.close(); }
  });
  test(`${runtime}: real sole worker reopen preserves accepted and unknown cancellation without native replay`, async () => {
    const f = fixture(runtime), file = join(f.root, 'original.sqlite');
    let asyncOwner: AsyncConnectorOwner | undefined;
    try {
      const setup = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
      const journal = runtime === 'ghcp' ? setup.copilotJournal : setup.claudeJournal;
      journal.create({ key: f.key, nativeSessionId: 'native', title: 'Original', createdAt: 0 });
      for (const id of ['message', 'unknown']) await setup.turns.enqueueAsync(runtime, { id, sessionKey: f.key, createdAt: 0,
        payload: { actorId: f.actorId, text: 'Original', images: [] } });
      const input = f.input(setup.turns.version(runtime, f.key, 'message')!);
      const unknown = { ...f.input(setup.turns.version(runtime, f.key, 'unknown')!, 'unknown'), target: { messageId: 'unknown' } };
      (await setup.commands.claimAsync(f.scope('unknown'), 'unknown', { method: 'DELETE', version: unknown.version, text: '' })); setup.close();
      asyncOwner = new AsyncConnectorOwner({ file, tokenFile: f.tokenFile }, silent);
      const queue = new AsyncSdkQueue(asyncOwner);
      const result = await queue.cancel(input); assert.ok('receipt' in result); assert.equal(result.changed, true);
      const uncertain = await queue.cancel(unknown); assert.ok('receipt' in uncertain); assert.equal(uncertain.changed, false);
      await asyncOwner.closeForShutdown();
      asyncOwner = new AsyncConnectorOwner({ file, tokenFile: f.tokenFile }, silent);
      const reopened = await new AsyncSdkQueue(asyncOwner).cancel(input); assert.ok('receipt' in reopened);
      assert.equal(reopened.changed, false); assert.deepEqual(reopened.receipt, result.receipt);
      await asyncOwner.closeForShutdown();
      const verify = new ConnectorUserStore(file);
      try { assert.equal(verify.turns.head(runtime, f.key)?.id, 'unknown'); assert.equal(verify.turns.head(runtime, f.key)?.state, 'queued'); }
      finally { verify.close(); }
    } finally { await asyncOwner?.closeForShutdown(); f.close(); }
  });
}
test('SDK queue port rejects authority booleans, runtime/target confusion and extra fields', () => {
  const input = { runtime: 'ghcp', key: 'ghcp:session', target: { messageId: 'message' }, mutationKey: 'cancel', version: '1:1', authorization: 'Bearer fixture' };
  assert.equal(validConnectorSdkQueueInput('sdkQueuedCancel', input), true);
  for (const bad of [{ ...input, authorized: true }, { ...input, actorId: 'owner' }, { ...input, key: 'claude-code:session' },
    { ...input, target: { messageId: 'message', commandKey: 'send' } }, { ...input, version: '0:1' }, { ...input, authorization: 'Bearer fixture\n' }])
    assert.equal(validConnectorSdkQueueInput('sdkQueuedCancel', bad), false);
  assert.equal(validConnectorSdkQueueOutput('sdkQueuedCancel', { error: '403' }), false);
  const reply = { key: 'ghcp:session', targetId: 'message', changed: true,
    receipt: { id: 'receipt', key: 'cancel', state: 'accepted', createdAt: 0, updatedAt: 0, result: { status: 200, body: { ok: true } } } };
  assert.equal(validConnectorSdkQueueOutput('sdkQueuedCancel', reply), true);
  for (const receipt of [{ ...reply.receipt, state: 'outcome_unknown' }, { ...reply.receipt, state: 'rejected' },
    { ...reply.receipt, result: { status: 202, body: { ok: true } } }, { ...reply.receipt, result: { status: 200, body: { credential: 'fixture' } } }])
    assert.equal(validConnectorSdkQueueOutput('sdkQueuedCancel', { ...reply, receipt }), false);
});
class FakeWorker extends EventEmitter {
  sent: Array<{ id: number; kind: string; body: string }> = [];
  postMessage(message: { id: number; kind: string; body: string }) { this.sent.push(message); }
  terminate() { queueMicrotask(() => this.emit('exit', 0)); return Promise.resolve(0); }
}
for (const kind of ['sdkQueuedCancel', 'sdkQueuedEdit', 'sdkQueueReceiptRead'] as const) for (const mismatch of ['receipt', 'session', 'target']) test(`${kind}: valid-looking wrong ${mismatch} retires original owner without retry`, async () => {
  const worker = new FakeWorker(), root = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-queue-reply-'));
  const owner = new AsyncConnectorOwner({ file: join(root, 'store.sqlite') }, silent, () => worker as unknown as Worker);
  worker.emit('message', { kind: 'ready' });
  try {
    const scope = { runtime: 'ghcp' as const, key: 'ghcp:session', target: { messageId: 'message' }, mutationKey: 'cancel', authorization: 'Bearer fixture' };
    const pending = kind === 'sdkQueuedEdit' ? owner.command(kind, { ...scope, version: '1:1', text: 'Updated' })
      : kind === 'sdkQueuedCancel' ? owner.command(kind, { ...scope, version: '1:1' }) : owner.command(kind, scope);
    const rejected = assert.rejects(pending, /unavailable/); await tick();
    const sent = worker.sent[0]!;
    const value = { key: mismatch === 'session' ? 'ghcp:other' : scope.key, targetId: mismatch === 'target' ? 'other' : 'message',
      receipt: { id: 'receipt', key: mismatch === 'receipt' ? 'wrong' : 'cancel', state: 'outcome_unknown', createdAt: 0, updatedAt: 0 },
      ...(kind !== 'sdkQueueReceiptRead' ? { changed: false } : {}) };
    assert.equal(validConnectorSdkQueueOutput(kind, value), true);
    worker.emit('message', { id: sent.id, kind: sent.kind, ok: true, body: JSON.stringify(value) });
    await rejected; await owner.closeForShutdown(); assert.equal(worker.sent.length, 1);
  } finally { await owner.closeForShutdown(); rmSync(root, { recursive: true, force: true }); }
});
test('SDK edit preserves long text protocol budget without enlarging every command', () => {
  const base = { runtime: 'ghcp', key: 'ghcp:session', target: { messageId: 'message' }, mutationKey: 'edit', version: '1:1', authorization: 'Bearer fixture' };
  assert.equal(validConnectorSdkQueueInput('sdkQueuedEdit', { ...base, text: 'x'.repeat(MAX_MESSAGE_CHARS) }), true);
  for (const text of ['', ' ', 'x'.repeat(MAX_MESSAGE_CHARS + 1), null])
    assert.equal(validConnectorSdkQueueInput('sdkQueuedEdit', { ...base, text }), false);
  assert.equal(connectorOwnerCommandBytes('sdkQueuedEdit'), MAX_TEXT_MESSAGE_BODY_BYTES + APPLICATION_TRANSACTION_COMMAND_OVERHEAD);
  assert.equal(connectorOwnerCommandBytes('sdkQueuedCancel'), 16_384 + APPLICATION_TRANSACTION_COMMAND_OVERHEAD);
});
test('SDK metadata protocol rejects arbitrary authority, unsafe cursor, leaked bodies and non-monotonic pages', () => {
  const input = { runtime: 'ghcp', key: 'ghcp:session', authorization: 'Bearer fixture', after: 0 };
  assert.equal(validConnectorSdkQueueReadInput('sdkQueuePage', input), true);
  for (const bad of [{ ...input, manage: true }, { ...input, actorId: 'other' }, { ...input, after: -1 }, { ...input, after: Number.MAX_SAFE_INTEGER + 1 }, { ...input, key: 'claude-code:session' }])
    assert.equal(validConnectorSdkQueueReadInput('sdkQueuePage', bad), false);
  const item = { id: 'message', state: 'queued', createdAt: 0, version: '1:1' };
  const reply = { key: input.key, page: { items: [item], nextCursor: null } };
  assert.equal(validConnectorSdkQueueReadOutput('sdkQueuePage', reply), true);
  for (const page of [{ items: [{ ...item, text: 'private' }], nextCursor: null }, { items: [item, item], nextCursor: null },
    { items: [item], nextCursor: '1' }, { items: [{ ...item, version: '9007199254740992:1' }], nextCursor: null }])
    assert.equal(validConnectorSdkQueueReadOutput('sdkQueuePage', { ...reply, page }), false);
  assert.equal(validConnectorSdkQueueReadOutput('sdkQueueCommandPage', reply), false);
});
for (const kind of ['sdkQueuePage', 'sdkQueueCommandPage'] as const) for (const mismatch of ['session', 'cursor'])
  test(`${kind}: wrong ${mismatch} retires original owner without substituting metadata`, async () => {
    const worker = new FakeWorker(), root = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-page-reply-'));
    const owner = new AsyncConnectorOwner({ file: join(root, 'store.sqlite') }, silent, () => worker as unknown as Worker);
    worker.emit('message', { kind: 'ready' });
    try {
      const input = { runtime: 'ghcp' as const, key: 'ghcp:session', authorization: 'Bearer fixture', after: 1 };
      const pending = owner.command(kind, input), rejected = assert.rejects(pending, /unavailable/); await tick();
      const sent = worker.sent[0]!;
      const value = { key: mismatch === 'session' ? 'ghcp:other' : input.key, page: { items: [{ state: 'queued', createdAt: 0,
        version: mismatch === 'cursor' ? '1:1' : '2:1', ...(kind === 'sdkQueuePage' ? { id: 'message' } : { commandKey: null }) }], nextCursor: null } };
      assert.equal(validConnectorSdkQueueReadOutput(kind, value), true);
      worker.emit('message', { id: sent.id, kind: sent.kind, ok: true, body: JSON.stringify(value) });
      await rejected; await owner.closeForShutdown(); assert.equal(worker.sent.length, 1);
    } finally { await owner.closeForShutdown(); rmSync(root, { recursive: true, force: true }); }
  });
