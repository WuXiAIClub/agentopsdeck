import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { executeHubMemberCommand, validHubMemberInput, validHubMemberOutput, HubMemberOwnerUnavailable } from './member-owner-domain.js';
import { prepareHubUserLabel } from './member-user-domain.js';
import { PerformanceDiagnostics, performanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const status = (n: number) => (e: unknown) => e instanceof HubMemberRequestError && e.status === n;
async function fixture(work: (f: ReturnType<typeof seed>) => unknown) {
  const root = mkdtempSync(join(tmpdir(), 'hub-user-r78-')), file = join(root, 'hub.sqlite');
  const store = new HubStore(file, 'user-fixture');
  try { await work(seed(store, file)); }
  finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}
function seed(store: HubStore, file: string) {
  const admin = store.createUser('Administrator'), member = store.createUser('Member');
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.prepare("INSERT INTO hub_roles VALUES (?, 'admin', 1)").run(admin.id);
  const key = store.identities.issueKey(admin.id), token = store.identities.createSession(key.token)!;
  const request = new Request('http://fixture.invalid', { headers: { cookie: 'agentopsdeck_session=' + token } });
  const proof = { evidence: { sessionToken: token }, expectedScope: store.identities.recoveryScope({ userId: admin.id, admin: true }) };
  return { store, file, db, admin, member, key, token, request, proof };
}

test('user commands preserve original labels, IDs, timestamps, default rows and missing-user shape', () => fixture(f => {
  const original = f.store.listUsers().map(row => ({ ...row }));
  const made = executeHubMemberCommand(f.store, 'userChange', { ...f.proof, change: { action: 'create', label: 'New member' } });
  assert.ok(made && 'user' in made); assert.match(made.user.id, /^user_[0-9a-f-]{36}$/);
  assert.equal(made.user.createdAt, made.user.updatedAt);
  const changed = executeHubMemberCommand(f.store, 'userChange', { ...f.proof, change: { action: 'update', userId: made.user.id, label: 'Renamed' } });
  assert.ok(changed && 'user' in changed); assert.equal(changed.user.createdAt, made.user.createdAt);
  assert.equal(changed.user.label, 'Renamed');
  for (const row of original) assert.deepEqual(f.store.getUser(row.id), row);
  assert.deepEqual(executeHubMemberCommand(f.store, 'userChange', { ...f.proof, change: { action: 'update', userId: 'missing', label: 'New' } }), { error: 'missing' });
  assert.equal(f.db.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
}));

test('prepared bounded labels retain exact legacy whitespace, truncation, Unicode and long-label behavior', () => fixture(f => {
  for (const label of ['  Existing\n label  ', 'x'.repeat(119) + ' z', 'x'.repeat(120) + ' z',
    'x'.repeat(118) + '😀 z', '\0label', '中文 '.repeat(100_000)]) {
    const original = f.store.createUser(label);
    const result = executeHubMemberCommand(f.store, 'userChange', { ...f.proof, change: { action: 'create', label: prepareHubUserLabel(label) } });
    assert.ok(result && 'user' in result); assert.equal(result.user.label, original.label);
  }
}));

test('administrator proof is rechecked inside original savepoint; stale scope and revoked key cannot mutate', () => fixture(f => {
  const before = f.store.listUsers();
  const change = { action: 'update' as const, userId: f.member.id, label: 'Forbidden' };
  assert.equal(executeHubMemberCommand(f.store, 'userChange', { ...f.proof, expectedScope: '0'.repeat(64), change }), null);
  f.db.prepare("UPDATE hub_roles SET role='member', version=2 WHERE user_id=?").run(f.admin.id);
  assert.equal(executeHubMemberCommand(f.store, 'userChange', { ...f.proof, change }), null);
  f.db.prepare("UPDATE hub_roles SET role='admin', version=3 WHERE user_id=?").run(f.admin.id);
  f.store.identities.revokeKey(f.admin.id, f.key.id);
  assert.equal(executeHubMemberCommand(f.store, 'userChange', { ...f.proof, change }), null);
  assert.deepEqual(f.store.listUsers(), before);
}));

for (const kind of ['create', 'update'] as const) test('user '+kind+' SQL fault rolls back original transaction and does not poison later commands', () => fixture(f => {
  const before = f.store.listUsers();
  f.db.exec(`CREATE TRIGGER reject_user BEFORE ${kind === 'create' ? 'INSERT' : 'UPDATE'} ON users BEGIN SELECT RAISE(ABORT, 'private_user_fault'); END`);
  const change = kind === 'create' ? { action: kind, label: 'Changed' } : { action: kind, userId: f.member.id, label: 'Changed' };
  assert.throws(() => executeHubMemberCommand(f.store, 'userChange', { ...f.proof, change }));
  assert.equal(f.db.isTransaction, false); assert.deepEqual(f.store.listUsers(), before);
  f.db.exec('DROP TRIGGER reject_user');
  assert.ok(executeHubMemberCommand(f.store, 'userChange', { ...f.proof, change }));
}));

test('nested user command never commits or rolls back an enclosing original transaction', () => fixture(f => {
  f.db.exec('BEGIN');
  const result = executeHubMemberCommand(f.store, 'userChange', { ...f.proof, change: { action: 'update', userId: f.member.id, label: 'Outer' } });
  assert.ok(result); assert.equal(f.db.isTransaction, true); assert.equal(f.store.getUser(f.member.id)!.label, 'Outer');
  f.db.exec('ROLLBACK'); assert.equal(f.store.getUser(f.member.id)!.label, 'Member');
}));

for (const executed of [false, true]) test('user RELEASE acknowledgment loss preserves actual commit without replay ('+executed+')', () => fixture(f => {
  const original = Object.assign(new Error('private_user_release_fault'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
  const native = f.db.exec.bind(f.db), observedStart = performanceDiagnostics.start;
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const change = { action: 'update' as const, userId: f.member.id, label: 'Private renamed user' };
  let releases = 0;
  f.db.exec = (sql: string) => {
    if (sql === 'RELEASE hub_identity_check') { releases++; if (executed) native(sql); throw original; }
    native(sql);
  };
  performanceDiagnostics.start = diagnostics.start.bind(diagnostics);
  try {
    assert.throws(() => executeHubMemberCommand(f.store, 'userChange', { ...f.proof, change }), error => error === original);
    assert.equal(releases, 1); assert.equal(f.db.isTransaction, false);
    assert.equal(f.store.getUser(f.member.id)!.label, executed ? change.label : 'Member');
    assert.ok(logs.some(line => { const row = JSON.parse(line); return row.operation === 'hub-identity-check'
      && row.step === 3 && row.unknown === 1 && row.sqlErrorCode === 10; }));
    for (const secret of [f.token, f.key.token, change.label, original.message]) assert.equal(logs.join('').includes(secret), false);
  } finally { f.db.exec = native; performanceDiagnostics.start = observedStart; }
  assert.ok(executeHubMemberCommand(f.store, 'userChange', { ...f.proof, change: { ...change, label: 'Later request' } }));
  assert.equal(f.store.getUser(f.member.id)!.label, 'Later request');
}));

test('fixed user protocol refuses executable input, client authority and corrupt output without exposing plaintext', () => fixture(f => {
  const good = { ...f.proof, change: { action: 'create', label: 'New' } };
  for (const input of [{ ...good, authorized: true }, { ...good, change: { ...good.change, admin: true } },
    { ...good, change: { action: 'create', label: ' ' } }, { ...good, change: { action: 'update', label: 'New' } }])
    assert.equal(validHubMemberInput('userChange', input), false);
  for (const output of [{ user: { id: 'id', label: 'New', createdAt: 1, updatedAt: 1, token: 'secret' } },
    { error: 'missing', user: {} }, { user: { id: 'id', label: 'New', createdAt: NaN, updatedAt: 1 } }])
    assert.equal(validHubMemberOutput('userChange', output), false);
}));

test('real async full owner writes once, drains, closes and reopens original data and existing session', () => fixture(async f => {
  await f.store.close(); const logs: string[] = [];
  const owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'user-fixture' }, new PerformanceDiagnostics(line => logs.push(line)));
  let id = '';
  try {
    await owner.open(); const requests = new AsyncHubMemberRequests(owner, quiet);
    const caller = await requests.begin(f.request);
    const made = await caller.createUser('  Private new label  '); id = made.id;
    assert.equal((await caller.updateUser(id, 'Renamed')).label, 'Renamed');
    await assert.rejects(caller.updateUser('missing', 'Valid'), status(404));
    assert.equal((await caller.updateUser(id, 'Renamed')).label, 'Renamed');
    let getters = 0;
    await assert.rejects(owner.command('userChange', { ...f.proof, get change() { getters++; return { action: 'create' as const, label: 'Bad' }; } }));
    assert.equal(getters, 0); assert.equal(owner.snapshot().unavailable, false);
  } finally { await owner.close(); }
  const reopened = new HubStore(f.file, 'user-fixture');
  try {
    assert.equal(reopened.getUser(id)!.label, 'Renamed');
    assert.equal(reopened.listUsers().length, 4);
    assert.deepEqual(reopened.identities.requestPrincipal(f.request, () => false), { userId: f.admin.id, admin: true });
  } finally { await reopened.close(); }
  assert.ok(logs.some(line => line.includes('hub-member-sqlite-command')));
  assert.ok(!logs.join('').includes('Private new label')); assert.ok(!logs.join('').includes(f.token));
}));

const snapshot = () => ({ principal: { userId: 'admin', admin: true }, recoveryScope: 'a'.repeat(64) });
const port = (command: (kind: string, input: any) => unknown | Promise<unknown>) => ({ command: async (kind: string, input: any) => command(kind, input) }) as Pick<AsyncHubMemberOwner, 'command'>;
const req = (signal?: AbortSignal) => new Request('http://fixture.invalid', { ...(signal ? { signal } : {}) });

test('user caller captures primitive labels before await and refuses coercion without invoking user code', async () => {
  let commands = 0, calls = 0; const values: unknown[] = [];
  const service = new AsyncHubMemberRequests(port((kind, input) => {
    if (kind === 'memberSnapshot') return snapshot(); commands++; values.push(input.change);
    return { user: { id: 'new', label: input.change.label, createdAt: 1, updatedAt: 1 } };
  }), quiet);
  const caller = await service.begin(req());
  await assert.rejects(caller.createUser({ toString() { calls++; return 'New'; } } as any), status(400));
  await caller.createUser('  New\n label  ');
  assert.equal(calls, 0); assert.equal(commands, 1); assert.deepEqual(values, [{ action: 'create', label: 'New label' }]);
});

test('committed user change followed by revoked final delivery is not replayed or undone', async () => {
  let current: ReturnType<typeof snapshot> | null = snapshot(), writes = 0;
  const service = new AsyncHubMemberRequests(port(kind => {
    if (kind === 'memberSnapshot') return current; writes++; current = null;
    return { user: { id: 'committed', label: 'New', createdAt: 1, updatedAt: 1 } };
  }), quiet);
  const caller = await service.begin(req());
  await assert.rejects(caller.createUser('New'), status(401));
  await assert.rejects(caller.createUser('New'), status(401)); assert.equal(writes, 1);
});

test('pending user mutation retains original admission through warning and request disconnect until real settlement', async () => {
  let settle!: (v: unknown) => void, writes = 0;
  const pending = new Promise(resolve => { settle = resolve; }), controller = new AbortController(), logs: string[] = [];
  const service = new AsyncHubMemberRequests(port(kind => {
    if (kind === 'memberSnapshot') return snapshot(); writes++; return pending;
  }), new PerformanceDiagnostics(line => logs.push(line)), 5, 10);
  const caller = await service.begin(req(controller.signal)); const result = caller.createUser('New');
  await tick(); controller.abort(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(writes, 1); assert.equal(service.pendingReads, 1);
  assert.ok(logs.some(line => line.includes('"phase":"pending"') && line.includes('"step":32')));
  settle({ user: { id: 'committed', label: 'New', createdAt: 1, updatedAt: 1 } });
  await assert.rejects(result, status(499)); await tick(); assert.equal(service.pendingReads, 0); assert.equal(writes, 1);
});

class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = [];
  stops = 0;
  postMessage(message: { id: number; kind: string; body: string }) { this.messages.push(message); }
  terminate() { this.stops++; return Promise.resolve(1); }
}
test('lost user ACK is unknown; no replacement owner, retry or early close before physical worker exit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-user-ack-r78-')), fake = new FakeWorker();
  const owner = new AsyncHubMemberOwner({ file: join(root, 'hub.sqlite') }, quiet, () => fake as unknown as Worker, 5);
  fake.emit('message', { kind: 'ready' });
  try {
    const pending = owner.command('userChange', { evidence: {}, expectedScope: 'a'.repeat(64), change: { action: 'create', label: 'New' } });
    const rejection = assert.rejects(pending, HubMemberOwnerUnavailable); await tick();
    fake.emit('message', { id: fake.messages[0]!.id, kind: 'userChange', ok: true, body: '{corrupt-ack' });
    await rejection; assert.equal(fake.messages.length, 1); assert.equal(fake.stops, 0);
    await assert.rejects(owner.command('userChange', { evidence: {}, expectedScope: 'a'.repeat(64), change: { action: 'create', label: 'New' } }));
    let closed = false; const closing = owner.close().then(() => { closed = true; }, () => { closed = true; });
    await tick(); assert.equal(closed, false); assert.equal(fake.messages.length, 1);
    fake.emit('exit', 1); await closing; assert.equal(owner.snapshot().ownerExitConfirmed, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
