import assert from 'node:assert/strict';
import test from 'node:test';
import { DeckStore } from './deck-store.js';
import { parseSessionDirectoryQuery, projectSessionDirectory, sessionDirectoryPage, sessionDirectoryParams } from './session-directory.js';

test('resource directory filters before bounded sorted pagination, without full projection or private fields', () => {
  const store = new DeckStore();
  for (let n = 204; n >= 0; n--) store.upsertSession({ sessionKey: `codex:${String(n).padStart(3, '0')}`, agentId: 'codex',
    title: 'private title', recent: 'private text', model: 'private model', status: 'running' });
  store.upsertSession({ sessionKey: 'agent:main:dashboard:other', agentId: 'main', title: 'private title', status: 'idle' });
  store.getSessionsState = () => { throw new Error('No full catalog'); };
  store.getSession = () => { throw new Error('No heuristic execution reads'); };
  const first = store.getSessionDirectory({ runtime: 'codex', limit: 100 });
  assert.equal(first.sessions.length, 100);
  assert.deepEqual(first.sessions[0], { sessionKey: 'codex:000', runtime: 'codex' });
  assert.equal(first.nextCursor, 'codex:099');
  assert.equal(first.sourceCursor, store.latestEventId());
  const second = store.getSessionDirectory({ runtime: 'codex', limit: 100, after: first.nextCursor! });
  const third = store.getSessionDirectory({ runtime: 'codex', limit: 100, after: second.nextCursor! });
  assert.equal(second.sessions.length, 100); assert.equal(third.sessions.length, 5); assert.equal(third.nextCursor, null);
  assert.equal(JSON.stringify(first).includes('private'), false);
  assert.equal(store.getSessionDirectory({ runtime: 'openclaw' }).sessions.length, 1);
  assert.equal(store.getSessionDirectory({ sessionKey: 'codex:missing' }).sessions.length, 0);
  assert.deepEqual(store.getSessionDirectory({ sessionKey: 'codex:005' }).sessions, [{ sessionKey: 'codex:005', runtime: 'codex' }]);
  assert.equal(store.getSessionDirectory({ sessionKey: 'codex:005', after: 'codex:005' }).sessions.length, 0);
});

test('directory query rejects duplicate, unsupported, control and oversized filters', () => {
  for (const query of ['runtime=other', 'runtime=codex&runtime=openclaw', 'limit=1&limit=2', 'limit=0', 'limit=101',
    'limit=01', 'limit=1e1', 'limit=', 'agentId=main', 'ownerUserId=other', 'after=', 'sessionKey=', 'after=%00',
    `after=${'x'.repeat(2049)}`, `sessionKey=${encodeURIComponent('汉'.repeat(683))}`, 'sessionKey=codex:test&runtime=openclaw']) {
    assert.throws(() => parseSessionDirectoryQuery(new URLSearchParams(query)), /Invalid/);
  }
  assert.throws(() => sessionDirectoryParams({ agentId: 'main' } as any), /Invalid/);
  const query = { runtime: 'codex' as const, sessionKey: 'codex:空 格/#?&', limit: 1 };
  assert.deepEqual(parseSessionDirectoryQuery(sessionDirectoryParams(query)), query);
});

test('directory projection retains only bounded ordered keys; invalid upstream never becomes a catalog', () => {
  const query = { runtime: 'codex' as const, limit: 2 };
  const page = projectSessionDirectory(['codex:z', 'codex:b', 'codex:a', 'agent:main:dashboard:x', 'codex:\n', 'codex:', 'codex:\ud800'], query, 'cursor');
  assert.deepEqual(page.sessions.map(item => item.sessionKey), ['codex:a', 'codex:b']);
  assert.equal(page.nextCursor, 'codex:b');
  assert.deepEqual(sessionDirectoryPage({ ...page, private: 'secret', sessions: page.sessions.map(item => ({ ...item, private: 'secret' })) }, query), page);
  for (const patch of [{ sessions: [...page.sessions].reverse() }, { sessions: [page.sessions[0], page.sessions[0]] },
    { sessions: [...page.sessions, { sessionKey: 'codex:c', runtime: 'codex' }] },
    { sessions: [{ sessionKey: 'agent:main:dashboard:x', runtime: 'openclaw' }] },
    { sessions: [{ sessionKey: 'codex:a', runtime: 'openclaw' }] }, { nextCursor: 'secret' }, { nextCursor: undefined },
    { sourceCursor: 1 }, { sourceCursor: '\n' }, { sessions: [], nextCursor: 'codex:a' }]) {
    assert.throws(() => sessionDirectoryPage({ ...page, ...patch }, query), /Invalid/);
  }
  assert.throws(() => sessionDirectoryPage(page, { ...query, after: 'codex:a' }), /Invalid/);
  assert.throws(() => sessionDirectoryPage(page, { ...query, sessionKey: 'codex:b' }), /Invalid/);
});
test('new runtime directories preserve identity and reject disguised or empty native keys', () => {
  for (const runtime of ['claude-code', 'ghcp'] as const) {
    const sessionKey = `${runtime}:native`;
    const query = parseSessionDirectoryQuery(new URLSearchParams({ runtime }));
    const page = projectSessionDirectory([sessionKey, 'codex:native', 'agent:main:native', `${runtime}:`], query, '1');
    assert.deepEqual(page.sessions, [{ runtime, sessionKey }]);
    assert.throws(() => parseSessionDirectoryQuery(new URLSearchParams({ runtime: 'openclaw', sessionKey })));
    assert.throws(() => parseSessionDirectoryQuery(new URLSearchParams({ sessionKey: `${runtime}:` })));
  }
});
