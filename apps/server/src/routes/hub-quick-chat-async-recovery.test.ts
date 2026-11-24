import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HubStore } from '../hub/hub-store.js';
import type { QuickChatService } from '../hub/quick-chat-service.js';
import { AsyncHubMemberOwner } from '../hub/async-member-owner.js';
import { AsyncHubMemberQuickChatRecovery } from '../hub/async-member-quick-chat-recovery.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import type { HubMemberKind } from '../hub/member-owner-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubQuickChat } from './hub-quick-chat.js';

const base = '/api/hub/v1/quick-chat', tick = () => new Promise<void>(resolve => setImmediate(resolve));
const target = { id: 'fixture-target', recovery: 'local-receipt-only' };
function providerGuard() {
  let effects = 0;
  const forbidden = () => { effects++; throw Error('PRIVATE_SYNC_FALLBACK'); };
  const service = { catalog: async () => target, inspect: forbidden, saveProfile: forbidden, send: forbidden,
    store: new Proxy({}, { get: () => forbidden }) } as unknown as QuickChatService;
  return { service, effects: () => effects };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const snapshot = () => ({ principal: { userId: 'owner', admin: false }, recoveryScope: 'a'.repeat(64) });
const port = (command: (kind: HubMemberKind, input: unknown) => unknown | Promise<unknown>) => ({
  command: async (kind: HubMemberKind, input: unknown) => command(kind, input),
}) as Pick<AsyncHubMemberOwner, 'command'>;
const raw = (path: string, method = 'GET', signal?: AbortSignal) => new Request('http://fixture.invalid' + base + path, {
  method, headers: { 'x-agentopsdeck-key': 'hub_key_' + 'x'.repeat(43) }, ...(signal ? { signal } : {}),
});

test('real complete owner HTTP recovery preserves 2.3.7 browser shapes, permanent receipts and no provider POST', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chat-http-owner-')), file = join(root, 'hub.sqlite'), store = new HubStore(file, 'fixture');
  let owner: AsyncHubMemberOwner | undefined;
  try {
    const db = (store as unknown as { db: DatabaseSync }).db, user = store.createUser('Owner');
    const key = store.identities.issueKey(user.id), token = store.identities.createSession(key.token)!;
    const capability = { ephemeralRequest: true, noPersistentThread: true, originalLookup: true, maxOutput: 2000, epoch: 'fixed' };
    const p = randomUUID(), q = randomUUID(), complete = randomUUID(), unknown = randomUUID(), admitted = randomUUID();
    for (const id of [p, q]) store.quickChat.saveProfile(user.id, 0, { id, name: 'Profile', target: 'fixed', model: 'fixed', outputLimit: 2000 }, capability);
    store.quickChat.admit(user.id, complete, p, 1, 'PRIVATE_PROMPT', capability);
    store.quickChat.claim(user.id, complete, 'PRIVATE_PROMPT', capability, () => true); store.quickChat.complete(user.id, complete, 'PRIVATE_OUTPUT');
    store.quickChat.admit(user.id, unknown, q, 1, 'PRIVATE_PROMPT', capability);
    store.quickChat.claim(user.id, unknown, 'PRIVATE_PROMPT', capability, () => true);
    store.quickChat.admit(user.id, admitted, p, 1, 'PRIVATE_PROMPT', capability);
    const safe = (receipt: NonNullable<ReturnType<typeof store.quickChat.receipt>>) => {
      const { fingerprint: _, capabilityEpoch: __, resultRef: ___, ...value } = receipt; return value;
    };
    const expected = { target, profiles: store.quickChat.profiles(user.id), receipts: store.quickChat.receipts(user.id).map(safe) };
    const before = db.prepare('SELECT * FROM quick_chat_receipts WHERE id=?').get(unknown);
    await store.close(); owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture' }, new PerformanceDiagnostics(() => {}));
    const logs: string[] = [], diagnostics = new PerformanceDiagnostics(row => logs.push(row)), guard = providerGuard();
    const recovery = new AsyncHubMemberQuickChatRecovery(owner, diagnostics), app = new Hono();
    registerHubQuickChat(app, { service: guard.service, recovery, diagnostics, principal: () => ({ userId: user.id, admin: false }) });
    const request = (path = '', method = 'GET') => app.request(base + path, { method, headers: { cookie: 'agentopsdeck_session=' + token } });
    const list = await request(); assert.equal(list.status, 200); assert.equal(list.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await list.json(), expected);
    const output = await request('/requests/' + complete); assert.equal(output.status, 200);
    assert.deepEqual(await output.json(), { receipt: expected.receipts.find(row => row.requestId === complete), output: 'PRIVATE_OUTPUT' });
    for (let i = 0; i < 3; i++) {
      const read = await request('/requests/' + unknown); assert.equal(read.status, 200); assert.equal((await read.json()).receipt.state, 'unknown');
    }
    assert.equal((await request('/requests/' + unknown + '/cancel', 'POST')).status, 409);
    assert.equal((await request('/requests/' + unknown + '/result', 'DELETE')).status, 409);
    assert.equal((await request('/requests/' + randomUUID())).status, 409);
    const cleared = await request('/requests/' + complete + '/result', 'DELETE'); assert.equal(cleared.status, 200);
    const clearedValue = await cleared.json(); assert.equal(clearedValue.receipt.state, 'completed'); assert.equal(clearedValue.output, null);
    for (const privateField of ['fingerprint', 'capabilityEpoch', 'resultRef']) assert.equal(Object.hasOwn(clearedValue.receipt, privateField), false);
    const cancelled = await request('/requests/' + admitted + '/cancel', 'POST'); assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).receipt.state, 'failed'); assert.equal(recovery.pending, 0); assert.equal(guard.effects(), 0);
    await owner.close(); const reopened = new HubStore(file, 'fixture');
    try {
      const opened = (reopened as unknown as { db: DatabaseSync }).db;
      assert.deepEqual(opened.prepare('SELECT * FROM quick_chat_receipts WHERE id=?').get(unknown), before);
      assert.equal(reopened.quickChat.receipt(user.id, complete)?.state, 'completed'); assert.equal(reopened.quickChat.peekResult(user.id, complete), undefined);
      assert.equal(reopened.quickChat.receipt(user.id, admitted)?.state, 'failed');
      assert.equal(reopened.quickChat.claim(user.id, unknown, 'PRIVATE_PROMPT', capability, () => true).claimed, false);
    } finally { await reopened.close(); }
    for (const secret of [token, user.id, complete, unknown, admitted, 'PRIVATE_PROMPT', 'PRIVATE_OUTPUT']) assert.ok(!logs.join('').includes(secret));
  } finally { await owner?.close().catch(() => {}); await store.close(); rmSync(root, { recursive: true, force: true }); }
});
for (const code of [401, 499, 503] as const) {
  test('HTTP owner failure ' + code + ' has no synchronous SQL or provider fallback', async () => {
    const guard = providerGuard(), app = new Hono();
    registerHubQuickChat(app, { service: guard.service, principal: () => ({ userId: 'owner', admin: false }),
      recovery: { begin: async () => { throw new HubMemberRequestError(code); } } });
    for (const [path, method] of [['', 'GET'], ['/requests/' + randomUUID(), 'GET'],
      ['/requests/' + randomUUID() + '/result', 'DELETE'], ['/requests/' + randomUUID() + '/cancel', 'POST']]) {
      const response = await app.request(raw(path!, method!)); assert.equal(response.status, code);
      assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal((await response.json()).error, 'Quick chat unavailable');
    }
    assert.equal(guard.effects(), 0);
  });
}
test('HTTP abandoned query returns bounded error but retains original owner slot until settlement', async () => {
  const wait = deferred<unknown>(), guard = providerGuard(); let reads = 0;
  const recovery = new AsyncHubMemberQuickChatRecovery(port(kind => {
    if (kind === 'memberSnapshot') return snapshot(); assert.equal(kind, 'quickChatState'); reads++; return wait.promise;
  }), new PerformanceDiagnostics(() => {}), 1, 5);
  const app = new Hono(); registerHubQuickChat(app, { service: guard.service, recovery, principal: () => ({ userId: 'owner', admin: false }) });
  const response = await app.request(raw('/requests/' + randomUUID())); assert.equal(response.status, 503);
  assert.equal(reads, 1); assert.equal(recovery.pending, 1); assert.equal(guard.effects(), 0);
  wait.resolve(null); await tick(); assert.equal(recovery.pending, 0); assert.equal(reads, 1);
});
test('HTTP cancel awaits original ACK beyond read deadline; late disconnect never emits success or replay', async () => {
  const wait = deferred<unknown>(), guard = providerGuard(), controller = new AbortController();
  let writes = 0, reads = 0, command: unknown;
  const recovery = new AsyncHubMemberQuickChatRecovery(port((kind, input) => {
    if (kind === 'memberSnapshot') return snapshot();
    if (kind === 'quickChatCleanup') { writes++; command = (input as { command: unknown }).command; return wait.promise; }
    reads++; throw Error('inspection after disconnected write');
  }), new PerformanceDiagnostics(() => {}), 1, 5);
  const app = new Hono(); registerHubQuickChat(app, { service: guard.service, recovery, principal: () => ({ userId: 'owner', admin: false }) });
  let settled = false; const work = app.request(raw('/requests/' + randomUUID() + '/cancel', 'POST', controller.signal));
  void Promise.resolve(work).then(() => { settled = true; }); await tick(); await new Promise<void>(resolve => setTimeout(resolve, 20));
  assert.equal(settled, false); assert.equal(writes, 1); assert.equal(recovery.pending, 1);
  controller.abort(); await tick(); assert.equal(settled, false); assert.equal(recovery.pending, 1);
  wait.resolve({ action: 'cancel', digest: digest(command), status: 200, code: null });
  assert.equal((await work).status, 499); assert.equal(recovery.pending, 0); assert.equal(writes, 1); assert.equal(reads, 0); assert.equal(guard.effects(), 0);
});
test('HTTP final account switch cannot expose a stale durable result', async () => {
  let owner = 'owner'; const requestId = randomUUID(), guard = providerGuard();
  const recovery = new AsyncHubMemberQuickChatRecovery(port((kind, input) => {
    if (kind === 'memberSnapshot') return snapshot(); assert.equal(kind, 'quickChatState');
    owner = 'other'; const command = (input as { command: unknown }).command;
    return { action: 'inspect', digest: digest(command), profiles: null, receipts: null, receipt: {
      requestId, profile: { id: 'p', revision: 1, name: 'P', target: 'fixed', model: 'fixed', outputLimit: 2000 },
      capabilityEpoch: 'fixed', fingerprint: 'a'.repeat(64), state: 'completed', createdAt: 1, resultRef: 'result', resultExpiresAt: 2,
    }, output: 'PRIVATE_RESULT' };
  }), new PerformanceDiagnostics(() => {}));
  const app = new Hono(); registerHubQuickChat(app, { service: guard.service, recovery, principal: () => ({ userId: owner, admin: false }) });
  const response = await app.request(raw('/requests/' + requestId)); assert.equal(response.status, 403);
  assert.ok(!(await response.text()).includes('PRIVATE_RESULT')); assert.equal(guard.effects(), 0);
});
test('HTTP failure after lost cleanup ACK never runs inspection or another mutation', async () => {
  let writes = 0, reads = 0; const guard = providerGuard();
  const recovery = new AsyncHubMemberQuickChatRecovery(port(kind => {
    if (kind === 'memberSnapshot') return snapshot();
    if (kind === 'quickChatCleanup') { writes++; throw Error('PRIVATE_LOST_ACK'); }
    reads++; throw Error('inspection after unknown write');
  }), new PerformanceDiagnostics(() => {}));
  const app = new Hono(); registerHubQuickChat(app, { service: guard.service, recovery, principal: () => ({ userId: 'owner', admin: false }) });
  const response = await app.request(raw('/requests/' + randomUUID() + '/result', 'DELETE')); assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('PRIVATE_LOST_ACK')); assert.equal(writes, 1); assert.equal(reads, 0); assert.equal(guard.effects(), 0);
});
