import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createApplication } from './application.js';
import { loadConfig } from './config.js';
import { HubStore } from './hub/hub-store.js';
import { HubExecutionIssuers } from './hub/execution-issuers.js';
import { HubExecutionSync } from './hub/execution-sync.js';
import { OriginalHubAdministrativeCommands } from './hub/original-administrative-commands.js';
import { ConnectorTokenStore } from './auth/connector-token.js';
import { ExecutionGrants } from './connector/execution-grants.js';
import { registerExecutionGrantRoutes } from './connector/execution-grant-http.js';

for (const backend of ['json', 'sqlite'] as const) test(`application execution ${backend}: fixed ports, refusal, durable restart recovery, no legacy fallback`, { timeout: 20_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'application-execution-'));
  const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: 'isolated-admin',
    AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false',
    AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'isolated-vault',
    AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
    AOD_SESSION_TITLES_FILE: join(root, 'titles.json'),
    ...(backend === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}) });
  const seed = new HubStore(config.hub.databaseFile, config.hub.vaultSecret);
  const remoteDb = new DatabaseSync(':memory:');
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'));
  const first = tokens.create({ label: 'Fixture', delegationHubId: seed.identities.hubId,
    scopes: ['execution:delegate', 'messages:send'] });
  const nodeId = 'node_' + randomUUID(), remote = new Hono();
  registerExecutionGrantRoutes(remote, { nodeId, tokens, grants: new ExecutionGrants(remoteDb, id => !!tokens.delegationHubId(id)) });
  const paths: string[] = [];
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch: request => {
    const path = new URL(request.url).pathname; paths.push(path);
    assert.ok(!/messages|resume|interrupt|terminate/.test(path), 'recovery must not resend a user command');
    return remote.fetch(request);
  } });
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  let application: ReturnType<typeof createApplication> | undefined;
  let seedClosed = false;
  try {
    seed.upsertConnection({ id: 'node', kind: 'remote', label: 'Fixture',
      connectorUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
    seed.pinConnectionNode('node', 'default', seed.connectionAuthority('node')!, nodeId);
    await seed.executionIssuers.configure('default', 'node', first.token, () => {});
    const target = { ownerUserId: 'default', connectionId: 'node', userId: seed.createUser('Recipient').id };
    const resource = { runtime: 'codex' as const, sessionKey: 'codex:original-session' };
    const grant = seed.grants.create(target, { ...resource, actions: ['messages:send'] });
    const proof = seed.grants.authorize(target, 'messages:send', resource, grant.id)!;
    const lease = seed.executionLeases.reserve(proof, nodeId, first.record.id, ['messages:send']);
    const sync = new HubExecutionSync(seed.executionLeases, seed.identities.hubId, l => seed.executionIssuers.clientFor(l));
    try { assert.equal((await sync.synchronize(lease.id)).state, 'active'); }
    finally { await sync.close(); }
    seed.executionLeases.revoke(lease.id);
    await seed.close(); seedClosed = true;
    paths.length = 0;
    let rejectOwner = true, observe!: () => void;
    let observed = new Promise<void>(resolve => { observe = resolve; });
    const counts = { leases: 0, open: 0, check: 0 };
    const original = OriginalHubAdministrativeCommands.prototype.command;
    t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
      if (kind === 'executionLease') counts.leases++;
      if (kind === 'executionIssuer') {
        const command = input as { action: string };
        if (command.action === 'open') counts.open++; else counts.check++;
        if (rejectOwner) { observe(); return Promise.reject(Error('PRIVATE owner refusal')); }
      }
      const result = original.call(this, kind, input);
      if (kind === 'executionLease' && (input as { action: string }).action === 'acknowledgeRevoke') {
        return result.then(value => { observe(); return value; });
      }
      return result;
    });
    t.mock.method(HubExecutionIssuers.prototype, 'clientFor', () => { throw Error('legacy issuer fallback forbidden'); });
    application = createApplication(config);
    await observed;
    await application.close(); application = undefined;
    assert.equal(paths.length, 0, 'owner refusal cannot reach Connector');
    const inspect = new HubStore(config.hub.databaseFile, config.hub.vaultSecret);
    try { assert.equal(inspect.executionLeases.get(lease.id)?.state, 'revoking'); }
    finally { await inspect.close(); }
    rejectOwner = false; observed = new Promise<void>(resolve => { observe = resolve; });
    application = createApplication(config);
    await observed;
    await application.close(); application = undefined;
    assert.ok(counts.leases > 0 && counts.open >= 2 && counts.check >= 1);
    assert.equal(paths.filter(path => path.endsWith('/execution-grants/revoke')).length, 1);
    assert.equal(paths.length, 1, 'only original durable revocation is recovered');
    const reopened = new HubStore(config.hub.databaseFile, config.hub.vaultSecret);
    try { assert.equal(reopened.executionLeases.get(lease.id)?.state, 'revoked'); }
    finally { await reopened.close(); }
  } finally {
    await application?.close(); if (!seedClosed) await seed.close();
    if ('closeAllConnections' in server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    remoteDb.close(); rmSync(root, { recursive: true, force: true });
  }
});
