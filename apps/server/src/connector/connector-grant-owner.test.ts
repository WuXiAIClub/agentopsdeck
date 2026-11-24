import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncConnectorGrantRequests, synchronousConnectorGrantRequests, type ConnectorGrantRequestPort } from './async-grant-request.js';
import { registerExecutionGrantHttp } from './execution-grant-http.js';
import { executeConnectorGrant, validConnectorGrantInput, validConnectorGrantOutput } from './connector-grant-domain.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';

const silence = new PerformanceDiagnostics(() => {});
async function fixture(t: TestContext, mode: 'sync' | 'worker') {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-grant-owner-'));
  const config = { file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json') };
  const tokens = new ConnectorTokenStore(config.tokenFile);
  const issuer = tokens.create({ label: 'private-synthetic-issuer', delegationHubId: 'hub-a',
    scopes: ['execution:delegate', 'messages:send', 'messages:mirror', 'sessions:create'] });
  const other = tokens.create({ label: 'other', delegationHubId: 'hub-b', scopes: ['execution:delegate', 'messages:send'] });
  const seed = new ConnectorUserStore(config.file, (id, action) => tokens.hasScope(id, 'execution:delegate')
    && tokens.hasScope(id, 'messages:send') && (action !== 'messages:mirror' || tokens.hasScope(id, 'messages:mirror')));
  const nodeId = seed.nodeId;
  const pendingTarget = { issuerTokenId: issuer.record.id, hubId: 'hub-a', principalId: 'seed-member', grantKey: 'seed-policy',
    version: 1, runtime: 'codex' as const, sessionKey: 'codex:synthetic/pending' };
  const pending = seed.executionGrants.issue(pendingTarget, ['messages:send'], Date.now() + 60_000);
  await seed.turns.enqueueAsync('codex', { id: 'synthetic-queued', sessionKey: pendingTarget.sessionKey, createdAt: 1,
    payload: { text: 'private-message-body', actorId: pending.actorId, executionGrant: { ...pending, issuerTokenId: issuer.record.id } } });
  let owner: AsyncConnectorOwner | undefined;
  let requests: ConnectorGrantRequestPort;
  if (mode === 'worker') {
    seed.close(); owner = new AsyncConnectorOwner(config, silence);
    t.after(async () => { try { await owner!.closeForShutdown(); } finally { rmSync(root, { recursive: true, force: true }); } });
    await owner.open(); requests = new AsyncConnectorGrantRequests(owner);
  } else {
    t.after(() => { seed.close(); rmSync(root, { recursive: true, force: true }); });
    requests = synchronousConnectorGrantRequests({ nodeId, tokens, grants: seed.executionGrants, turns: seed.turns, mirrorOutbox: seed.mirrorOutbox });
  }
  const lines: string[] = [], diagnostics = new PerformanceDiagnostics(line => lines.push(line));
  const app = new Hono(); registerExecutionGrantHttp(app, nodeId, requests, diagnostics, 10);
  const headers = { authorization: `Bearer ${issuer.token}`, [EXPECTED_NODE_HEADER]: nodeId, 'content-type': 'application/json' };
  const body = { principalId: 'member-a', grantKey: 'policy', version: 1, runtime: 'codex', sessionKey: 'codex:synthetic/会话',
    actions: ['messages:send'], leaseMs: 60_000 };
  const post = (value: unknown, suffix = '', supplied = headers) => app.request('/api/connector/v1/execution-grants' + suffix,
    { method: 'POST', headers: supplied, body: JSON.stringify(value) });
  const revoke = () => owner ? owner.command('tokenRevoke', { tokenId: issuer.record.id }) : tokens.revoke(issuer.record.id);
  return { app, body, headers, post, revoke, issuer, other, nodeId, requests, owner, seed, tokens, pending, config, lines };
}
for (const mode of ['sync', 'worker'] as const) {
  test(`${mode}: grant HTTP preserves issuance DTO, idempotent identity and durable version barriers`, async t => {
    const f = await fixture(t, mode);
    const get = (suffix: string) => f.app.request('/api/connector/v1/execution-grants/issuer' + suffix, { headers: f.headers });
    const expected = { nodeId: f.nodeId, issuerTokenId: f.issuer.record.id, hubId: 'hub-a' };
    assert.deepEqual(await (await get('')).json(), expected);
    assert.deepEqual(await (await get('/creation')).json(), { ...expected, creationAllowed: true });
    const issued = await f.post(f.body); assert.equal(issued.status, 200);
    const first = await issued.json(); assert.equal(first.leaseMs, 60_000);
    assert.deepEqual(await (await f.post(f.body)).json(), first, 'a deliberate protocol retry returns the original ref');
    const { actions: _actions, leaseMs: _lease, ...binding } = f.body;
    assert.deepEqual(await (await f.post(binding, '/revoke')).json(), { ...expected, revokedThroughVersion: 1 });
    assert.equal((await f.post(f.body)).status, 409);
    assert.equal((await f.post({ ...binding, version: 3 }, '/revoke')).status, 200);
    assert.equal((await f.post({ ...f.body, version: 2 })).status, 409);
    assert.equal((await f.post({ ...f.body, version: 4 })).status, 200);
    assert.equal((await f.post({ ...binding, version: 3 }, '/revoke')).status, 200, 'late revoke does not replace newer version');
    await f.revoke(); assert.equal((await f.post({ ...f.body, version: 5 })).status, 403);
  });
  test(`${mode}: exact original pending use stays in the owner and never discloses message contents`, async t => {
    const f = await fixture(t, mode);
    const response = await f.post({ ids: [f.pending.id] }, '/usage'); assert.equal(response.status, 200);
    const text = await response.text(); assert.deepEqual(JSON.parse(text).usage, [{ id: f.pending.id, needed: true }]);
    assert.doesNotMatch(text, /private-message-body|synthetic-queued|synthetic\/pending/);
    assert.equal((await f.post({ ids: [f.pending.id] }, '/usage', { ...f.headers, authorization: `Bearer ${f.other.token}` })).status, 403);
    assert.equal((await f.post({ ids: Array(33).fill(f.pending.id) }, '/usage')).status, 400);
    assert.equal((await f.post({ ids: [f.pending.id, f.pending.id] }, '/usage')).status, 400);
    assert.equal((await f.post({ ids: ['not-a-grant'] }, '/usage')).status, 400);
    await f.revoke(); assert.equal((await f.post({ ids: [f.pending.id] }, '/usage')).status, 403);
  });
  test(`${mode}: retired local delegation issuer can durably revoke its own historical grant without reopening HTTP issuance`, async t => {
    const f = await fixture(t, mode);
    assert.equal((await f.post(f.body)).status, 200);
    const { actions: _actions, leaseMs: _lease, ...binding } = f.body;
    await f.revoke();
    assert.equal((await f.post(binding, '/revoke')).status, 403, 'HTTP revoke still rejects a revoked bearer token');
    assert.equal((await f.post({ ...f.body, version: 2 })).status, 403, 'HTTP issue remains closed');
    const retire = (input: { expectedNode: string; issuerTokenId: string; hubId: string; body: unknown }) =>
      f.owner
        ? f.owner.command('localRetiredGrantRevoke', input)
        : Promise.resolve(executeConnectorGrant('localRetiredGrantRevoke', input, {
          nodeId: f.nodeId, tokens: f.tokens, grants: f.seed.executionGrants, turns: f.seed.turns, mirrorOutbox: f.seed.mirrorOutbox,
        }));
    assert.equal((await retire({ expectedNode: 'other-node', issuerTokenId: f.issuer.record.id, hubId: 'hub-a', body: binding })).status, 409);
    assert.equal((await retire({ expectedNode: f.nodeId, issuerTokenId: f.issuer.record.id, hubId: 'hub-b', body: binding })).status, 403);
    const retired = await retire({ expectedNode: f.nodeId, issuerTokenId: f.issuer.record.id, hubId: 'hub-a', body: binding });
    assert.deepEqual(retired, {
      status: 200,
      value: { nodeId: f.nodeId, issuerTokenId: f.issuer.record.id, hubId: 'hub-a', revokedThroughVersion: 1 },
    });
  });
  test(`${mode}: body cannot forge provenance, relax leases or change error precedence`, async t => {
    const f = await fixture(t, mode);
    for (const field of ['issuerTokenId', 'actorId', 'hubId', 'nodeId', 'authorized', 'sql', 'step'])
      assert.equal((await f.post({ ...f.body, [field]: 'forged' })).status, 400, field);
    for (const value of [null, [], {}, { ...f.body, leaseMs: 60_001 }, { ...f.body, leaseMs: 1.5 },
      { ...f.body, expiresAt: Date.now() + 60_000 }, { ...f.body, runtime: 'claude-code' },
      { ...f.body, version: 0 }, { ...f.body, actions: ['*'] }]) assert.equal((await f.post(value)).status, 400);
    assert.equal((await f.post(f.body, '', { ...f.headers, [EXPECTED_NODE_HEADER]: 'other' })).status, 409);
    assert.equal((await f.post(null, '', { ...f.headers, authorization: 'Bearer invalid', [EXPECTED_NODE_HEADER]: 'other' })).status, 403);
    assert.equal((await f.post(f.body)).status, 200, 'semantic refusal never retires the owner');
  });
  test(`${mode}: held request body cannot freeze issuer authorization or release original execution`, async t => {
    const f = await fixture(t, mode);
    let body!: ReadableStreamDefaultController<Uint8Array>, ready!: () => void;
    const pulled = new Promise<void>(resolve => { ready = resolve; });
    const stream = new ReadableStream<Uint8Array>({ start(c) { body = c; }, pull() { ready(); } });
    const pending = f.app.fetch(new Request('http://fixture.invalid/api/connector/v1/execution-grants', {
      method: 'POST', headers: f.headers, body: stream, duplex: 'half' } as RequestInit));
    await pulled; await f.revoke(); body.enqueue(new TextEncoder().encode(JSON.stringify(f.body))); body.close();
    assert.equal((await pending).status, 403);
    if (f.owner) assert.equal(await f.owner.command('turnMaintenanceCount', {}), 1,
      'authorization refusal retains the original queued turn without requiring a maintenance pause');
  });
  test(`${mode}: HTTP observations include key outcomes, no private labels, credentials or SQL`, async t => {
    const f = await fixture(t, mode); await f.post(f.body);
    await f.post({ ...f.body, hubId: 'forged' }); await f.revoke(); await f.post(f.body);
    const text = f.lines.join('\n'), rows = f.lines.map(line => JSON.parse(line));
    assert.ok(rows.some(row => row.operation === 'connector-grants-http' && row.step === 32 && row.settled === 1));
    assert.ok(rows.some(row => row.category === 'failed' && row.deferred === 1));
    for (const secret of [f.issuer.token, f.issuer.record.id, f.nodeId, 'hub-a', 'private-synthetic-issuer', 'member-a', f.config.file])
      assert.equal(text.includes(secret), false, secret);
    assert.doesNotMatch(text, /INSERT|SELECT|principalId|sessionKey/);
  });
}
test('fixed grant envelopes reject caller authority and malformed replies without mutable dispatch', () => {
  const evidence = { authorization: 'Bearer synthetic', expectedNode: 'node-a' };
  for (const kind of ['authorizedGrantIssuer', 'authorizedGrantCreation', 'authorizedGrantIssue', 'authorizedGrantRevoke', 'authorizedGrantUsage'] as const) {
    const input = { ...evidence, ...(kind === 'authorizedGrantIssuer' || kind === 'authorizedGrantCreation' ? {} : { body: null }) };
    assert.equal(validConnectorGrantInput(kind, input), true);
    assert.equal(validConnectorGrantInput(kind, { ...input, authorized: true }), false);
    assert.equal(validConnectorGrantInput(kind, { ...input, authorization: 'Bearer x\r\n' }), false);
    assert.equal(validConnectorGrantOutput(kind, { status: 403, error: 'Trusted delegation issuer required' }), true);
    assert.equal(validConnectorGrantOutput(kind, { status: 200, value: { nodeId: 'node-a', issuerTokenId: 'issuer', hubId: 'hub' }, sql: 'private' }), false);
    assert.equal(validConnectorGrantOutput(kind, { status: 503, error: 'private SQL exception' }), false);
  }
});
test('pending grant HTTP logging never cancels, retries or fabricates an accepted write', async t => {
  const keepAlive = setTimeout(() => {}, 2000); t.after(() => clearTimeout(keepAlive));
  let settle!: (value: any) => void, calls = 0, observed!: () => void;
  const waiting = new Promise<any>(resolve => { settle = resolve; });
  const pendingLog = new Promise<void>(resolve => { observed = resolve; });
  const rows: Record<string, unknown>[] = [];
  const requests: ConnectorGrantRequestPort = { execute(kind) {
    calls++; return kind === 'authorizedGrantIssuer' ? { status: 200, value: { nodeId: 'node', issuerTokenId: 'issuer', hubId: 'hub' } } as any : waiting;
  } };
  const app = new Hono(); registerExecutionGrantHttp(app, 'node', requests, new PerformanceDiagnostics(line => {
    const row = JSON.parse(line); rows.push(row); if (row.phase === 'pending') observed();
  }), 5);
  const work = app.request('/api/connector/v1/execution-grants', { method: 'POST', body: '{}' });
  await pendingLog; assert.equal(calls, 2);
  assert.equal(rows.some(row => row.settled === 1), false);
  settle({ status: 200, value: { nodeId: 'node', issuerTokenId: 'issuer', hubId: 'hub', grant: { id: 'grant', actorId: 'actor' } } });
  assert.equal((await work).status, 200); assert.equal(calls, 2);
  assert.equal(rows.at(-1)?.settled, 1);
});
test('aborted async grant admission never reaches the Worker', async () => {
  let calls = 0;
  const requests = new AsyncConnectorGrantRequests({ command() { calls++; throw Error('must not run'); } } as unknown as AsyncConnectorOwner);
  const signal = new AbortController(); signal.abort();
  assert.throws(() => requests.execute('authorizedGrantIssue', new Request('http://fixture.invalid', { signal: signal.signal }), {}));
  assert.equal(calls, 0);
});

test('a replacement grant owner restores node identity, version barriers and pending queue without replay', async t => {
  const f = await fixture(t, 'worker');
  assert.equal((await f.post(f.body)).status, 200);
  const { actions: _actions, leaseMs: _lease, ...binding } = f.body;
  assert.equal((await f.post({ ...binding, version: 3 }, '/revoke')).status, 200);
  await f.owner!.closeForShutdown();
  const replacement = new AsyncConnectorOwner(f.config, silence);
  try {
    await replacement.open();
    assert.equal(await replacement.command('nodeIdentity', {}), f.nodeId);
    assert.equal(await replacement.command('turnMaintenanceCount', {}), 1);
    const app = new Hono();
    registerExecutionGrantHttp(app, f.nodeId, new AsyncConnectorGrantRequests(replacement), silence);
    const post = (body: unknown, suffix = '') => app.request('/api/connector/v1/execution-grants' + suffix,
      { method: 'POST', headers: f.headers, body: JSON.stringify(body) });
    assert.equal((await post({ ...f.body, version: 2 })).status, 409);
    assert.deepEqual((await (await post({ ids: [f.pending.id] }, '/usage')).json()).usage,
      [{ id: f.pending.id, needed: true }]);
    await replacement.command('tokenRevoke', { tokenId: f.issuer.record.id });
    assert.equal((await post({ ids: [f.pending.id] }, '/usage')).status, 403);
    assert.equal(await replacement.command('turnMaintenanceCount', {}), 1);
  } finally { await replacement.closeForShutdown(); }
});
