import assert from 'node:assert/strict';
import test from 'node:test';
import { CommandJournal, CommandNotSubmittedError } from './command-recovery.js';
import { ownerSessionPath, queueMutationPath, sessionAddress, sessionMessagePayload, sharedSessionRoute, sharedGrantSessionsPath, type SessionTarget } from './session-address.js';

const target = { ownerUserId: 'owner-a', sessionId: 'local:Y29kZXg6MQ' };

test('shared grant resource paths encode every identity and reject URL normalization targets', () => {
  const path = sharedGrantSessionsPath({ ownerUserId: '用户/?#%', connectionId: 'node/空 格', id: 'grant/?#' });
  const url = new URL(path, 'http://example.test');
  assert.equal(url.pathname, path); assert.equal(url.search, ''); assert.equal(url.hash, '');
  for (const key of ['ownerUserId', 'connectionId', 'id']) for (const value of ['', '.', '..', '\n', '\ud800']) {
    assert.throws(() => sharedGrantSessionsPath({ ownerUserId: 'owner', connectionId: 'node', id: 'grant', [key]: value }));
  }
});

test('shared deep links intercept before owner catalog fallback and reject broken URLs', () => {
  const key = sessionAddress(target).key;
  assert.deepEqual(sharedSessionRoute(`#/session/${encodeURIComponent(key)}`), { kind: 'shared', target, key });
  for (const hash of ['', '#/tab/sessions', '#/session/local%3AY29kZXg6MQ']) assert.deepEqual(sharedSessionRoute(hash), { kind: 'owner' });
  for (const value of ['%', '%C0%AF', '%5B', encodeURIComponent(` ${key}`), encodeURIComponent('["shared-session-v2","a","b"]')]) {
    assert.deepEqual(sharedSessionRoute(`#/session/${value}`), { kind: 'invalid' });
  }
});

test('owner addresses preserve existing journal keys and routes', () => {
  assert.deepEqual(sessionAddress(target.sessionId), {
    key: target.sessionId, path: '/api/hub/v1/sessions/local%3AY29kZXg6MQ', shared: false,
  });
  assert.equal(ownerSessionPath(target.sessionId, true), '/api/sessions/local%3AY29kZXg6MQ');
});

test('shared directory is intercepted independently of owner catalogs', () => {
  assert.deepEqual(sharedSessionRoute('#/shared'), { kind: 'directory' });
  assert.deepEqual(sharedSessionRoute('#shared'), { kind: 'directory' });
});

test('shared addresses round-trip with owner-qualified distinct identities', () => {
  const a = sessionAddress(target), b = sessionAddress({ ...target, ownerUserId: 'owner-b' });
  assert.notEqual(a.key, b.key);
  assert.notEqual(a.path, b.path);
  assert.notEqual(a.key, target.sessionId);
  assert.deepEqual(sessionAddress(a.key), a);
  assert.equal(a.path, '/api/hub/v1/shared/owner-a/sessions/local%3AY29kZXg6MQ');
  const odd = sessionAddress({ ownerUserId: '用户/?#%', sessionId: 'node:session/../?a#b' });
  assert.deepEqual(sessionAddress(odd.key), odd);
  assert.equal(new URL(odd.path, 'http://example.test').pathname, odd.path);
  assert.equal(new URL(odd.path, 'http://example.test').search, '');
});

test('damaged or noncanonical reserved addresses never become owner requests', () => {
  const key = sessionAddress(target).key;
  for (const invalid of [key.slice(0, -1), ` ${key}`, key.replace(',', ', '), '["shared-session-v2","a","b"]',
    '["shared-session-v1","a","b",0]', '["shared-session-v1",null,"b"]', '[]', '[', '["shared-session-v1","a","\\u0062"]']) {
    assert.throws(() => sessionAddress(invalid), Error, invalid);
    assert.throws(() => ownerSessionPath(invalid));
  }
});

test('address bounds and segment validation prevent URL normalization and oversized journals', () => {
  for (const invalid of ['', '.', '..', '\nsecret', '\ud800', 'a'.repeat(4097)]) {
    assert.throws(() => sessionAddress(invalid));
    assert.throws(() => sessionAddress({ ...target, ownerUserId: invalid }));
    assert.throws(() => sessionAddress({ ...target, sessionId: invalid }));
  }
  for (const invalid of [null, [], {}, { ...target, actor: 'other' }, { sessionId: target.sessionId }]) {
    assert.throws(() => sessionAddress(invalid as unknown as SessionTarget));
  }
  assert.throws(() => sessionAddress({ ownerUserId: 'a'.repeat(2048), sessionId: 'b'.repeat(2048) }));
});

test('unsupported owner controls and runtime queue routes fail closed for shared addresses', () => {
  for (const shared of [target, sessionAddress(target).key]) {
    assert.throws(() => ownerSessionPath(shared), CommandNotSubmittedError);
    assert.throws(() => ownerSessionPath(shared, true), CommandNotSubmittedError);
    assert.equal(queueMutationPath(shared, 'original-key'), `${sessionAddress(target).path}/commands/original-key/queue`);
    for (const invalid of ['runtime/id', '.', '..', 'x'.repeat(201)]) assert.throws(() => queueMutationPath(shared, invalid));
  }
  assert.equal(queueMutationPath(target.sessionId, 'runtime/id'), `${sessionAddress(target.sessionId).path}/queue/runtime%2Fid`);
});

test('shared plain messages preserve exact content without unsupported empty media fields', () => {
  assert.deepEqual(sessionMessagePayload(target, ' body ', 'web-only', [], 'key'), {
    message: ' body ', deliveryMode: 'web-only', idempotencyKey: 'key',
  });
  assert.deepEqual(sessionMessagePayload(target.sessionId, '/stop', 'web-only', [], 'key', 'run'), {
    message: '/stop', deliveryMode: 'web-only', media: [], idempotencyKey: 'key', expectedRunId: 'run',
  });
  for (const message of ['', ' ', '/stop', ' /compact ', '/status', 'a'.repeat(100_001)]) {
    assert.throws(() => sessionMessagePayload(target, message, 'web-only', [], 'key'), CommandNotSubmittedError);
  }
  assert.throws(() => sessionMessagePayload(target, 'body', 'web-only', [], 'key', ''), CommandNotSubmittedError);
  assert.throws(() => sessionMessagePayload(target, 'body', 'web-only', [{ type: 'image', dataUrl: 'data:image/png;base64,AAAA', name: 'image' }], 'key'), CommandNotSubmittedError);
});

test('shared mirror preserves the selected mode and original scoped recovery target without enabling controls or uploads', () => {
  const key = sessionAddress(target).key;
  for (const address of [target, key]) {
    assert.deepEqual(sessionMessagePayload(address, ' original input ', 'mirror', [], 'original-key'), {
      message: ' original input ', deliveryMode: 'mirror', idempotencyKey: 'original-key',
    });
    for (const message of ['', ' ', '/status', '/compact', '/stop', 'a'.repeat(100_001)]) {
      assert.throws(() => sessionMessagePayload(address, message, 'mirror', [], 'original-key'), CommandNotSubmittedError);
    }
    assert.throws(() => sessionMessagePayload(address, 'input', 'mirror', [], 'original-key', 'run'), CommandNotSubmittedError);
    assert.throws(() => sessionMessagePayload(address, 'input', 'mirror', [{ type: 'image', dataUrl: 'data:image/png;base64,AAAA', name: 'image' }], 'original-key'), CommandNotSubmittedError);
    assert.throws(() => sessionMessagePayload(address, 'input', 'invalid' as any, [], 'original-key'), CommandNotSubmittedError);
  }
});

test('existing recovery journal isolates identical commands and queue targets across shared owners', () => {
  let raw: string | null = null;
  const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } };
  const journal = new CommandJournal(storage), scope = 'a'.repeat(64);
  const a = sessionAddress(target).key, b = sessionAddress({ ...target, ownerUserId: 'owner-b' }).key;
  for (const sessionKey of [a, b, target.sessionId]) {
    journal.begin(scope, sessionKey, 'same-key');
    journal.begin(scope, sessionKey, 'same-mutation', { messageId: 'same-key', action: 'cancel' });
  }
  const reopened = new CommandJournal(storage);
  assert.equal(reopened.list(scope, a, 'all').length, 2);
  assert.equal(reopened.list(scope, b).length, 1);
  assert.equal(reopened.list('b'.repeat(64), a, 'all').length, 0);
  for (const row of reopened.list(scope, a, 'all')) {
    assert.ok(!row.creation && !row.maintenance && !row.lifecycle);
    assert.equal(sessionAddress(row.sessionKey).path, sessionAddress(target).path);
  }
});
