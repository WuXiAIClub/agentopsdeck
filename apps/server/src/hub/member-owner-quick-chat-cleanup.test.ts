import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubMemberQuickChatCleanup } from './async-member-quick-chat-cleanup.js';
import { HubMemberRequestError } from './async-member-request.js';
import { executeHubMemberCommand, validHubMemberInput, type HubMemberKind } from './member-owner-domain.js';
import { executeHubQuickChatCleanupCommand, validHubQuickChatCleanupCommand, validHubQuickChatCleanupReply,
  type HubQuickChatCleanupCommand } from './member-quick-chat-cleanup-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const capability = { ephemeralRequest: true, noPersistentThread: true, originalLookup: true, maxOutput: 2000, epoch: 'fixture' };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const silent = () => new PerformanceDiagnostics(() => {});
const tables = ['quick_chat_profiles', 'quick_chat_receipts', 'quick_chat_results'];
function seed(store: HubStore) {
  const db = (store as unknown as { db: DatabaseSync }).db, user = store.createUser('Owner');
  const key = store.identities.issueKey(user.id), token = store.identities.createSession(key.token)!;
  const request = new Request('http://fixture.invalid/', { headers: { cookie: 'agentopsdeck_session=' + token } });
  const principal = store.identities.requestPrincipal(request, () => false)!;
  const proof = { evidence: { sessionToken: token }, expectedScope: store.identities.recoveryScope(principal)! };
  store.quickChat.saveProfile(user.id, 0, { id: 'profile', name: 'Profile', target: 'fixed', model: 'fixed', outputLimit: 2000 }, capability);
  store.quickChat.admit(user.id, 'original', 'profile', 1, 'PRIVATE_PROMPT', capability);
  const call = (command: HubQuickChatCleanupCommand) => executeHubMemberCommand(store, 'quickChatCleanup', { ...proof, command });
  const rows = () => tables.map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all());
  const claim = () => store.quickChat.claim(user.id, 'original', 'PRIVATE_PROMPT', capability, () => true);
  return { store, db, user, token, request, principal, proof, call, rows, claim };
}
async function fixture(work: (f: ReturnType<typeof seed>) => unknown) {
  const root = mkdtempSync(join(tmpdir(), 'chat-cleanup-domain-')), store = new HubStore(join(root, 'hub.sqlite'), 'fixture');
  try { await work(seed(store)); } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}
test('cancel only changes admitted receipt to failed and keeps the permanent replay barrier', () => fixture(f => {
  const command = { action: 'cancel', requestId: 'original' } as const, reply = f.call(command)!;
  assert.equal(reply.status, 200); assert.ok(validHubQuickChatCleanupReply(command, reply));
  const receipt = f.store.quickChat.receipt(f.user.id, 'original');
  assert.equal(receipt?.state, 'failed'); assert.equal(f.claim().claimed, false);
  const before = f.rows(); assert.equal(f.call(command)?.status, 200); assert.deepEqual(f.rows(), before);
  assert.equal(f.db.isTransaction, false);
}));
for (const action of ['cancel', 'clear'] as const) {
  test(action + ' cannot settle UNKNOWN, remove its receipt or free its profile slot', () => fixture(f => {
    f.claim(); const before = f.rows(), reply = f.call({ action, requestId: 'original' });
    assert.equal(reply?.status, 409); assert.equal(reply?.code, action === 'cancel' ? 'already-dispatched' : 'not-terminal');
    assert.deepEqual(f.rows(), before); assert.equal(f.claim().claimed, false);
    assert.throws(() => f.store.quickChat.admit(f.user.id, 'second', 'profile', 1, 'PRIVATE_PROMPT', capability), /inflight-capacity/);
  }));
  test(action + ' missing request returns a correlated conflict, not invented success', () => fixture(f => {
    const before = f.rows(), command = { action, requestId: 'missing' }, reply = f.call(command);
    assert.equal(reply?.status, 409); assert.equal(reply?.code, 'missing');
    assert.ok(validHubQuickChatCleanupReply(command, reply)); assert.deepEqual(f.rows(), before);
  }));
  test(action + ' rejects nested transactions without touching the enclosing transaction', () => fixture(f => {
    if (action === 'clear') { f.claim(); f.store.quickChat.complete(f.user.id, 'original', 'PRIVATE_OUTPUT'); }
    const before = f.rows(); f.db.exec('BEGIN');
    try { assert.throws(() => f.call({ action, requestId: 'original' }), /root|nested|transaction/i);
      assert.equal(f.db.isTransaction, true); assert.deepEqual(f.rows(), before);
    } finally { f.db.exec('ROLLBACK'); }
  }));
  test(action + ' precommit revocation is latched even if fresh proof recovers after rollback', () => fixture(f => {
    if (action === 'clear') { f.claim(); f.store.quickChat.complete(f.user.id, 'original', 'PRIVATE_OUTPUT'); }
    const before = f.rows(); let checks = 0;
    const reply = executeHubQuickChatCleanupCommand(f.store, f.principal,
      () => ++checks === 3 ? undefined : f.principal, { action, requestId: 'original' }, silent());
    assert.equal(reply, null); assert.equal(checks, 3); assert.equal(f.db.isTransaction, false); assert.deepEqual(f.rows(), before);
  }));
}
test('clear removes only encrypted terminal output and retains the original completed receipt', () => fixture(f => {
  f.claim(); f.store.quickChat.complete(f.user.id, 'original', 'PRIVATE_OUTPUT');
  assert.ok(!JSON.stringify(f.rows()).includes('PRIVATE_OUTPUT'));
  const command = { action: 'clear', requestId: 'original' } as const;
  assert.equal(f.call(command)?.status, 200); assert.equal(f.store.quickChat.peekResult(f.user.id, 'original'), undefined);
  const receipt = f.store.quickChat.receipt(f.user.id, 'original');
  assert.equal(receipt?.state, 'completed'); assert.equal(receipt.resultRef, null); assert.equal(receipt.resultExpiresAt, null);
  assert.equal(f.claim().claimed, false); const before = f.rows();
  assert.equal(f.call(command)?.status, 200); assert.deepEqual(f.rows(), before);
}));
for (const denied of ['credential', 'scope', 'other-account'] as const) {
  test('cleanup denies ' + denied + ' without revealing or changing the original receipt', () => fixture(f => {
    const before = f.rows(); let proof = f.proof;
    if (denied === 'credential') f.store.identities.revokeSession(f.token);
    if (denied === 'scope') proof = { ...proof, expectedScope: '0'.repeat(64) };
    if (denied === 'other-account') {
      const user = f.store.createUser('Other'), key = f.store.identities.issueKey(user.id), token = f.store.identities.createSession(key.token)!;
      proof = { ...proof, evidence: { sessionToken: token } };
    }
    assert.equal(executeHubMemberCommand(f.store, 'quickChatCleanup', { ...proof, command: { action: 'cancel', requestId: 'original' } }), null);
    assert.deepEqual(f.rows(), before);
  }));
}
test('closed command domain rejects SQL, callbacks, claim, authorization flags and retargeted replies', () => fixture(f => {
  const command = { action: 'cancel', requestId: 'original' } as const;
  for (const value of [{ ...command, sql: 'DELETE FROM quick_chat_receipts' }, { ...command, authorized: true },
    { ...command, callback: () => true }, { ...command, action: 'claim' }, { ...command, requestId: ' leading' }]) {
    assert.equal(validHubQuickChatCleanupCommand(value), false);
    assert.equal(validHubMemberInput('quickChatCleanup', { ...f.proof, command: value }), false);
  }
  const reply = f.call(command);
  assert.equal(validHubQuickChatCleanupReply({ ...command, requestId: 'another' }, reply), false);
  assert.equal(validHubQuickChatCleanupReply({ ...command, action: 'clear' }, reply), false);
}));
test('cleanup logs bounded phase identifiers without tokens, prompts, request IDs or raw errors', () => fixture(f => {
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(row => { logs.push(row); throw Error('private sink'); });
  const reply = executeHubQuickChatCleanupCommand(f.store, f.principal, () => f.principal,
    { action: 'cancel', requestId: 'original' }, diagnostics);
  assert.equal(reply?.status, 200);
  assert.ok(logs.map(row => JSON.parse(row)).some(row => row.operation === 'hub-quick-chat' && row.step === 10 && row.settled === 1));
  assert.ok(diagnostics.snapshot().totals.sinkFailures > 0);
  for (const secret of [f.token, f.user.id, 'PRIVATE_PROMPT', 'original', 'private sink']) assert.ok(!logs.join('').includes(secret));
}));

const snapshot = () => ({ principal: { userId: 'owner', admin: false }, recoveryScope: 'a'.repeat(64) });
const request = (signal?: AbortSignal) => new Request('http://fixture.invalid/', {
  headers: { 'x-agentopsdeck-key': 'hub_key_' + 'x'.repeat(43) }, ...(signal ? { signal } : {}),
});
const port = (command: (kind: HubMemberKind, input: unknown) => unknown | Promise<unknown>) => ({
  command: async (kind: HubMemberKind, input: unknown) => command(kind, input),
}) as Pick<AsyncHubMemberOwner, 'command'>;
const status = (code: number) => (error: unknown) => error instanceof HubMemberRequestError && error.status === code;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
function reply(command: HubQuickChatCleanupCommand) {
  return { action: command.action, digest: createHash('sha256').update(JSON.stringify(command)).digest('hex'), status: 200, code: null };
}
for (const ending of ['resolve', 'reject', 'abort', 'revoke'] as const) {
  test('original write stays pending past read deadline and warning until actual ' + ending, async () => {
    const wait = deferred<unknown>(), controller = new AbortController(), logs: string[] = [];
    let writes = 0, snapshots = 0, command: HubQuickChatCleanupCommand | undefined;
    const cleanup = new AsyncHubMemberQuickChatCleanup(port((kind, input) => {
      if (kind === 'memberSnapshot') return ++snapshots === 3 && ending === 'revoke' ? null : snapshot();
      assert.equal(kind, 'quickChatCleanup'); writes++; command = (input as { command: HubQuickChatCleanupCommand }).command;
      return wait.promise;
    }), new PerformanceDiagnostics(row => logs.push(row)), 1, 5);
    const scope = await cleanup.begin(request(controller.signal)); let settled = false;
    const work = scope.cancel('original'); void work.then(() => { settled = true; }, () => { settled = true; });
    const rejection = ending === 'resolve' ? undefined : assert.rejects(work, status(ending === 'reject' ? 503 : ending === 'abort' ? 499 : 401));
    await tick(); await new Promise<void>(resolve => setTimeout(resolve, 20));
    assert.equal(settled, false); assert.equal(writes, 1); assert.equal(cleanup.pending, 1);
    assert.ok(logs.some(row => row.includes('"step":50') && row.includes('"pending":1')));
    if (ending === 'abort') { controller.abort(); await tick(); assert.equal(settled, false); assert.equal(cleanup.pending, 1); }
    if (ending === 'reject') wait.reject(Error('PRIVATE_SQL_FAILURE')); else wait.resolve(reply(command!));
    if (rejection) await rejection; else assert.equal((await work).status, 200);
    assert.equal(cleanup.pending, 0); assert.equal(writes, 1);
    if (ending === 'abort' || ending === 'revoke') { await assert.rejects(scope.cancel('original'), status(ending === 'abort' ? 499 : 401)); assert.equal(writes, 1); }
    for (const secret of ['PRIVATE_SQL_FAILURE', 'original', 'x'.repeat(43)]) assert.ok(!logs.join('').includes(secret));
  });
}
test('real complete owner durably cancels/clears while UNKNOWN survives worker reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chat-cleanup-worker-')), file = join(root, 'hub.sqlite'), store = new HubStore(file, 'fixture');
  let owner: AsyncHubMemberOwner | undefined;
  try {
    const f = seed(store);
    store.quickChat.saveProfile(f.user.id, 0, { id: 'other', name: 'Other', target: 'fixed', model: 'fixed', outputLimit: 2000 }, capability);
    store.quickChat.admit(f.user.id, 'unknown', 'other', 1, 'PRIVATE_PROMPT', capability);
    store.quickChat.claim(f.user.id, 'unknown', 'PRIVATE_PROMPT', capability, () => true);
    await store.close(); owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture' }, silent());
    let cleanup = new AsyncHubMemberQuickChatCleanup(owner, silent()), scope = await cleanup.begin(f.request);
    await scope.cancel('original'); await scope.clear('original'); await assert.rejects(scope.cancel('unknown'), status(409));
    await owner.close(); owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture' }, silent());
    cleanup = new AsyncHubMemberQuickChatCleanup(owner, silent()); scope = await cleanup.begin(f.request);
    await scope.cancel('original'); await assert.rejects(scope.clear('unknown'), status(409)); await owner.close();
    const reopened = new HubStore(file, 'fixture');
    try { assert.equal(reopened.quickChat.receipt(f.user.id, 'original')?.state, 'failed');
      assert.equal(reopened.quickChat.receipt(f.user.id, 'unknown')?.state, 'unknown');
      assert.equal(reopened.quickChat.claim(f.user.id, 'unknown', 'PRIVATE_PROMPT', capability, () => true).claimed, false);
    } finally { await reopened.close(); }
  } finally { await owner?.close().catch(() => {}); await store.close(); rmSync(root, { recursive: true, force: true }); }
});
class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = []; stops = 0;
  postMessage(message: { id: number; kind: string; body: string }) { this.messages.push(message); }
  terminate() { this.stops++; return Promise.resolve(1); }
}
for (const corrupt of ['digest', 'action'] as const) {
  test('mis-correlated cleanup ' + corrupt + ' preserves the real exit fence without redispatch', () => fixture(async f => {
    const root = mkdtempSync(join(tmpdir(), 'chat-cleanup-ack-')), file = join(root, 'hub.sqlite'), worker = new FakeWorker();
    const launch = () => worker as unknown as Worker, owner = new AsyncHubMemberOwner({ file }, silent(), launch);
    try {
      const command = { action: 'cancel', requestId: 'original' } as const;
      const work = owner.command('quickChatCleanup', { ...f.proof, command }); void work.catch(() => {});
      worker.emit('message', { kind: 'ready' }); await tick(); const message = worker.messages[0]!;
      const value = reply(command), altered = corrupt === 'digest' ? { ...value, digest: '0'.repeat(64) } : { ...value, action: 'clear' };
      worker.emit('message', { id: message.id, kind: message.kind, ok: true, body: JSON.stringify(altered) }); await assert.rejects(work);
      assert.equal(worker.messages.length, 1); assert.equal(worker.stops, 0);
      assert.throws(() => new AsyncHubMemberOwner({ file }, silent(), launch));
      const closing = owner.close(); void closing.catch(() => {}); await tick(); assert.equal(worker.stops, 1);
      assert.throws(() => new AsyncHubMemberOwner({ file }, silent(), launch)); worker.emit('exit', 1); await assert.rejects(closing);
    } finally { worker.emit('exit', 1); rmSync(root, { recursive: true, force: true }); }
  }));
}
