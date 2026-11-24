import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { CommandReceipt } from '@agentopsdeck/shared';
import { api, setRecoveryScope } from '../api.js';
import { CommandJournal, CommandRejectedError, CreationOutcomeUnknownError, commandIdentity } from './command-recovery.js';
import { createSessionWithRecovery, isActiveSessionCreation } from './session-creation.js';

const scope = 'a'.repeat(64);
const target = { connectionId: 'node', agentId: 'codex', ownerUserId: 'owner-a' };
const sessionKey = `node:${btoa('codex:original').replace(/=+$/, '')}`;
function fixture(t: TestContext) {
  const oldWindow = globalThis.window;
  const original = { create: api.createSession, query: api.creationCommand, verify: api.verifyCreationConnection };
  const saved = new Map<string, string>();
  const storage = { getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { saved.set(key, value); } };
  Object.assign(globalThis, { window: { sessionStorage: storage, dispatchEvent() {}, localStorage: {
    getItem: () => null, setItem() {}, removeItem() {},
  } } });
  setRecoveryScope(scope);
  const journal = new CommandJournal(storage);
  let posts = 0;
  api.createSession = async () => { posts++; assert.fail('must not create a replacement'); };
  api.verifyCreationConnection = async () => { assert.fail('shared creation must not use owner connection lookup'); };
  t.after(() => {
    api.createSession = original.create; api.creationCommand = original.query; api.verifyCreationConnection = original.verify;
    setRecoveryScope(undefined); Object.assign(globalThis, { window: oldWindow });
  });
  const receipt = (key: string, state: CommandReceipt['state'] = 'accepted'): CommandReceipt => ({
    id: 'receipt', key, state, createdAt: 1, updatedAt: 2,
    ...(state === 'accepted' ? { result: { status: 201, body: { key: sessionKey } } } : {}),
  });
  return { journal, receipt, posts: () => posts };
}

for (const status of [403, 404, 409, 503]) test(`receipt HTTP ${status} preserves unknown and never creates again`, async t => {
  const f = fixture(t), row = f.journal.beginCreation(scope, target, 'create.original');
  api.creationCommand = async () => { throw Object.assign(new Error('lookup failed'), { status }); };
  await assert.rejects(createSessionWithRecovery(target, 'New'), CreationOutcomeUnknownError);
  assert.deepEqual(f.journal.list(scope, undefined, 'creation'), [row]); assert.equal(f.posts(), 0);
  assert.equal(isActiveSessionCreation(row), false);
});

for (const savedState of ['outcome_unknown', 'accepted'] as const) test(`saved ${savedState} resumes original accepted session without POST`, async t => {
  const f = fixture(t), row = f.journal.beginCreation(scope, target, 'create.original');
  if (savedState === 'accepted') f.journal.settle(row, savedState);
  api.creationCommand = async (actual, key, account) => {
    assert.deepEqual(actual, target); assert.equal(key, row.key); assert.equal(account, scope);
    assert.equal(isActiveSessionCreation(row), true);
    return { command: f.receipt(key) };
  };
  const entered: string[] = [];
  assert.deepEqual(await createSessionWithRecovery(target, 'Ignored', created => { entered.push(created.key); }), { key: sessionKey });
  assert.deepEqual(entered, [sessionKey]); assert.deepEqual(f.journal.list(scope, undefined, 'creation'), []); assert.equal(f.posts(), 0);
});

test('unknown receipt remains unknown without POST', async t => {
  const f = fixture(t), row = f.journal.beginCreation(scope, target, 'create.original');
  api.creationCommand = async () => ({ command: f.receipt(row.key, 'outcome_unknown') });
  await assert.rejects(createSessionWithRecovery(target, 'New'), CreationOutcomeUnknownError);
  assert.deepEqual(f.journal.list(scope, undefined, 'creation'), [row]);
});

test('exact terminal rejection stops recovery; only the next explicit request creates anew', async t => {
  const f = fixture(t), row = f.journal.beginCreation(scope, target, 'create.original');
  api.creationCommand = async () => ({ command: { ...f.receipt(row.key, 'rejected'), result: { status: 403, body: {} } } });
  let posts = 0;
  api.createSession = async (_agent, _label, _connection, key, account, owner) => {
    posts++; assert.notEqual(key, row.key); assert.equal(account, scope); assert.equal(owner, target.ownerUserId);
    return { key: sessionKey, command: f.receipt(key!) };
  };
  const entered: string[] = [];
  await assert.rejects(createSessionWithRecovery(target, 'New'), CommandRejectedError);
  assert.equal(posts, 0);
  await createSessionWithRecovery(target, 'New', created => { entered.push(created.key); });
  assert.equal(posts, 1); assert.deepEqual(entered, [sessionKey]);
  assert.deepEqual(f.journal.list(scope, undefined, 'creation').map(row => row.state), ['rejected']);
});

test('accepted response with a mismatched receipt key cannot authorize another POST', async t => {
  const f = fixture(t), row = f.journal.beginCreation(scope, target, 'create.original');
  api.creationCommand = async () => ({ command: f.receipt('create.somebody-else') });
  await assert.rejects(createSessionWithRecovery(target, 'New'), CreationOutcomeUnknownError);
  assert.deepEqual(f.journal.list(scope, undefined, 'creation'), [row]); assert.equal(f.posts(), 0);
});

test('account switch while recovering never enters or mutates original record', async t => {
  const f = fixture(t), row = f.journal.beginCreation(scope, target, 'create.original');
  api.creationCommand = async () => { setRecoveryScope('b'.repeat(64)); return { command: f.receipt(row.key) }; };
  await assert.rejects(createSessionWithRecovery(target, 'New', () => assert.fail('late account entry')), /Account changed/);
  assert.deepEqual(f.journal.list(scope, undefined, 'creation'), [row]); assert.equal(f.posts(), 0);
});

test('same connection/runtime/key across owners have independent journal identities', t => {
  const f = fixture(t), a = f.journal.beginCreation(scope, target, 'create.same');
  const b = f.journal.beginCreation(scope, { ...target, ownerUserId: 'owner-b' }, 'create.same');
  assert.notEqual(commandIdentity(a), commandIdentity(b));
  f.journal.settle(a, 'accepted');
  assert.equal(f.journal.list(scope, undefined, 'creation').find(row => row.creation?.ownerUserId === 'owner-b')?.state, 'outcome_unknown');
  f.journal.forget(a); assert.deepEqual(f.journal.list(scope, undefined, 'creation'), [b]);
});

test('switching away and back still invalidates an in-flight recovery', async t => {
  const f = fixture(t), row = f.journal.beginCreation(scope, target, 'create.original');
  api.creationCommand = async () => {
    setRecoveryScope('b'.repeat(64)); setRecoveryScope(scope);
    return { command: f.receipt(row.key) };
  };
  await assert.rejects(createSessionWithRecovery(target, 'New', () => assert.fail('stale entry')), /Account changed/);
  assert.deepEqual(f.journal.list(scope, undefined, 'creation'), [row]); assert.equal(f.posts(), 0);
});

test('concurrent accepted recovery cannot slip through into a fresh POST', async t => {
  const f = fixture(t), row = f.journal.beginCreation(scope, target, 'create.original');
  f.journal.settle(row, 'accepted');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  api.creationCommand = async () => { await gate; return { command: f.receipt(row.key) }; };
  const pending = createSessionWithRecovery(target, 'New');
  try { await assert.rejects(createSessionWithRecovery(target, 'Duplicate'), CreationOutcomeUnknownError); }
  finally { release(); }
  assert.deepEqual(await pending, { key: sessionKey }); assert.equal(f.posts(), 0);
});

test('failed entry retains accepted receipt and never creates replacement', async t => {
  const f = fixture(t), row = f.journal.beginCreation(scope, target, 'create.original');
  api.creationCommand = async () => ({ command: f.receipt(row.key) });
  await assert.rejects(createSessionWithRecovery(target, 'New', () => { throw Error('entry failed'); }), /entry failed/);
  assert.equal(f.journal.list(scope, undefined, 'creation')[0]?.state, 'accepted'); assert.equal(f.posts(), 0);
});
