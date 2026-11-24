import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubExecutionLeases } from './async-execution-leases.js';
import { AsyncHubExecutionIssuers } from './async-execution-issuers.js';
import { HubExecutionSync } from './execution-sync.js';
import { HubExecutionUsage } from './execution-usage.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ExecutionGrants } from '../connector/execution-grants.js';
import { registerExecutionGrantRoutes } from '../connector/execution-grant-http.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { executionIssuerBinding, validExecutionIssuerSnapshot, validHubExecutionIssuerCommand, validHubExecutionIssuerReply,
  type HubExecutionIssuerCommand } from './member-execution-issuer-domain.js';
import { validHubMemberInput } from './member-owner-domain.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';

for (const ownerKind of ['worker', 'original-production'] as const) describe(ownerKind, () => {

async function fixture(transport: 'local' | 'remote' = 'local') {
  const root = mkdtempSync(join(tmpdir(), 'async-issuer-')), file = join(root, 'hub.sqlite');
  const seed = new HubStore(file, 'fixture-vault'), remoteDb = new DatabaseSync(':memory:');
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'));
  const first = tokens.create({ label: 'Fixture', delegationHubId: seed.identities.hubId,
    scopes: ['execution:delegate', 'messages:send'] });
  const nodeId = 'node_' + randomUUID(), grants = new ExecutionGrants(remoteDb, id => !!tokens.delegationHubId(id));
  const app = new Hono(); registerExecutionGrantRoutes(app, { nodeId, tokens, grants });
  let calls = 0, drop = false;
  const dispatch = async (r: Request) => {
    calls++; const result = await app.fetch(r);
    if (drop && r.url.endsWith('/revoke')) { await result.body?.cancel(); throw Error('fixture lost ACK'); }
    return result;
  };
  const server = transport === 'remote' ? serve({ fetch: dispatch, hostname: '127.0.0.1', port: 0 }) : undefined;
  if (server && !server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = server ? `http://127.0.0.1:${(server.address() as { port: number }).port}` : 'http://connector.example.invalid';
  const local = transport === 'local' ? { connectionId: 'node', dispatch } : undefined;
  let lease!: ReturnType<HubStore['executionLeases']['reserve']>;
  const hubId = seed.identities.hubId;
  try {
    seed.upsertConnection({ id: 'node', kind: transport, label: 'Fixture', connectorUrl: origin });
    seed.pinConnectionNode('node', 'default', seed.connectionAuthority('node')!, nodeId);
    await seed.executionIssuers.configure('default', 'node', first.token, () => {}, local);
    const target = { ownerUserId: 'default', connectionId: 'node', userId: seed.createUser('Member').id };
    const resource = { runtime: 'codex' as const, sessionKey: 'codex:fixture/空 格' };
    const grant = seed.grants.create(target, { ...resource, actions: ['messages:send'] });
    const proof = seed.grants.authorize(target, 'messages:send', resource, grant.id)!;
    lease = seed.executionLeases.reserve(proof, nodeId, first.record.id, ['messages:send']);
  } finally { await seed.close(); }
  const rows: string[] = [], diagnostics = new PerformanceDiagnostics(line => rows.push(line));
  let originalStore: HubStore | undefined;
  const openOwner = () => {
    if (ownerKind === 'worker') return new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture-vault' }, diagnostics);
    originalStore = new HubStore(file, 'fixture-vault');
    return new OriginalHubAdministrativeCommands(originalStore, diagnostics);
  };
  let owner = openOwner();
  const closeOwner = async () => { await owner.close(); await originalStore?.close(); originalStore = undefined; };
  const ports = () => {
    const leases = new AsyncHubExecutionLeases(owner), issuers = new AsyncHubExecutionIssuers(owner, local);
    const sync = new HubExecutionSync(leases, hubId, l => issuers.clientFor(l), 32, Date.now, diagnostics);
    const usage = new HubExecutionUsage(leases, hubId, sync, l => issuers.clientFor(l), Date.now, diagnostics);
    return { leases, issuers, sync, usage };
  };
  return { file, lease, rows, first, local, calls: () => calls, owner: () => owner, ports,
    rotatedToken: () => tokens.create({ label: 'Rotated fixture', delegationHubId: hubId,
      scopes: ['execution:delegate', 'messages:send'] }),
    drop: (v: boolean) => { drop = v; },
    reopen: async (mutate?: (s: HubStore) => Promise<void> | void, mutateSql?: (db: DatabaseSync) => void) => {
      await closeOwner();
      if (mutate) { const s = new HubStore(file, 'fixture-vault'); try { await mutate(s); } finally { await s.close(); } }
      if (mutateSql) { const db = new DatabaseSync(file); try { mutateSql(db); } finally { db.close(); } }
      owner = openOwner();
    },
    close: async () => {
      await closeOwner();
      if (server) { if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
      remoteDb.close(); rmSync(root, { recursive: true, force: true });
    } };
}

test('issuer RPC allows only original lease lookup and three fixed POST checks', () => {
  const base = { id: 1, binding: 'a'.repeat(64) };
  const invalid = [{ action: 'sql', ...base }, { action: 'open', ...base, token: 'caller-token' },
    { action: 'open', ...base, origin: 'https://caller.invalid' }, { action: 'open', ...base, id: 0 },
    { action: 'check', ...base, fingerprint: 'b'.repeat(64), path: '/sessions', method: 'POST' },
    { action: 'check', ...base, fingerprint: 'b'.repeat(64), path: '/execution-grants', method: 'GET' }];
  for (const c of invalid) { assert.equal(validHubExecutionIssuerCommand(c), false); assert.equal(validHubMemberInput('executionIssuer', c), false); }
});

for (const field of ['proof', 'encrypted_token', 'nonce', 'auth_tag'] as const) {
  for (const action of ['open', 'check'] as const) test(`${action}: oversized persisted ${field} fails closed and original credential recovers after repair`, async () => {
    const f = await fixture();
    try {
      const binding = executionIssuerBinding(f.lease);
      const opened = await f.owner().command('executionIssuer', { action: 'open', id: f.lease.id, binding });
      assert.equal(opened.action, 'open');
      const command: HubExecutionIssuerCommand = action === 'open' ? { action, id: f.lease.id, binding }
        : { action, id: f.lease.id, binding, fingerprint: opened.fingerprint, path: '/execution-grants', method: 'POST' };
      let original = '', key = '';
      const table = field === 'proof' ? 'hub_execution_leases' : 'env_credentials';
      const where = field === 'proof' ? 'id=?' : 'connection_id=? AND owner_user_id=?';
      const args = () => field === 'proof' ? [f.lease.id] : [key, '\0execution-issuer'];
      await f.reopen(undefined, db => {
        if (field !== 'proof') key = db.prepare('SELECT id FROM hub_execution_issuers WHERE authority_version=?')
          .get(f.lease.proof.nodeVersion)!.id as string;
        original = db.prepare(`SELECT ${field} AS value FROM ${table} WHERE ${where}`).get(...args())!.value as string;
        // JSON and base64 decoders accept whitespace: reject on persisted bytes,
        // before parse/decrypt, not only after materializing an otherwise valid value.
        db.prepare(`UPDATE ${table} SET ${field}=? WHERE ${where}`).run(original + ' '.repeat(65_536), ...args());
      });
      const calls = f.calls();
      await assert.rejects(f.owner().command('executionIssuer', command));
      assert.equal(f.calls(), calls, 'invalid persisted authority cannot reach HTTP');
      await f.reopen(undefined, db => {
        assert.equal(db.prepare(`SELECT length(CAST(${field} AS BLOB)) AS n FROM ${table} WHERE ${where}`)
          .get(...args())!.n, Buffer.byteLength(original) + 65_536, 'rejection must not repair or truncate durable authority');
        db.prepare(`UPDATE ${table} SET ${field}=? WHERE ${where}`).run(original, ...args());
      });
      const recovered = await f.owner().command('executionIssuer', command);
      assert.equal(recovered.action, action);
      assert.equal(recovered.fingerprint, opened.fingerprint, 'repair restores exact original authority');
      assert.equal(f.calls(), calls, 'lookup recovery never replays transport');
      assert.doesNotMatch(f.rows.join('\n'), new RegExp(f.first.token));
    } finally { await f.close(); }
  });
}

for (const action of ['open', 'check'] as const) test(`${action}: oversized internal issuer credential key rejects without replacing authority`, async () => {
  const f = await fixture();
  try {
    const binding = executionIssuerBinding(f.lease);
    const opened = await f.owner().command('executionIssuer', { action: 'open', id: f.lease.id, binding });
    const command: HubExecutionIssuerCommand = action === 'open' ? { action, id: f.lease.id, binding }
      : { action, id: f.lease.id, binding, fingerprint: opened.fingerprint, path: '/execution-grants/revoke', method: 'POST' };
    let original = '';
    const padding = 'x'.repeat(65_536);
    await f.reopen(undefined, db => {
      original = db.prepare('SELECT id FROM hub_execution_issuers WHERE authority_version=?')
        .get(f.lease.proof.nodeVersion)!.id as string;
      db.prepare('UPDATE hub_execution_issuers SET id=? WHERE id=?').run(original + padding, original);
      db.prepare('UPDATE env_credentials SET connection_id=? WHERE connection_id=? AND owner_user_id=?')
        .run(original + padding, original, '\0execution-issuer');
    });
    const calls = f.calls();
    await assert.rejects(f.owner().command('executionIssuer', command));
    await f.reopen(undefined, db => {
      assert.ok(db.prepare('SELECT 1 FROM hub_execution_issuers WHERE id=?').get(original + padding));
      db.prepare('UPDATE hub_execution_issuers SET id=? WHERE id=?').run(original, original + padding);
      db.prepare('UPDATE env_credentials SET connection_id=? WHERE connection_id=? AND owner_user_id=?')
        .run(original, original + padding, '\0execution-issuer');
    });
    const recovered = await f.owner().command('executionIssuer', command);
    assert.equal(recovered.fingerprint, opened.fingerprint);
    assert.equal(f.calls(), calls, 'neither rejection nor lookup recovery issues HTTP');
  } finally { await f.close(); }
});

for (const transport of ['local','remote'] as const) test(`${transport}: single owner issues and revokes with asynchronous original credential reads`, async () => {
  const f = await fixture(transport), p = f.ports();
  try {
    const active = await p.sync.synchronize(f.lease.id);
    assert.equal(active.state, 'active'); assert.ok(active.ref);
    assert.equal(executionIssuerBinding(active), executionIssuerBinding(f.lease));
    await p.usage.reconcile();
    await p.leases.revoke(active.id);
    assert.equal((await p.sync.synchronize(active.id)).state, 'revoked');
    await p.usage.close(); await p.sync.close(); await f.reopen();
    assert.equal((await f.ports().leases.get(active.id))!.state, 'revoked');
    assert.doesNotMatch(f.rows.join('\n'), new RegExp(f.first.token));
    assert.doesNotMatch(f.rows.join('\n'), /fixture\/空|connector\.internal|fingerprint|binding/);
  } finally { await p.usage.close(); await p.sync.close(); await f.close(); }
});

for (const transport of ['local', 'remote'] as const) test(`${transport}: persisted usage demand probes original issuer and acknowledges quiet CAS through one owner`, async () => {
  const f = await fixture(transport), first = f.ports();
  let next: ReturnType<typeof f.ports> | undefined;
  try {
    const active = await first.sync.synchronize(f.lease.id);
    await first.usage.close(); await first.sync.close();
    // Fixture mutation is exclusively between owners, never a second live DB
    // connection. Reopening must retain the exact original lease/issuer pair.
    await f.reopen(undefined, db => { db.prepare('UPDATE hub_execution_leases SET usage_pending=1,usage_version=usage_version+1,usage_after=0 WHERE id=?').run(active.id); });
    next = f.ports(); const before = f.calls();
    assert.deepEqual(await next.usage.reconcile(), { examined: 1 });
    assert.equal(f.calls(), before + 1, 'one actual Connector usage probe');
    assert.deepEqual(await next.usage.reconcile(), { examined: 0 });
    assert.equal(f.calls(), before + 1, 'acknowledged quiet demand is not replayed');
    const retained = await next.leases.get(active.id);
    assert.equal(retained?.state, 'active'); assert.deepEqual(retained?.ref, active.ref);
  } finally {
    await next?.usage.close(); await next?.sync.close();
    await first.usage.close(); await first.sync.close(); await f.close();
  }
});

test('a copied lease with substituted proof cannot select credentials or reach transport', async () => {
  const f = await fixture(), p = f.ports();
  try {
    const before = f.calls();
    for (const lease of [{ ...f.lease, issuerId: 'other' }, { ...f.lease, nodeId: 'node_' + randomUUID() },
      { ...f.lease, proof: { ...f.lease.proof, userId: 'other' } },
      { ...f.lease, proof: { ...f.lease.proof, resource: { ...f.lease.proof.resource, sessionKey: 'codex:other' } } }]) {
      await assert.rejects(p.issuers.clientFor(lease));
    }
    assert.equal(f.calls(), before);
  } finally { await p.usage.close(); await p.sync.close(); await f.close(); }
});

test('pinned client refuses arbitrary paths and historical issue/usage after authority rotation, but can revoke', async () => {
  const f = await fixture(), p = f.ports();
  try {
    const active = await p.sync.synchronize(f.lease.id), client = await p.issuers.clientFor(active);
    const before = f.calls();
    for (const [path, method] of [['/sessions','POST'],['/execution-grants','GET'],['/execution-grants?x=1','POST']] as const) {
      await assert.rejects(client.json(path!, { method }));
    }
    assert.equal(f.calls(), before);
    await p.usage.close(); await p.sync.close();
    await f.reopen(s => { s.upsertConnection({ ...s.getConnection('node')!, status: 'disabled' }); });
    const original = await f.ports().issuers.clientFor(active);
    for (const path of ['/execution-grants','/execution-grants/usage']) await assert.rejects(original.json(path, { method: 'POST', body: '{}' }));
    assert.equal(f.calls(), before);
    const next = f.ports();
    try { assert.equal((await next.sync.synchronize(active.id)).state, 'revoked'); }
    finally { await next.usage.close(); await next.sync.close(); }
  } finally { await p.usage.close(); await p.sync.close(); await f.close(); }
});

test('lost revocation ACK retains durable intent and restart uses the same old issuer without command replay', async () => {
  const f = await fixture(), p = f.ports();
  try {
    const active = await p.sync.synchronize(f.lease.id);
    await p.leases.revoke(active.id); f.drop(true);
    await assert.rejects(p.sync.synchronize(active.id));
    assert.equal((await p.leases.get(active.id))!.state, 'revoking');
    await p.usage.close(); await p.sync.close(); await f.reopen(); f.drop(false);
    const next = f.ports();
    try { assert.equal((await next.sync.synchronize(active.id)).state, 'revoked'); }
    finally { await next.usage.close(); await next.sync.close(); }
  } finally { await p.usage.close(); await p.sync.close(); await f.close(); }
});

for (const transport of ['local', 'remote'] as const) test(`${transport}: issuer rotation refuses old issue/usage, preserves original revocation credential across restart`, async () => {
  const f = await fixture(transport), p = f.ports();
  let next: ReturnType<typeof f.ports> | undefined;
  try {
    const active = await p.sync.synchronize(f.lease.id), binding = executionIssuerBinding(active);
    const before = await f.owner().command('executionIssuer', { action: 'open', id: active.id, binding });
    const rotated = f.rotatedToken();
    await p.usage.close(); await p.sync.close();
    await f.reopen(async s => { await s.executionIssuers.configure('default', 'node', rotated.token, () => {}, f.local); });
    next = f.ports();
    const historical = await next.issuers.clientFor(active), calls = f.calls();
    for (const path of ['/execution-grants', '/execution-grants/usage']) {
      await assert.rejects(historical.json(path, { method: 'POST', body: '{}' }));
    }
    assert.equal(f.calls(), calls, 'stale issuer cannot reach transport');
    const after = await f.owner().command('executionIssuer', { action: 'open', id: active.id, binding });
    assert.deepEqual(after, before, 'old lease never selects replacement credential');
    assert.equal((await next.sync.synchronize(active.id)).state, 'revoked');
    assert.equal(f.calls(), calls + 1, 'only original durable revocation is sent');
    assert.doesNotMatch(f.rows.join('\n'), new RegExp(rotated.token));
  } finally {
    await next?.usage.close(); await next?.sync.close();
    await p.usage.close(); await p.sync.close(); await f.close();
  }
});

test('worker replies correlate to original lease, binding and credential fingerprint', async () => {
  const f = await fixture();
  try {
    const c: HubExecutionIssuerCommand = { action: 'open', id: f.lease.id, binding: executionIssuerBinding(f.lease) };
    const r = await f.owner().command('executionIssuer', c);
    assert.ok(validHubExecutionIssuerReply(c, r));
    assert.equal(validHubExecutionIssuerReply({ ...c, id: c.id + 1 }, r), false);
    assert.equal(validHubExecutionIssuerReply({ ...c, binding: 'f'.repeat(64) }, r), false);
    assert.ok(r.action === 'open');
    const sentinel = { ...r.snapshot, kind: 'local', origin: 'local://aod-connector' };
    assert.equal(validExecutionIssuerSnapshot(sentinel), true);
    for (const invalid of [
      { ...sentinel, kind: 'remote' },
      ...['local://other', 'local://aod-connector/', 'local://aod-connector?proxy=1',
        'file:///tmp/connector', ['https://', 'user', ':', 'secret', '@', 'connector.invalid'].join('')].map(origin => ({ ...sentinel, origin })),
    ]) assert.equal(validExecutionIssuerSnapshot(invalid), false);
    assert.equal(validHubExecutionIssuerReply(c, { ...r, snapshot: { ...r.snapshot, token: 'substitution' } }), false);
    const check = { action: 'check' as const, id: c.id, binding: c.binding, fingerprint: r.fingerprint,
      path: '/execution-grants' as const, method: 'POST' as const };
    const ack = await f.owner().command('executionIssuer', check);
    assert.ok(validHubExecutionIssuerReply(check, ack));
    assert.equal(validHubExecutionIssuerReply({ ...check, fingerprint: 'f'.repeat(64) }, ack), false);
  } finally { await f.close(); }
});

test('issuer adapter refuses unrelated open/check replies before any transport', async () => {
  const f = await fixture();
  try {
    const command: HubExecutionIssuerCommand = { action: 'open', id: f.lease.id, binding: executionIssuerBinding(f.lease) };
    const result = await f.owner().command('executionIssuer', command);
    assert.equal(result.action, 'open');
    const before = f.calls();
    for (const bad of [{ ...result, id: result.id + 1 }, { ...result, binding: 'f'.repeat(64) },
      { ...result, fingerprint: 'f'.repeat(64) }]) {
      const adapter = new AsyncHubExecutionIssuers({ command: async () => bad as never }, f.local);
      await assert.rejects(adapter.clientFor(f.lease), /reply mismatch/);
    }
    const adapter = new AsyncHubExecutionIssuers({ command: async (_kind, input) => {
      if ('action' in input && input.action === 'open') return result as never;
      return { action: 'check', id: command.id + 1, binding: command.binding,
        fingerprint: result.fingerprint, allowed: true } as never;
    } }, f.local);
    const client = await adapter.clientFor(f.lease);
    await assert.rejects(client.json('/execution-grants/usage', { method: 'POST', body: '{}' }));
    assert.equal(f.calls(), before);
  } finally { await f.close(); }
});
});
