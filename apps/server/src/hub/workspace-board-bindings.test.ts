import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HubStore } from './hub-store.js';
import { WorkspaceBoards } from './workspace-boards.js';
import { WorkspaceBoardCapabilities } from './workspace-board-capabilities.js';
import { HubBoardBindings, parseBoardAgentEndpoint } from './workspace-board-bindings.js';

const endpoint = 'https://hub.example/api/workspace-agent/v1/board';
function fixture(secret: string | undefined = 'synthetic-binding-vault-key') {
  const root = mkdtempSync(join(tmpdir(), 'hub-board-binding-')), file = join(root, 'hub.sqlite');
  let hub = new HubStore(file, secret);
  const owner = hub.createUser('Alice').id, other = hub.createUser('Bob').id;
  const task = randomUUID();
  hub.boards.save(owner, 'default', { title: 'Private', revision: 0, mutationId: randomUUID(), tasks: [{ id: task, title: 'Task', detail: '', status: 'todo' }] });
  hub.upsertConnection({ id: 'dev', ownerUserId: owner, label: 'Dev', connectorUrl: 'https://connector.example' });
  hub.pinConnectionNode('dev', owner, hub.connectionAuthority('dev', owner)!, `node_${randomUUID()}`);
  const authority = hub.connectionAuthority('dev', owner)!;
  const input = { requestId: randomUUID(), sessionId: 'dev:session', grant: { taskIds: [task], fields: ['status' as const], expiresAt: Date.now() + 60_000 } };
  return { get hub() { return hub; }, owner, other, input, authority, file, task,
    prepare: () => hub.boardBindings.prepare(owner, 'default', input, 'dev', authority, endpoint),
    restart: () => { hub.close(); hub = new HubStore(file, secret); },
    close: () => { hub.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('binding issuance is idempotent, encrypted, owner isolated and durable', () => {
  const f = fixture();
  try {
    const first = f.prepare()!; assert.equal(first.state, 'prepared');
    const credential = f.hub.boardBindings.credential(f.owner, 'default', f.input.requestId)!;
    assert.ok(f.hub.boardCapabilities.authorized(credential.token));
    assert.deepEqual(f.prepare(), first);
    assert.equal(f.hub.boardCapabilities.list(f.owner, 'default').length, 1);
    assert.equal(f.hub.boardBindings.credential(f.other, 'default', first.requestId), undefined);
    assert.equal(f.hub.boardBindings.get(f.other, 'default', first.requestId), undefined);
    assert.deepEqual(f.hub.boardBindings.list(f.other, 'default'), []);
    assert.equal(f.hub.boardBindings.prepare(f.owner, 'default', { ...f.input, sessionId: 'other' }, 'dev', f.authority, endpoint), undefined);
    assert.equal(f.hub.boardBindings.revoke(f.other, 'default', first.requestId), undefined);
    f.hub.boardBindings.outcome(f.owner, 'default', first.requestId, 'installed');
    assert.ok(!JSON.stringify(f.hub.boardBindings.list(f.owner, 'default')).includes(credential.token));
    f.restart();
    assert.equal(f.hub.boardBindings.get(f.owner, 'default', first.requestId)?.state, 'installed');
    assert.deepEqual(f.hub.boardBindings.credential(f.owner, 'default', first.requestId), credential);
    assert.ok(!readFileSync(f.file).includes(Buffer.from(credential.token)));
    assert.equal(f.hub.boardBindings.revoke(f.owner, 'default', first.requestId)?.state, 'revoked');
    assert.equal(f.hub.boardCapabilities.authorized(credential.token), false);
    assert.equal(f.hub.boardBindings.outcome(f.owner, 'default', first.requestId, 'installed')?.state, 'revoked');
    f.restart(); assert.equal(f.prepare(), undefined);
    assert.equal(f.hub.boardBindings.credential(f.owner, 'default', first.requestId), undefined);
  } finally { f.close(); }
});

test('late attempt uncertainty preserves confirmed installation without suppressing fresh explicit observations', () => {
  const f = fixture();
  try {
    const binding = f.prepare()!;
    const outcome = (state: 'installed' | 'uncertain', preserveInstalled = false) =>
      f.hub.boardBindings.outcome(f.owner, 'default', binding.requestId, state, preserveInstalled)?.state;
    assert.equal(outcome('installed'), 'installed');
    assert.equal(outcome('uncertain', true), 'installed');
    assert.equal(outcome('uncertain'), 'uncertain');
    assert.equal(outcome('installed', true), 'installed');
    f.hub.boardBindings.revoke(f.owner, 'default', binding.requestId);
    assert.equal(outcome('installed', true), 'revoked');
    assert.equal(outcome('uncertain'), 'revoked');
  } finally { f.close(); }
});

test('unreceived or in-flight binding can be durably cancelled without minting or replaying a grant', () => {
  const f = fixture();
  try {
    assert.deepEqual(f.hub.boardBindings.cancelIntent(f.owner, 'default', f.input.requestId), { cancelled: true, requestId: f.input.requestId, binding: null });
    f.restart(); assert.equal(f.prepare(), undefined);
    assert.equal(f.hub.boardCapabilities.list(f.owner, 'default').length, 0);
    f.input.requestId = randomUUID();
    const binding = f.prepare()!, credential = f.hub.boardBindings.credential(f.owner, 'default', f.input.requestId)!;
    // Another user cannot cancel this owner's delayed request or revoke its grant.
    f.hub.boardBindings.cancelIntent(f.other, 'default', binding.requestId);
    assert.ok(f.hub.boardCapabilities.authorized(credential.token));
    assert.equal(f.hub.boardBindings.cancelIntent(f.owner, 'default', binding.requestId)?.binding?.state, 'revoked');
    assert.equal(f.hub.boardCapabilities.authorized(credential.token), false);
    assert.equal(f.hub.boardBindings.credential(f.owner, 'default', binding.requestId), undefined);
    f.restart(); assert.equal(f.prepare(), undefined);
    assert.equal(f.hub.boardBindings.outcome(f.owner, 'default', binding.requestId, 'installed')?.state, 'revoked');
    assert.equal(f.hub.boardBindings.cancelIntent(f.owner, 'default', binding.requestId)?.binding?.state, 'revoked');
  } finally { f.close(); }
});

test('binding listing uses indexed per-capability metadata, not repeated whole-board scans', () => {
  const f = fixture();
  try {
    f.prepare();
    const original = f.hub.boardCapabilities.list;
    f.hub.boardCapabilities.list = () => { throw Error('Whole board scan'); };
    try { assert.equal(f.hub.boardBindings.list(f.owner, 'default').length, 1); }
    finally { f.hub.boardCapabilities.list = original; }
    const binding = f.hub.boardBindings.list(f.owner, 'default')[0]!;
    assert.equal(f.hub.boardCapabilities.metadata(f.other, 'default', binding.capabilityId), undefined);
  } finally { f.close(); }
});

test('connection disable/re-enable permanently denies bound tools, including saved mutation replay', () => {
  const f = fixture();
  try {
    const first = f.prepare()!, credential = f.hub.boardBindings.credential(f.owner, 'default', first.requestId)!;
    const mutation = { revision: 1, mutationId: randomUUID(), tasks: [{ id: f.task, status: 'done' as const }] };
    assert.equal(f.hub.boardCapabilities.update(credential.token, mutation).status, 'saved');
    const connection = f.hub.getConnection('dev', f.owner)!;
    f.hub.upsertConnection({ ...connection, status: 'disabled' });
    assert.equal(f.hub.boardCapabilities.update(credential.token, mutation).status, 'denied');
    assert.equal(f.hub.boardBindings.get(f.owner, 'default', first.requestId)?.state, 'unavailable');
    f.hub.upsertConnection({ ...connection, status: 'enabled' });
    f.restart();
    assert.equal(f.hub.boardCapabilities.authorized(credential.token), false);
    assert.equal(f.prepare(), undefined);
  } finally { f.close(); }
});

test('manual capability revocation is reflected in binding metadata and cannot be retried', () => {
  const f = fixture();
  try {
    const first = f.prepare()!;
    f.hub.boardCapabilities.revoke(f.owner, 'default', first.capabilityId);
    assert.equal(f.hub.boardBindings.get(f.owner, 'default', first.requestId)?.state, 'revoked');
    assert.equal(f.prepare(), undefined);
  } finally { f.close(); }
});

test('automatic bindings require explicit vault key; manual capabilities remain compatible', () => {
  // HubStore has a development fallback for other legacy credentials; automatic
  // capability transfer must not silently rely on that fallback.
  const f = fixture('');
  try {
    assert.equal(f.hub.boardBindings.enabled, false); assert.equal(f.prepare(), undefined);
    const manual = f.hub.boardCapabilities.issue(f.owner, 'default', f.input.grant)!;
    assert.ok(f.hub.boardCapabilities.authorized(manual.token));
  } finally { f.close(); }
});

test('vault or intent failures roll back issuance, audit and encrypted vault together', () => {
  const db = new DatabaseSync(':memory:'), boards = new WorkspaceBoards(db), caps = new WorkspaceBoardCapabilities(db, boards);
  const task = randomUUID();
  boards.save('alice', 'default', { title: 'Board', revision: 0, mutationId: randomUUID(), tasks: [{ id: task, title: 'Task', detail: '', status: 'todo' }] });
  db.exec('CREATE TABLE test_vault (id TEXT PRIMARY KEY, token TEXT NOT NULL)');
  let fail = true;
  const bindings = new HubBoardBindings(db, caps, { read: () => undefined, remove: () => {}, write: (id, token) => {
    db.prepare('INSERT INTO test_vault VALUES (?, ?)').run(id, token); if (fail) throw new Error('synthetic failure');
  } }, true, () => 1);
  const input = { requestId: randomUUID(), sessionId: 'session', grant: { taskIds: [task], fields: ['status' as const], expiresAt: Date.now() + 60_000 } };
  try {
    assert.throws(() => bindings.prepare('alice', 'default', input, 'dev', 1, endpoint));
    assert.equal(caps.list('alice', 'default').length, 0); assert.equal(caps.events('alice', 'default').length, 0);
    assert.equal(db.prepare('SELECT * FROM test_vault').all().length, 0);
    fail = false;
    db.exec("CREATE TRIGGER fail_binding BEFORE INSERT ON hub_board_bindings BEGIN SELECT RAISE(ABORT, 'synthetic intent failure'); END");
    assert.throws(() => bindings.prepare('alice', 'default', input, 'dev', 1, endpoint));
    assert.equal(caps.list('alice', 'default').length, 0); assert.equal(db.prepare('SELECT * FROM test_vault').all().length, 0);
  } finally { db.close(); }
});

test('fixed board endpoint rejects insecure remote URLs, paths and query credentials', () => {
  assert.equal(parseBoardAgentEndpoint(undefined), undefined); assert.equal(parseBoardAgentEndpoint(endpoint), endpoint);
  for (const url of ['http://hub.example/api/workspace-agent/v1/board', endpoint + '?key=secret', 'https://hub.example/other', 'https://user:pass@hub.example/api/workspace-agent/v1/board']) assert.throws(() => parseBoardAgentEndpoint(url));
});
