import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OriginalJsonAuthCommandStore } from './original-json-command-store.js';
import { createDeckSession } from './passkeys.js';
import { keyIdentityHash } from './security.js';
import { writePrivateAuthStore, AuthPersistenceError } from './private-store.js';

const lifetime = 30 * 24 * 60 * 60 * 1000;

for (const initialKey of ['synthetic-old-key', undefined]) {
  test(`JSON administrator binding rejects ${initialKey ? 'rotation' : 'open-to-protected'} after owner recreation`, context => {
    const root = mkdtempSync(join(tmpdir(), 'aod-session-binding-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const passkeys = join(root, 'passkeys.json'), sessions = join(root, 'sessions.json');
    const token = createDeckSession();
    const store = new OriginalJsonAuthCommandStore(passkeys, sessions, initialKey === undefined ? undefined : keyIdentityHash(initialKey));
    store.addAdministratorSession(token);
    assert.equal(store.sessionAuthorized(token), true);
    assert.equal(store.isAccessKeySession(token), true);
    store.close();
    const next = new OriginalJsonAuthCommandStore(passkeys, sessions, keyIdentityHash('synthetic-new-key'));
    context.after(() => next.close());
    assert.equal(next.sessionAuthorized(token), false);
    assert.equal(next.isAccessKeySession(token), false);
  });
}

test('JSON administrator sessions persist exact expiry and reject direct replay at the deadline', context => {
  const root = mkdtempSync(join(tmpdir(), 'aod-session-expiry-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const sessions = join(root, 'sessions.json'), passkeys = join(root, 'passkeys.json');
  let now = 1_000_000;
  const key = keyIdentityHash('synthetic-key'), token = createDeckSession();
  const store = new OriginalJsonAuthCommandStore(passkeys, sessions, key, { now: () => now });
  store.addAdministratorSession(token);
  const record = JSON.parse(readFileSync(sessions, 'utf8')).sessions[0];
  assert.deepEqual(record, { token, administrator: true, keyIdentityHash: key, issuedAt: now, expiresAt: now + lifetime });
  store.close();
  const next = new OriginalJsonAuthCommandStore(passkeys, sessions, key, { now: () => now });
  context.after(() => next.close());
  now += lifetime - 1;
  assert.equal(next.sessionAuthorized(token), true);
  now++;
  assert.equal(next.sessionAuthorized(token), false);
  assert.equal(next.isAccessKeySession(token), false);
});

test('live key changes and clock rollback invalidate JSON administrator sessions', context => {
  const root = mkdtempSync(join(tmpdir(), 'aod-session-current-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  let now = 1_000;
  let key: string | undefined = keyIdentityHash('synthetic-key');
  const store = new OriginalJsonAuthCommandStore(join(root, 'passkeys.json'), join(root, 'sessions.json'), key,
    { now: () => now }, () => key);
  context.after(() => store.close());
  const token = createDeckSession(); store.addAdministratorSession(token);
  now = 999; assert.equal(store.sessionAuthorized(token), false);
  now = 1_000; key = undefined; assert.equal(store.sessionAuthorized(token), false);
});

test('unbound legacy tokens and malformed or duplicate administrator records are never upgraded', context => {
  const root = mkdtempSync(join(tmpdir(), 'aod-session-legacy-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const token = createDeckSession(), sessions = join(root, 'sessions.json'), passkeys = join(root, 'passkeys.json');
  for (const entries of [[token], [{ token, administrator: true }],
    [{ token, administrator: true, issuedAt: 0, expiresAt: lifetime + 1 }],
    [{ token, administrator: true, issuedAt: 0, expiresAt: lifetime, keyIdentityHash: ['a'.repeat(24)] }],
    [{ token, administrator: true, issuedAt: 0, expiresAt: lifetime }, token]]) {
    writePrivateAuthStore(sessions, { sessions: entries });
    const store = new OriginalJsonAuthCommandStore(passkeys, sessions, undefined, { now: () => 1 });
    assert.equal(store.sessionAuthorized(token), false); assert.equal(store.isAccessKeySession(token), false);
    store.close();
  }
});

test('JSON session writer keeps revision refusal, deletion and explicit clearing', context => {
  const root = mkdtempSync(join(tmpdir(), 'aod-session-writer-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const sessions = join(root, 'sessions.json'), passkeys = join(root, 'passkeys.json');
  const store = new OriginalJsonAuthCommandStore(passkeys, sessions);
  context.after(() => store.close());
  const first = createDeckSession(), second = createDeckSession();
  store.addAdministratorSession(first); store.addAdministratorSession(second);
  assert.equal(store.deleteSession(first), true); assert.equal(store.sessionAuthorized(second), true);
  assert.equal(store.clearSessions(() => false), false); assert.equal(store.sessionAuthorized(second), true);
  assert.equal(store.clearSessions(() => true), true); assert.equal(store.sessionAuthorized(second), false);
  writePrivateAuthStore(sessions, { sessions: [] });
  assert.throws(() => store.addAdministratorSession(createDeckSession()), AuthPersistenceError);
});
