import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { HubStore } from './hub-store.js';
import { QuickChatStore } from './quick-chat-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubMemberQuickChatState } from './async-member-quick-chat-state.js';
import { HubMemberRequestError } from './async-member-request.js';
import { executeHubMemberCommand, hubMemberResultBytes, type HubMemberKind } from './member-owner-domain.js';
import { validHubQuickChatStateReply } from './member-quick-chat-state-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const snapshot = () => ({ principal: { userId: 'owner', admin: false }, recoveryScope: 'a'.repeat(64) });
const request = (signal?: AbortSignal) => new Request('http://fixture.invalid/', {
  headers: { 'x-agentopsdeck-key': 'hub_key_' + 'x'.repeat(43) }, ...(signal ? { signal } : {}),
});
const port = (command: (kind: HubMemberKind, input: unknown) => unknown | Promise<unknown>) => ({
  command: async (kind: HubMemberKind, input: unknown) => command(kind, input),
}) as Pick<AsyncHubMemberOwner, 'command'>;
const rejectsStatus = (status: number) => (error: unknown) => error instanceof HubMemberRequestError && error.status === status;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function emptyList() {
  const command = { action: 'list' };
  return { action: 'list', digest: createHash('sha256').update(JSON.stringify(command)).digest('hex'),
    profiles: [], receipts: [], receipt: null, output: null };
}

test('maximum legal escaped list fits its reservation and crosses the real owner without SQL effects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chat-list-budget-')), file = join(root, 'hub.sqlite');
  const store = new HubStore(file, 'fixture'), db = (store as unknown as { db: DatabaseSync }).db;
  let owner: AsyncHubMemberOwner | undefined;
  try {
    const user = store.createUser('Owner'), key = store.identities.issueKey(user.id);
    const token = store.identities.createSession(key.token)!, evidence = { sessionToken: token };
    const raw = new Request('http://fixture.invalid/', { headers: { cookie: 'agentopsdeck_session=' + token } });
    const principal = store.identities.requestPrincipal(raw, () => false)!;
    const proof = { evidence, expectedScope: store.identities.recoveryScope(principal)! };
    let now = 1000;
    const chat = new QuickChatStore(db, () => now, Buffer.alloc(32, 1), new PerformanceDiagnostics(() => {}));
    // Lone surrogate code units are legal legacy strings and JSON expands each
    // to six bytes. Chinese-only fixtures do not exercise the upper bound.
    const long = (length: number, suffix = '') => '\ud800'.repeat(length - suffix.length) + suffix;
    const capability = { ephemeralRequest: true, noPersistentThread: true, originalLookup: true,
      maxOutput: 2000, epoch: long(512) };
    for (let i = 0; i < 32; i++) {
      const suffix = String(i), id = long(512, suffix);
      chat.saveProfile(user.id, 0, { id, name: long(80), target: long(512), model: long(128), outputLimit: 2000 }, capability);
      const requestId = long(512, suffix);
      chat.admit(user.id, requestId, id, 1, 'fixture prompt', capability);
      chat.cancelAdmitted(user.id, requestId);
      now += 60_001;
    }
    const rows = () => ['quick_chat_profiles', 'quick_chat_receipts', 'quick_chat_results']
      .map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all());
    const before = rows(), command = { action: 'list' } as const;
    const value = executeHubMemberCommand(store, 'quickChatState', { ...proof, command });
    assert.equal(value?.profiles?.length, 32); assert.equal(value?.receipts?.length, 32);
    assert.ok(validHubQuickChatStateReply(command, value));
    assert.ok(Buffer.byteLength(JSON.stringify(value)) < hubMemberResultBytes('quickChatState'),
      'All legal legacy profiles and receipts must fit the typed reply reservation');
    assert.deepEqual(rows(), before);
    await store.close();
    owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture' }, new PerformanceDiagnostics(() => {}));
    assert.deepEqual(await owner.command('quickChatState', { ...proof, command }), value);
    await owner.close();
    const reopened = new HubStore(file, 'fixture');
    try {
      const opened = (reopened as unknown as { db: DatabaseSync }).db;
      assert.deepEqual(['quick_chat_profiles', 'quick_chat_receipts', 'quick_chat_results']
        .map(table => opened.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()), before);
    } finally { await reopened.close(); }
  } finally { await owner?.close().catch(() => {}); await store.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const late of ['resolve', 'reject'] as const) {
  test('query timeout retains its original lease until late ' + late + ' and never delivers or redispatches it', async () => {
    const wait = deferred<unknown>(), logs: string[] = []; let reads = 0;
    const query = new AsyncHubMemberQuickChatState(port(kind => {
      if (kind === 'memberSnapshot') return snapshot();
      assert.equal(kind, 'quickChatState'); reads++; return wait.promise;
    }), new PerformanceDiagnostics(row => logs.push(row)), 5, 15);
    const scope = await query.begin(request());
    await assert.rejects(scope.list(), rejectsStatus(503));
    assert.equal(reads, 1); assert.equal(query.pending, 1);
    assert.ok(logs.some(row => row.includes('"step":49') && row.includes('"timedOut":1')));
    if (late === 'resolve') wait.resolve(emptyList()); else wait.reject(Error('private rejected query body'));
    await tick(); assert.equal(query.pending, 0); assert.equal(reads, 1);
    assert.ok(!logs.join('').includes('private rejected query body'));
    assert.ok(!logs.join('').includes('x'.repeat(43)));
  });
}

test('abort retains original query lease and cannot dispatch a second query from the same disconnected scope', async () => {
  const wait = deferred<unknown>(), controller = new AbortController(), logs: string[] = []; let reads = 0;
  const query = new AsyncHubMemberQuickChatState(port(kind => {
    if (kind === 'memberSnapshot') return snapshot();
    assert.equal(kind, 'quickChatState'); reads++; return wait.promise;
  }), new PerformanceDiagnostics(row => logs.push(row)), 5, 5000);
  const scope = await query.begin(request(controller.signal)), result = scope.inspect('original');
  const rejected = assert.rejects(result, rejectsStatus(499));
  await tick(); controller.abort(); await rejected;
  assert.equal(query.pending, 1); assert.equal(reads, 1);
  await assert.rejects(scope.inspect('original'), rejectsStatus(499)); assert.equal(reads, 1);
  wait.resolve(null); await tick(); assert.equal(query.pending, 0);
  assert.ok(logs.some(row => row.includes('"step":49') && row.includes('"cancelled":1')));
});

test('256 abandoned query waits exhaust the shared query budget until actual owner settlement', async () => {
  const wait = deferred<unknown>(), dispatched = deferred<void>(); let reads = 0;
  const query = new AsyncHubMemberQuickChatState(port(kind => {
    if (kind === 'memberSnapshot') return snapshot();
    assert.equal(kind, 'quickChatState'); reads++;
    if (reads === 256) dispatched.resolve();
    return wait.promise;
  }), new PerformanceDiagnostics(() => {}), 5, 5000);
  const controllers = Array.from({ length: 256 }, () => new AbortController());
  const scopes = await Promise.all(controllers.map(controller => query.begin(request(controller.signal))));
  const rejected = scopes.map(scope => assert.rejects(scope.list(), rejectsStatus(499)));
  // Wait for original dispatch, not an event-loop phase. Under concurrent
  // full-suite load setImmediate may run after the read deadline, exercising
  // timeout (503) before the intended cancellation (499). This barrier keeps
  // the real timeout and all 256 reservations, without extending or disabling
  // deadlines or releasing a slot to make the test pass.
  await dispatched.promise; assert.equal(query.pending, 256); assert.equal(reads, 256);
  for (const controller of controllers) controller.abort(); await Promise.all(rejected);
  assert.equal(query.pending, 256);
  const next = await query.begin(request()); await assert.rejects(next.list(), rejectsStatus(503));
  assert.equal(reads, 256); assert.equal(query.pending, 256);
  wait.reject(Error('private abandoned query')); await tick(); assert.equal(query.pending, 0);
});

test('fresh delivery revocation keeps the durable reply private and never retries its original query', async () => {
  let snapshots = 0, reads = 0;
  const query = new AsyncHubMemberQuickChatState(port(kind => {
    if (kind === 'memberSnapshot') return ++snapshots === 3 ? null : snapshot();
    reads++; return emptyList();
  }), new PerformanceDiagnostics(() => {}));
  const scope = await query.begin(request()); await assert.rejects(scope.list(), rejectsStatus(401));
  await assert.rejects(scope.list(), rejectsStatus(401)); assert.equal(reads, 1); assert.equal(query.pending, 0);
});
