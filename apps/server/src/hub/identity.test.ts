import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HubStore } from './hub-store.js';
import { AuthPersistenceError } from '../auth/private-store.js';
import type { DatabaseSync } from 'node:sqlite';
import { observedSavepoint } from '../storage/observed-savepoint.js';
import { connectionRecoverySnapshot } from '../storage/connection-recovery.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';

test('recovery scope is stable per Hub/account/role and is not a login credential', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-recovery-scope-'));
  const file = join(dir, 'hub.sqlite');
  let store = new HubStore(file, 'test');
  const other = new HubStore(join(dir, 'other.sqlite'), 'test');
  const actor = { userId: 'default', admin: true };
  try {
    const scope = store.identities.recoveryScope(actor);
    assert.match(scope, /^[a-f0-9]{64}$/);
    assert.notEqual(scope, other.identities.recoveryScope(actor));
    assert.notEqual(scope, store.identities.recoveryScope({ ...actor, admin: false }));
    assert.notEqual(scope, store.identities.recoveryScope({ ...actor, userId: 'other' }));
    assert.equal(store.identities.keyPrincipal(scope), undefined);
    store.close(); store = new HubStore(file, 'test');
    assert.equal(store.identities.recoveryScope(actor), scope);
  } finally { store.close(); other.close(); }
});

test('member keys and derived sessions persist hashed and revoke together', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'agentopsdeck-identity-')), 'hub.sqlite');
  let store = new HubStore(file, 'test');
  const user = store.createUser('Member');
  const key = store.identities.issueKey(user.id);
  const session = store.identities.createSession(key.token)!;
  const request = new Request('http://test/', { headers: { cookie: `agentopsdeck_session=${session}` } });
  try {
    assert.deepEqual(store.identities.requestPrincipal(request, () => true), { userId: user.id, admin: false });
    assert.equal(store.identities.keyPrincipal('hub_key_bad'), undefined);
    for (const path of [file, `${file}-wal`]) if (existsSync(path)) {
      const bytes = readFileSync(path);
      assert.equal(bytes.includes(Buffer.from(key.token)), false);
      assert.equal(bytes.includes(Buffer.from(session)), false);
    }
    store.close(); store = new HubStore(file, 'test');
    assert.equal(store.identities.requestPrincipal(request, () => false)?.userId, user.id);
    assert.equal(store.identities.revokeKey('another-user', key.id), false);
    assert.equal(store.identities.revokeKey(user.id, key.id), true);
    assert.equal(store.identities.requestPrincipal(request, () => true), undefined);
    assert.equal(store.identities.requestPrincipal(new Request('http://test/', { headers: { authorization: `Bearer ${key.token}` } }), () => true), undefined);
  } finally { store.close(); }
});

test('explicit member credentials override legacy access cookies and never become administrator', () => {
  const store = new HubStore(join(mkdtempSync(join(tmpdir(), 'agentopsdeck-identity-precedence-')), 'hub.sqlite'), 'test');
  try {
    const member = store.createUser('Member');
    const key = store.identities.issueKey(member.id);
    const request = new Request('http://test/', { headers: { authorization: `Bearer ${key.token}`, cookie: 'agentopsdeck_access=admin-key' } });
    assert.deepEqual(store.identities.requestPrincipal(request, () => true), { userId: member.id, admin: false });
    const defaultKey = store.identities.issueKey('default');
    assert.equal(store.identities.keyPrincipal(defaultKey.token)?.admin, false);
    assert.doesNotThrow(() => store.identities.requestPrincipal(new Request('http://test/', { headers: { cookie: 'agentopsdeck_session=%broken; agentopsdeck_access=%broken' } }), () => false));
  } finally { store.close(); }
});

test('legacy principal requires literal synchronous true and never starts an async guard', async () => {
  const store = new HubStore(join(mkdtempSync(join(tmpdir(), 'agentopsdeck-identity-sync-')), 'hub.sqlite'), 'test');
  const request = new Request('http://test/');
  let calls = 0;
  try {
    const asyncGuard = async () => { calls++; return true; };
    assert.equal(store.identities.requestPrincipal(request, asyncGuard as unknown as () => boolean), undefined);
    assert.equal(calls, 0);
    for (const result of [false, 1, 'true', {}])
      assert.equal(store.identities.requestPrincipal(request, () => result as boolean), undefined);
    assert.deepEqual(store.identities.requestPrincipal(request, () => true), { userId: 'default', admin: true });
  } finally { store.close(); }
});

test('legacy Promise escape rolls back its original write and fences late work until explicit stopped reopen', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'agentopsdeck-identity-escape-')), 'hub.sqlite');
  let store = new HubStore(file, 'test');
  const request = new Request('http://test/');
  let resume!: () => void;
  let lateError: unknown;
  const held = new Promise<void>(resolve => { resume = resolve; });
  let created!: string;
  const check = () => {
    created = store.createUser('Must roll back').id;
    return held.then(() => {
      try { store.createUser('Must not write late'); } catch (error) { lateError = error; }
      return true;
    }) as unknown as boolean;
  };
  try {
    assert.throws(() => store.identities.requestPrincipal(request, check),
      error => error instanceof AuthPersistenceError && error.message === 'auth_persistence_failed');
    assert.throws(() => store.createUser('Must remain fenced'));
    assert.ok(performanceDiagnostics.snapshot().events.some(event =>
      event.operation === 'hub-identity-check' && event.category === 'failed'
      && event.step === 2 && event.unknown === 1));
    resume(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(lateError);
    assert.throws(() => store.identities.requestPrincipal(request, () => true));
    store.close(); store = new HubStore(file, 'test');
    assert.equal(store.listUsers().some(user => user.id === created), false);
    assert.equal(store.listUsers().some(user => user.label === 'Must not write late'), false);
    assert.deepEqual(store.identities.requestPrincipal(request, () => true), { userId: 'default', admin: true });
  } finally { resume(); store.close(); }
});

test('caught nested legacy Promise cannot settle the enclosing transaction or release its authority', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'agentopsdeck-identity-parent-')), 'hub.sqlite');
  let store = new HubStore(file, 'test');
  const db = (store as unknown as { db: DatabaseSync }).db;
  let created!: string;
  const denied = Promise.reject(Error('private-legacy-rejection'));
  try {
    assert.throws(() => observedSavepoint(db, 'hub-identity-change', () => {
      created = store.createUser('Parent must roll back').id;
      try { store.identities.requestPrincipal(new Request('http://test/'), () => denied as unknown as boolean); }
      catch { /* Caller cannot override original owner retirement. */ }
      return true;
    }), /must be synchronous/);
    assert.equal(db.isTransaction, false);
    assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
    await new Promise<void>(resolve => setImmediate(resolve));
    store.close(); store = new HubStore(file, 'test');
    assert.equal(store.listUsers().some(user => user.id === created), false);
    assert.equal(store.identities.requestPrincipal(new Request('http://test/'), () => false), undefined);
  } finally { store.close(); }
});
