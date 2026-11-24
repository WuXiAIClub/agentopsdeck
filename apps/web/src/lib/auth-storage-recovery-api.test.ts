import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { api, ApiResponseError, AuthRequiredError, recoveryEpoch, recoveryScope, setRecoveryScope } from '../api.js';
import { SessionRevocationJournal } from './session-revocation.js';

function fixture(t: TestContext) {
  const oldWindow = globalThis.window, oldFetch = globalThis.fetch;
  const saved = new Map([['agentopsdeck.workspace.synthetic', 'unsaved-layout-and-notebook-drafts']]);
  const savedSession = new Map<string, string>();
  const events: string[] = [], mutations: string[] = [];
  Object.assign(globalThis, { window: { setTimeout, clearTimeout,
    dispatchEvent(event: Event) { events.push(event.type); },
    location: { hostname: 'example.invalid', protocol: 'https:' },
    localStorage: { getItem(key: string) { return saved.get(key) ?? null; },
      setItem(key: string, value: string) { mutations.push(key); saved.set(key, value); },
      removeItem(key: string) { mutations.push(key); saved.delete(key); } },
    sessionStorage: { getItem(key: string) { return savedSession.get(key) ?? null; },
      setItem(key: string, value: string) { savedSession.set(key, value); },
      removeItem(key: string) { savedSession.delete(key); } },
  } });
  setRecoveryScope('f'.repeat(64)); mutations.length = 0;
  t.after(() => { setRecoveryScope(undefined); Object.assign(globalThis, { window: oldWindow, fetch: oldFetch }); });
  return { saved, events, mutations };
}

for (const failure of ['unavailable', 'malformed'] as const) test(`revocation ${failure} retains original reference; explicit result checks never replay DELETE`, async t => {
  fixture(t);
  const reference = { scope: 'f'.repeat(64), sessionKey: 'fixture-session', grantId: 'grant /1', version: 4, userId: 'member' };
  const journal = new SessionRevocationJournal(window.sessionStorage); journal.remember(reference);
  const calls: Array<{ path: string; method: string }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ path: String(url), method: init?.method ?? 'GET' });
    return failure === 'unavailable' ? new Response('{}', { status: 503 }) : Response.json({ ok: true });
  };
  await assert.rejects(api.revokeSessionCollaborator(reference.sessionKey,
    { id: reference.grantId, version: reference.version } as Parameters<typeof api.revokeSessionCollaborator>[1]));
  assert.equal(calls.length, 1);
  for (const status of [404, 409, 503]) {
    globalThis.fetch = async (url, init) => {
      calls.push({ path: String(url), method: init?.method ?? 'GET' }); return new Response('{}', { status });
    };
    await assert.rejects(api.sessionCollaboratorRevocation(reference.sessionKey, { id: reference.grantId, version: reference.version }));
    assert.deepEqual(journal.list(reference.scope, reference.sessionKey), [reference]);
    assert.ok(calls.at(-1)!.path.endsWith('/collaborators/grant%20%2F1/revocation?version=4'));
  }
  assert.deepEqual(calls.map(call => call.method), ['DELETE', 'GET', 'GET', 'GET']);
});

for (const status of [200, 401]) test(`late revocation query ${status} across account ABA cannot settle old authority`, async t => {
  const f = fixture(t), before = [...f.saved]; let finish!: (response: Response) => void;
  globalThis.fetch = () => new Promise<Response>(resolve => { finish = resolve; });
  const work = api.sessionCollaboratorRevocation('fixture-session', { id: 'grant', version: 4 });
  setRecoveryScope('b'.repeat(64)); setRecoveryScope('f'.repeat(64));
  finish(Response.json({ revocation: { state: 'confirmed', pending: 0, confirmed: 1 } }, { status }));
  await assert.rejects(work, AuthRequiredError);
  assert.deepEqual([...f.saved], before); assert.equal(f.events.includes('agentopsdeck:auth-required'), false);
});

for (const operation of ['create-user', 'issue-key'] as const) test(`actual ${operation} unknown POST is not retried and retains account/drafts`, async t => {
  const f = fixture(t), epoch = recoveryEpoch(), before = [...f.saved]; let writes = 0;
  globalThis.fetch = async (url, init) => {
    writes++;
    assert.equal(String(url), operation === 'create-user' ? '/api/hub/v1/users' : '/api/hub/v1/users/member/login-keys');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('x-agentopsdeck-recovery-scope'), 'f'.repeat(64));
    if (operation === 'create-user') assert.deepEqual(JSON.parse(String(init?.body)), { label: 'Member' });
    return Response.json({ error: 'auth_persistence_failed' }, { status: 503 });
  };
  await assert.rejects(operation === 'create-user' ? api.hubCreateUser({ label: 'Member' }) : api.hubIssueLoginKey('member'),
    e => e instanceof ApiResponseError && e.status === 503);
  assert.equal(writes, 1); assert.equal(recoveryEpoch(), epoch);
  assert.deepEqual([...f.saved], before); assert.deepEqual(f.mutations, []); assert.deepEqual(f.events, []);
});

for (const status of [409, 503]) test(`account lifecycle ${status} keeps CAS, account and drafts without GET or PATCH replay`, async t => {
  const f = fixture(t), epoch = recoveryEpoch(), before = [...f.saved]; let writes = 0;
  globalThis.fetch = async (url, init) => {
    writes++; assert.equal(String(url), '/api/hub/v1/users/member/access'); assert.equal(init?.method, 'PATCH');
    assert.deepEqual(JSON.parse(String(init?.body)), { status: 'disabled', expectedVersion: 4 });
    assert.equal(new Headers(init?.headers).get('x-agentopsdeck-recovery-scope'), 'f'.repeat(64));
    return Response.json({ error: 'unavailable' }, { status });
  };
  await assert.rejects(api.hubChangeUserAccess('member', { status: 'disabled', expectedVersion: 4 }), e => e instanceof ApiResponseError && e.status === status);
  assert.equal(writes, 1); assert.equal(recoveryEpoch(), epoch); assert.deepEqual([...f.saved], before);
  assert.deepEqual(f.events, []); assert.deepEqual(f.mutations, []);
});
test('account lifecycle malformed success ACK stays unknown and is never retried', async t => {
  fixture(t); let writes = 0;
  globalThis.fetch = async () => { writes++; return Response.json({ access: { userId: 'other', status: 'disabled', version: 5 } }); };
  await assert.rejects(api.hubChangeUserAccess('member', { status: 'disabled', expectedVersion: 4 }));
  assert.equal(writes, 1);
});
for (const status of [200, 401]) test(`late account lifecycle ${status} is fenced across account ABA without replay or signing out its replacement`, async t => {
  const f = fixture(t); let writes = 0, release!: (response: Response) => void;
  globalThis.fetch = async () => { writes++; return new Promise<Response>(resolve => { release = resolve; }); };
  const original = api.hubChangeUserAccess('member', { status: 'disabled', expectedVersion: 4 });
  setRecoveryScope('b'.repeat(64)); setRecoveryScope('f'.repeat(64)); const events = [...f.events], saved = [...f.saved];
  release(status === 200 ? Response.json({ access: { userId: 'member', status: 'disabled', version: 5 } }) : Response.json({ error: 'unauthorized' }, { status }));
  await assert.rejects(original, e => e instanceof AuthRequiredError && e.message === 'Authenticated account changed');
  assert.equal(writes, 1); assert.deepEqual(f.events, events); assert.deepEqual([...f.saved], saved);
});

for (const status of [201, 401]) test(`late key issuance ${status} is fenced across A/B/A without sign-out or replay`, async t => {
  const f = fixture(t); let writes = 0, release!: (response: Response) => void;
  globalThis.fetch = async () => { writes++; return new Promise<Response>(resolve => { release = resolve; }); };
  const original = api.hubIssueLoginKey('member');
  setRecoveryScope('b'.repeat(64)); setRecoveryScope('f'.repeat(64));
  const events = [...f.events], storage = [...f.saved];
  release(status === 201 ? Response.json({ id: 'synthetic-key', token: 'test-only' }, { status })
    : Response.json({ error: 'unauthorized' }, { status }));
  await assert.rejects(original, e => e instanceof AuthRequiredError && e.message === 'Authenticated account changed');
  assert.equal(writes, 1); assert.equal(recoveryScope(), 'f'.repeat(64));
  assert.deepEqual(f.events, events); assert.deepEqual([...f.saved], storage);
});

for (const status of [409, 503]) test(`membership ${status} preserves the reviewed digest and never GETs/replays a PUT`, async t => {
  const f = fixture(t), calls: string[] = [], digest = 'c'.repeat(64);
  const payload = { role: 'none' as const, version: 5, nodeVersion: 9,
    environments: { codex: 'disabled' as const, openclaw: 'disabled' as const }, migrateLegacy: true, grantSetDigest: digest };
  globalThis.fetch = async (url, init) => {
    calls.push(String(url)); assert.equal(init?.method, 'PUT');
    assert.deepEqual(JSON.parse(String(init?.body)), payload);
    assert.equal(new Headers(init?.headers).get('x-agentopsdeck-recovery-scope'), 'f'.repeat(64));
    return Response.json({ error: status === 409 ? 'hub_membership_conflict' : 'hub_membership_unavailable' }, { status });
  };
  await assert.rejects(api.saveConnectorMembership({ id: 'connector', ownerUserId: 'owner', label: 'Local', nodeVersion: 9,
    verified: true, creationReady: true, appointAdministrators: true, owner: true }, 'member', payload),
    e => e instanceof ApiResponseError && e.status === status);
  assert.deepEqual(calls, ['/api/hub/v1/access/owner/connections/connector/members/member']);
  assert.deepEqual(f.mutations, []); assert.deepEqual(f.events, []);
});

test('actual auth-status storage failure preserves account/drafts and only an explicit read retries', async t => {
  const f = fixture(t), epoch = recoveryEpoch(), before = [...f.saved]; let reads = 0, available = false;
  globalThis.fetch = async (url, init) => {
    reads++; assert.equal(String(url), '/api/auth/status'); assert.equal(init?.method ?? 'GET', 'GET');
    return available ? Response.json({ authenticated: true, recoveryScope: 'f'.repeat(64), passkeys: { available: true, count: 1 } })
      : Response.json({ error: 'auth_persistence_failed' }, { status: 503 });
  };
  await assert.rejects(api.authStatus(), error => error instanceof ApiResponseError && error.status === 503);
  assert.equal(reads, 1); assert.equal(recoveryEpoch(), epoch); assert.equal(recoveryScope(), 'f'.repeat(64));
  assert.deepEqual([...f.saved], before); assert.deepEqual(f.mutations, []); assert.deepEqual(f.events, []);
  available = true;
  const current = await api.authStatus(); assert.equal(current.authenticated, true); assert.equal(reads, 2);
  assert.equal(recoveryEpoch(), epoch); assert.deepEqual(f.events, []);
});

for (const kind of ['current', 'saved'] as const) test(`actual ${kind} layout unknown write ACK is not replayed or treated as sign-out`, async t => {
  const f = fixture(t), epoch = recoveryEpoch(), before = [...f.saved];
  const value = { revision: 7, content: '{"windows":["retained-existing-layout"]}' }; let writes = 0;
  globalThis.fetch = async (url, init) => {
    writes++; assert.equal(String(url), `/api/hub/v1/workspace/layouts/${kind}`); assert.equal(init?.method, 'PUT');
    assert.equal(init?.credentials, 'include'); assert.equal(new Headers(init?.headers).get('x-agentopsdeck-recovery-scope'), 'f'.repeat(64));
    assert.deepEqual(JSON.parse(String(init?.body)), value);
    return Response.json({ error: 'auth_persistence_failed' }, { status: 503 });
  };
  await assert.rejects(api.saveWorkspaceLayouts(kind, value, new AbortController().signal), error => error instanceof ApiResponseError && error.status === 503);
  await new Promise<void>(yes => setImmediate(yes));
  assert.equal(writes, 1); assert.equal(recoveryEpoch(), epoch); assert.equal(recoveryScope(), 'f'.repeat(64));
  assert.deepEqual([...f.saved], before); assert.deepEqual(f.mutations, []); assert.deepEqual(f.events, []);
});

test('confirmed auth rejection still raises the original authentication event', async t => {
  const f = fixture(t);
  globalThis.fetch = async () => Response.json({ error: 'unauthorized' }, { status: 401 });
  await assert.rejects(api.authStatus(), AuthRequiredError);
  assert.deepEqual(f.events, ['agentopsdeck:auth-required']);
});

test('member 403 on local owner runtime endpoints latches per recovery scope and resets on account switch', async t => {
  fixture(t);
  let agentReads = 0, gatewayReads = 0;
  globalThis.fetch = async url => {
    const path = String(url);
    if (path === '/api/agents') {
      agentReads++;
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    if (path === '/api/gateway/status') {
      gatewayReads++;
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  const firstAgents = await api.agents();
  const firstGateway = await api.gatewayStatus();
  assert.deepEqual(firstAgents, { agents: [], updatedAt: 0 });
  assert.deepEqual(firstGateway, { ok: false, enabled: false, status: 'offline', updatedAt: 0 });
  assert.equal(agentReads, 1);
  assert.equal(gatewayReads, 1);

  const secondAgents = await api.agents();
  const secondGateway = await api.gatewayStatus();
  assert.deepEqual(secondAgents, { agents: [], updatedAt: 0 });
  assert.deepEqual(secondGateway, { ok: false, enabled: false, status: 'offline', updatedAt: 0 });
  assert.equal(agentReads, 1);
  assert.equal(gatewayReads, 1);

  // Simulate a page reload returning to the same recoveryScope via sessionStorage:
  setRecoveryScope(undefined);
  setRecoveryScope('f'.repeat(64));
  await api.agents();
  await api.gatewayStatus();
  assert.equal(agentReads, 1);
  assert.equal(gatewayReads, 1);

  setRecoveryScope('a'.repeat(64));
  await api.agents();
  await api.gatewayStatus();
  assert.equal(agentReads, 2);
  assert.equal(gatewayReads, 2);
});
