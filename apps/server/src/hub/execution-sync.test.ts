import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { HubStore } from './hub-store.js';
import { HubExecutionLeases } from './execution-leases.js';
import { HubExecutionSync } from './execution-sync.js';
import { ConnectorClient } from './connector-client.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { executeConnectorGrant } from '../connector/connector-grant-domain.js';
import { ExecutionGrants } from '../connector/execution-grants.js';
import { registerExecutionGrantRoutes } from '../connector/execution-grant-http.js';

async function fixture(transport: 'local' | 'http' = 'local', maxRows = 10_000, clockOffset = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-execution-sync-')), file = join(dir, 'hub.sqlite');
  const hub = new HubStore(file, 'synthetic-vault'), db = new DatabaseSync(file);
  let now = Date.now(), calls = 0, dropIssue = false, dropRevoke = false;
  let afterIssue = () => {};
  const leases = new HubExecutionLeases(db, hub.grants, () => now, maxRows);
  const user = hub.createUser('Member'), nodeId = `node_${randomUUID()}`;
  const connection = { id: 'node', kind: 'remote' as const, label: 'Fixture', connectorUrl: 'http://unused.invalid' };
  hub.upsertConnection(connection);
  assert.equal(hub.pinConnectionNode('node', 'default', hub.connectionAuthority('node', 'default')!, nodeId)?.nodeId, nodeId);
  const target = { ownerUserId: 'default', connectionId: 'node', userId: user.id };
  const resource = { runtime: 'codex' as const, sessionKey: 'codex:fixture/空 格' };
  const policy = { ...resource, actions: ['messages:send', 'messages:read'] as ('messages:send' | 'messages:read')[] };
  const grant = hub.grants.create(target, policy);
  const proof = () => hub.grants.authorize(target, 'messages:send', resource, grant.id)!;
  const tokens = new ConnectorTokenStore(join(dir, 'tokens.json'));
  const issuer = tokens.create({ label: 'Synthetic issuer', delegationHubId: hub.identities.hubId,
    scopes: ['execution:delegate', 'messages:send'] });
  const remoteDb = new DatabaseSync(join(dir, 'connector.sqlite'));
  const grants = new ExecutionGrants(remoteDb, id => !!tokens.delegationHubId(id), () => now + clockOffset);
  const app = new Hono();
  registerExecutionGrantRoutes(app, { nodeId, tokens, grants, now: () => now + clockOffset });
  const dispatch = async (request: Request) => {
    calls++;
    const response = await app.fetch(request);
    if (new URL(request.url).pathname.endsWith('/revoke')) {
      if (dropRevoke) { await response.body?.cancel(); throw new Error('synthetic lost revoke ACK'); }
    } else {
      afterIssue();
      if (dropIssue) { await response.body?.cancel(); throw new Error('synthetic lost issue ACK'); }
    }
    return response;
  };
  const server = transport === 'http' ? serve({ fetch: dispatch, hostname: '127.0.0.1', port: 0 }) : undefined;
  if (server && !server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server?.address();
  const origin = address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : 'http://connector.example.invalid';
  const client = new ConnectorClient(origin, issuer.token, transport === 'local' ? dispatch : undefined,
    1000, 8192, { nodeId });
  const sync = new HubExecutionSync(leases, hub.identities.hubId, () => client, 32, () => now);
  return { hub, file, db, leases, sync, proof, target, grant, policy, nodeId, issuer, tokens, resource, grants, client, connection,
    acquire: () => sync.acquire(proof(), nodeId, issuer.record.id, ['messages:send']),
    calls: () => calls, advance: (ms: number) => { now += ms; },
    drop: (issue: boolean, revoke = false) => { dropIssue = issue; dropRevoke = revoke; },
    afterIssue: (callback: () => void) => { afterIssue = callback; },
    close: async () => { if (server) { if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
      remoteDb.close(); db.close(); hub.close(); } };
}

for (const transport of ['local', 'http'] as const) {
  test(`${transport}: durable issue, shared flight, cached authority and renewal use one Connector ref`, async () => {
    const f = await fixture(transport);
    try {
      const [a, b] = await Promise.all([f.acquire(), f.acquire()]);
      assert.equal(a.state, 'active'); assert.deepEqual(a.ref, b.ref); assert.equal(f.calls(), 1);
      assert.deepEqual((await f.acquire()).ref, a.ref); assert.equal(f.calls(), 1, 'no grant RPC per message');
      f.advance(46_000);
      const renewed = await f.acquire();
      assert.deepEqual(renewed.ref, a.ref); assert.equal(renewed.version, a.version); assert.equal(f.calls(), 2);
      assert.equal(f.grants.authorize(a.ref!, f.issuer.record.id, f.resource, 'messages:send'), true);
      const reopened = new HubStore(f.file, 'synthetic-vault');
      try {
        assert.equal(reopened.identities.hubId, f.hub.identities.hubId);
        assert.deepEqual(reopened.executionLeases.get(a.id)?.ref, a.ref);
        assert.equal(reopened.executionLeases.get(a.id)?.expiresAt, renewed.expiresAt);
      } finally { reopened.close(); }
    } finally { await f.close(); }
  });

  test(`${transport}: lost issue ACK is recoverable and revoke-before-ACK never restores authority`, async () => {
    const f = await fixture(transport);
    try {
      f.drop(true);
      await assert.rejects(f.acquire());
      assert.equal(f.leases.get(1)?.state, 'pending');
      f.drop(false);
      const active = await f.acquire();
      assert.equal(active.id, 1); assert.equal(active.version, 1);
      f.advance(46_000);
      f.afterIssue(() => { f.hub.grants.revoke(f.target, f.grant.id, 1); });
      await assert.rejects(f.acquire(), /changed/);
      assert.equal(f.leases.get(1)?.state, 'revoking');
      assert.equal(f.grants.authorize(active.ref!, f.issuer.record.id, f.resource, 'messages:send'), true,
        'Hub-local revoke alone is not a remote ACK');
      const progress = await f.sync.reconcileRevocations();
      assert.equal(progress.acknowledged, 1);
      assert.equal(f.grants.authorize(active.ref!, f.issuer.record.id, f.resource, 'messages:send'), false);
      assert.equal(f.leases.get(1)?.state, 'revoked');
    } finally { await f.close(); }
  });
}

test('historical queue actor selection uses a target index, latest acknowledged ref and stable issuer pagination', async () => {
  const f = await fixture();
  try {
    const selection = { ...f.target, ...f.resource, nodeId: f.nodeId };
    assert.equal(f.leases.nextQueueActor(selection), undefined);
    const lease = await f.acquire();
    assert.equal(f.leases.nextQueueActor(selection)?.id, lease.id);
    for (const changed of [{ userId: 'other' }, { ownerUserId: 'other' }, { connectionId: 'other' }, { sessionKey: 'other' }, { nodeId: `node_${randomUUID()}` }]) {
      assert.equal(f.leases.nextQueueActor({ ...selection, ...changed }), undefined);
    }
    // Populate synthetic historical versions with the same actor; selection
    // must not return one page per lease version or prefer an unacknowledged row.
    const copy = f.db.prepare(`INSERT INTO hub_execution_leases
      (grant_key,version,node_id,issuer_id,grant_id,owner_id,connection_id,principal_id,proof,actions,expires_at,state,ref)
      SELECT grant_key,?,node_id,issuer_id,grant_id,owner_id,connection_id,principal_id,proof,actions,expires_at,'revoked',?
      FROM hub_execution_leases WHERE id = ?`);
    const acknowledged = Number(copy.run(2, JSON.stringify(lease.ref), lease.id).lastInsertRowid);
    copy.run(3, null, lease.id);
    assert.equal(f.leases.nextQueueActor(selection)?.id, acknowledged);
    assert.equal(f.leases.nextQueueActor(selection, lease.issuerId), undefined);
    const reopened = new HubExecutionLeases(f.db, f.hub.grants);
    assert.equal(reopened.nextQueueActor(selection)?.id, acknowledged);
    const plan = f.db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM hub_execution_leases WHERE owner_id = ? AND connection_id = ?
      AND principal_id = ? AND node_id = ? AND json_extract(proof, '$.resource.sessionKey') = ?
      AND issuer_id > ? AND ref IS NOT NULL ORDER BY issuer_id, id DESC LIMIT 1`)
      .all(selection.ownerUserId, selection.connectionId, selection.userId, selection.nodeId, selection.sessionKey, '');
    assert.match(JSON.stringify(plan), /SEARCH.*hub_execution_queue_actor/); assert.doesNotMatch(JSON.stringify(plan), /SCAN|TEMP B-TREE/);
  } finally { await f.close(); }
});

test('offline original issuer remains durably revoking through expiry and Hub reopen; only pinned issuer ACK settles', async () => {
  const f = await fixture('http');
  let reopened: HubStore | undefined, recovering: HubExecutionSync | undefined;
  try {
    const original = await f.acquire();
    f.hub.grants.revoke(f.target, f.grant.id, 1);
    let attempts = 0;
    const offline = new HubExecutionSync(f.leases, f.hub.identities.hubId, lease => {
      assert.equal(lease.issuerId, f.issuer.record.id);
      assert.equal(lease.nodeId, f.nodeId); attempts++; throw Error('original issuer unavailable');
    });
    try {
      assert.equal((await offline.reconcileRevocations(0, 32, { retryBackoff: true })).acknowledged, 0);
      assert.equal((await offline.reconcileRevocations(0, 32, { retryBackoff: true })).acknowledged, 0);
      assert.equal(attempts, 1, 'backoff does not retry offline original issuer per UI read');
    } finally { await offline.close(); }
    f.advance(120_000);
    reopened = new HubStore(f.file, 'synthetic-vault');
    assert.equal(reopened.executionLeases.get(original.id)?.state, 'revoking', 'expiry is not an issuer ACK');
    assert.equal(reopened.executionLeases.get(original.id)?.issuerId, original.issuerId);
    const wrong = new HubExecutionSync(reopened.executionLeases, reopened.identities.hubId,
      () => new ConnectorClient('http://must-not-contact.invalid', 'synthetic-replacement', undefined, 1000, 8192, { nodeId: `node_${randomUUID()}` }));
    try { assert.equal((await wrong.reconcileRevocations()).acknowledged, 0); }
    finally { await wrong.close(); }
    assert.equal(reopened.executionLeases.get(original.id)?.state, 'revoking');
    recovering = new HubExecutionSync(reopened.executionLeases, reopened.identities.hubId, lease => {
      assert.equal(lease.issuerId, f.issuer.record.id); return f.client;
    });
    const before = f.calls();
    assert.equal((await recovering.reconcileRevocations()).acknowledged, 1);
    assert.equal(f.calls(), before + 1, 'only original revocation barrier delivered, no new issue');
    assert.equal(reopened.executionLeases.get(original.id)?.state, 'revoked');
    assert.equal(f.grants.authorize(original.ref!, f.issuer.record.id, f.resource, 'messages:send'), false);
  } finally { await recovering?.close(); reopened?.close(); await f.close(); }
});

test('lost issue and revoke ACKs persist across reopen; duplicate barrier is safe', async () => {
  const f = await fixture();
  let reopened: HubStore | undefined;
  try {
    f.drop(true);
    await assert.rejects(f.acquire());
    assert.equal(f.leases.get(1)?.ref, undefined);
    f.hub.grants.revoke(f.target, f.grant.id, 1);
    reopened = new HubStore(f.file, 'synthetic-vault');
    const sync = new HubExecutionSync(reopened.executionLeases, reopened.identities.hubId, () => f.client);
    f.drop(false, true);
    assert.equal((await sync.reconcileRevocations()).acknowledged, 0);
    assert.equal(reopened.executionLeases.get(1)?.state, 'revoking');
    f.drop(false);
    assert.equal((await sync.reconcileRevocations()).acknowledged, 1);
    const lease = reopened.executionLeases.get(1)!;
    assert.equal(lease.state, 'revoked');
    assert.throws(() => f.grants.issue({ issuerTokenId: f.issuer.record.id, hubId: reopened!.identities.hubId,
      principalId: f.target.userId, grantKey: lease.grantKey, version: 1, ...f.resource }, ['messages:send'], Date.now() + 10_000), /stale/);
  } finally { reopened?.close(); await f.close(); }
});

test('policy and node changes atomically queue revocation; replacement needs barrier and new version', async () => {
  const f = await fixture();
  try {
    const old = await f.acquire();
    f.hub.grants.replace(f.target, f.grant.id, 1, f.policy);
    assert.equal(f.leases.get(old.id)?.state, 'revoking');
    assert.throws(() => f.acquire(), /revocation is pending/);
    await f.sync.reconcileRevocations();
    const next = await f.acquire();
    assert.equal(next.version, 2); assert.notDeepEqual(next.ref, old.ref);
    assert.equal(f.grants.authorize(old.ref!, f.issuer.record.id, f.resource, 'messages:send'), false);
    f.hub.upsertConnection({ ...f.connection, status: 'disabled' });
    assert.equal(f.leases.get(next.id)?.state, 'revoking');
    assert.equal(f.leases.acknowledgeIssue(next.id, next.ref!, next.expiresAt), false);
  } finally { await f.close(); }
});

test('lease expiry, rollback, capacity and proof/issuer/node/action mismatches fail closed', async () => {
  const f = await fixture('local', 1);
  try {
    for (const [proof, nodeId, issuerId, actions] of [
      [f.proof(), `node_${randomUUID()}`, f.issuer.record.id, ['messages:send']],
      [f.proof(), f.nodeId, '', ['messages:send']],
      [f.proof(), f.nodeId, f.issuer.record.id, ['messages:send', 'runs:compact']],
      [{ ...f.proof(), resource: { ...f.resource, agentId: 'forged' } }, f.nodeId, f.issuer.record.id, ['messages:send']],
    ] as const) assert.throws(() => f.leases.reserve(proof, nodeId, issuerId, [...actions]));
    assert.equal(f.calls(), 0);
    const old = await f.acquire();
    f.advance(60_001);
    assert.throws(() => f.acquire(), /reconciled/);
    assert.equal(f.leases.get(old.id)?.state, 'revoking');
    await f.sync.reconcileRevocations();
    assert.throws(() => f.acquire(), /capacity/);
    assert.throws(() => f.leases.revocations(0, 129), /page/);
    assert.equal(f.leases.acknowledgeRevoke(old.id, 2), false);
  } finally { await f.close(); }
  const rollback = await fixture();
  try {
    await rollback.acquire(); rollback.advance(-1);
    assert.throws(() => rollback.acquire(), /reconciled/);
    assert.equal(rollback.leases.get(1)?.state, 'revoking');
  } finally { await rollback.close(); }
});

test('unbound client and wrong Hub acknowledgment never grant Hub authority', async () => {
  const f = await fixture();
  try {
    const lease = f.leases.reserve(f.proof(), f.nodeId, f.issuer.record.id, ['messages:send']);
    const unbound = new HubExecutionSync(f.leases, f.hub.identities.hubId, () => new ConnectorClient('http://unused.invalid', 'synthetic'));
    await assert.rejects(unbound.synchronize(lease.id), /Pinned/);
    assert.equal(f.calls(), 0);
    const wrongHub = new HubExecutionSync(f.leases, randomUUID(), () => f.client);
    await assert.rejects(wrongHub.synchronize(lease.id), /issuer acknowledgment mismatch/);
    assert.equal(f.leases.get(lease.id)?.state, 'revoking');
    assert.equal(f.leases.get(lease.id)?.ref, undefined);
  } finally { await f.close(); }
});

test('policy rollback and cross-member isolation preserve only the intended revocation intents', async () => {
  const f = await fixture();
  try {
    const a = await f.acquire(), member = f.hub.createUser('Other');
    const otherTarget = { ...f.target, userId: member.id };
    const otherGrant = f.hub.grants.create(otherTarget, f.policy);
    const proof = f.hub.grants.authorize(otherTarget, 'messages:send', f.resource, otherGrant.id)!;
    const b = await f.sync.acquire(proof, f.nodeId, f.issuer.record.id, ['messages:send']);
    assert.notEqual(a.ref!.actorId, b.ref!.actorId);
    f.db.exec('BEGIN IMMEDIATE');
    // Same transaction/connection as the policy writer, including triggers.
    f.db.prepare('UPDATE node_grants SET revoked = 1, version = version + 1 WHERE id = ?').run(f.grant.id);
    assert.equal(f.leases.get(a.id)?.state, 'revoking');
    assert.equal(f.leases.get(b.id)?.state, 'active');
    f.db.exec('ROLLBACK');
    assert.equal(f.leases.get(a.id)?.state, 'active');
    f.hub.grants.revoke(f.target, f.grant.id, 1);
    assert.deepEqual(f.leases.revocations().map(row => row.id), [a.id]);
    assert.deepEqual(f.leases.revocations(a.id), []);
    await f.sync.reconcileRevocations();
    assert.equal(f.grants.authorize(a.ref!, f.issuer.record.id, f.resource, 'messages:send'), false);
    assert.equal(f.grants.authorize(b.ref!, f.issuer.record.id, f.resource, 'messages:send'), true);
  } finally { await f.close(); }
});

test('synchronization flights are bounded and a stale renewal ACK cannot acknowledge a later request', async () => {
  const f = await fixture();
  try {
    const lease = f.leases.reserve(f.proof(), f.nodeId, f.issuer.record.id, ['messages:send']);
    const sync = new HubExecutionSync(f.leases, f.hub.identities.hubId, () => f.client, 1);
    const first = sync.synchronize(lease.id);
    assert.equal(sync.synchronize(lease.id), first);
    await assert.rejects(sync.synchronize(999), /capacity/);
    const active = await first;
    const old = f.leases.prepareIssue(lease.id);
    f.advance(1);
    const current = f.leases.prepareIssue(lease.id);
    assert.equal(f.leases.acknowledgeIssue(lease.id, active.ref!, old.expiresAt), false);
    assert.equal(f.leases.get(lease.id)?.state, 'pending');
    assert.equal(f.leases.acknowledgeIssue(lease.id, active.ref!, current.expiresAt), true);
    await assert.rejects(sync.synchronize(999), /not found/, 'flight slot is released');
  } finally { await f.close(); }
});

for (const clockOffset of [-3_600_000, 3_600_000]) test(`relative lease tolerates Connector clock offset ${clockOffset}ms`, async () => {
  const f = await fixture('local', 10_000, clockOffset);
  try {
    const lease = await f.acquire();
    assert.equal(f.grants.authorize(lease.ref!, f.issuer.record.id, f.resource, 'messages:send'), true);
    f.advance(46_000);
    assert.deepEqual((await f.acquire()).ref, lease.ref);
    f.advance(60_001);
    assert.equal(f.grants.authorize(lease.ref!, f.issuer.record.id, f.resource, 'messages:send'), false);
    assert.throws(() => f.acquire(), /reconciled/);
  } finally { await f.close(); }
});

test('sync shutdown cancels a stalled ACK, preserves pending intent, and closes future admission', async () => {
  const f = await fixture();
  let entered!: () => void, cancelled = false;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const client = new ConnectorClient('http://connector.example.invalid', f.issuer.token, request => {
    entered();
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      headers: { 'x-agentopsdeck-node-id': f.nodeId, 'content-type': 'application/json' } });
  }, 10_000, 8192, { nodeId: f.nodeId });
  const sync = new HubExecutionSync(f.leases, f.hub.identities.hubId, () => client);
  try {
    const lease = f.leases.reserve(f.proof(), f.nodeId, f.issuer.record.id, ['messages:send']);
    const pending = sync.synchronize(lease.id);
    const rejected = assert.rejects(pending, /closed/);
    await ready; await sync.close(); await rejected;
    assert.equal(cancelled, true); assert.equal(f.leases.get(lease.id)?.state, 'pending');
    await assert.rejects(sync.synchronize(lease.id), /closed/);
    assert.throws(() => sync.acquire(f.proof(), f.nodeId, f.issuer.record.id, ['messages:send']), /closed/);
  } finally { await sync.close(); await f.close(); }
});

test('background reconciliation backs off failing issuer domains without acknowledging or redispatching commands', async () => {
  const f = await fixture();
  try {
    const lease = await f.acquire(); f.leases.revoke(lease.id); f.drop(false, true);
    const reconcile = () => f.sync.reconcileRevocations(0, 16, { retryBackoff: true });
    assert.equal((await reconcile()).acknowledged, 0); const calls = f.calls();
    for (let index = 0; index < 4; index++) assert.equal((await reconcile()).acknowledged, 0);
    assert.equal(f.calls(), calls); assert.equal(f.leases.get(lease.id)?.state, 'revoking');
    f.advance(1001); assert.equal((await reconcile()).acknowledged, 0); assert.equal(f.calls(), calls + 1);
    f.advance(1001); await reconcile(); assert.equal(f.calls(), calls + 1, 'second failure doubles retry delay');
    f.advance(1000); f.drop(false, false);
    assert.equal((await reconcile()).acknowledged, 1); assert.equal(f.calls(), calls + 2);
  } finally { await f.close(); }
});

test('revoke page has at most four transports and a failed node does not suppress its healthy peers', async () => {
  const f = await fixture();
  let active = 0, peak = 0, unblock!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  const leases: number[] = [];
  try {
    for (let index = 0; index < 6; index++) {
      const member = f.hub.createUser(`Member ${index}`), target = { ...f.target, userId: member.id };
      const grant = f.hub.grants.create(target, f.policy), proof = f.hub.grants.authorize(target, 'messages:send', f.resource, grant.id)!;
      const lease = await f.sync.acquire(proof, f.nodeId, f.issuer.record.id, ['messages:send']);
      f.leases.revoke(lease.id); leases.push(lease.id);
    }
    const client = new ConnectorClient('http://connector.example.invalid', f.issuer.token, async request => {
      active++; peak = Math.max(peak, active); if (active === 4) entered();
      await gate;
      try {
        const body = await request.json();
        if (body.grantKey === f.leases.get(leases[0]!)!.grantKey) throw new Error('Synthetic unreachable node');
        return Response.json({ nodeId: f.nodeId, hubId: f.hub.identities.hubId, issuerTokenId: f.issuer.record.id,
          revokedThroughVersion: body.version }, { headers: { 'x-agentopsdeck-node-id': f.nodeId } });
      } finally { active--; }
    }, 10_000, 8192, { nodeId: f.nodeId });
    const sync = new HubExecutionSync(f.leases, f.hub.identities.hubId, () => client);
    const page = sync.reconcileRevocations();
    await ready; assert.equal(peak, 4); unblock();
    assert.deepEqual(await page, { examined: 6, acknowledged: 5, nextCursor: leases[5] });
    assert.equal(peak, 4); assert.equal(f.leases.get(leases[0]!)?.state, 'revoking');
    await sync.close();
  } finally { unblock(); await f.close(); }
});

test('local retired delegation issuer settles durable revocation on 403 without reopening HTTP grant authority', async () => {
  const f = await fixture();
  try {
    const lease = await f.acquire();
    assert.equal(f.grants.authorize(lease.ref!, f.issuer.record.id, f.resource, 'messages:send'), true);
    f.leases.revoke(lease.id);
    f.tokens.revoke(f.issuer.record.id);
    const sync = new HubExecutionSync(f.leases, f.hub.identities.hubId, () => f.client, 32, () => Date.now(), undefined,
      async (revokingLease, binding) => {
        const reply = executeConnectorGrant('localRetiredGrantRevoke', {
          expectedNode: revokingLease.nodeId,
          issuerTokenId: revokingLease.issuerId,
          hubId: f.hub.identities.hubId,
          body: binding,
        }, {
          nodeId: f.nodeId,
          tokens: f.tokens,
          grants: f.grants,
          turns: { usesExecutionGrant: () => false },
          mirrorOutbox: { usesExecutionGrant: () => false },
        });
        return reply.status === 200 ? reply.value : undefined;
      });
    try {
      const result = await sync.reconcileRevocations(0, 16, { retryBackoff: true });
      assert.equal(result.acknowledged, 1);
      assert.equal(f.leases.get(lease.id)?.state, 'revoked');
      assert.equal(f.grants.authorize(lease.ref!, f.issuer.record.id, f.resource, 'messages:send'), false);
    } finally {
      await sync.close();
    }
  } finally {
    await f.close();
  }
});

test('remote 403 revocation refusal applies extended backoff instead of hammering every 30s', async () => {
  const f = await fixture();
  try {
    const lease = await f.acquire();
    f.leases.revoke(lease.id);
    f.tokens.revoke(f.issuer.record.id);
    const reconcile = () => f.sync.reconcileRevocations(0, 16, { retryBackoff: true });
    assert.equal((await reconcile()).acknowledged, 0);
    const initialCalls = f.calls();
    f.advance(4_999);
    await reconcile();
    assert.equal(f.calls(), initialCalls, '403 refusal waits at least 5s before first retry');
    f.advance(2);
    await reconcile();
    assert.equal(f.calls(), initialCalls + 1, 'retries after 5s');
    for (let step = 0; step < 8; step++) {
      f.advance(900_001);
      await reconcile();
    }
    const afterCapCalls = f.calls();
    f.advance(60_000);
    await reconcile();
    assert.equal(f.calls(), afterCapCalls, 'extended auth-refusal backoff suppresses 30s/60s polling');
    assert.equal(f.leases.get(lease.id)?.state, 'revoking', 'never fabricates revocation ACK');
  } finally {
    await f.close();
  }
});
