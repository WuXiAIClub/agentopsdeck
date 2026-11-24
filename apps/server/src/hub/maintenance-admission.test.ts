import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { loadConfig } from '../config.js';
import { createConnectorRuntime } from '../connector/runtime.js';
import { registerHubRoutes } from '../routes/hub.js';
import { createConnectorClientResolver } from './connector-client.js';
import { HubStore } from './hub-store.js';

function fixture(context: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-hub-admission-'));
  let hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic-vault');
  const member = hub.createUser('synthetic member');
  const owners = ['default', member.id];
  const nodes = ['first', 'second'].map(name => {
    const root = join(directory, name);
    const config = loadConfig({ AOD_SERVER_ROLE: 'connector', AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false',
      AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'connector.sqlite'), AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
      AOD_SESSION_TITLES_FILE: join(root, 'titles.json'), AOD_QUEUE_FILE: join(root, 'queue.json'),
      AOD_MIRROR_OUTBOX_FILE: join(root, 'mirror.json'), AOD_ARTIFACT_INDEX_FILE: join(root, 'artifacts.json'),
      AOD_CONNECTOR_UPDATE_STATE_FILE: join(root, 'update.json'), AOD_CONNECTOR_UPDATE_ENABLED: 'false' });
    const tokens = new ConnectorTokenStore(config.connector.tokenFile);
    const credentials = owners.map(owner => tokens.create({ label: `synthetic ${owner}`, scopes: ['connector:update'] }).token);
    const actors = owners.map(owner => tokens.create({ label: `synthetic messages ${owner}`, scopes: ['messages:send', 'messages:read'] }).record.id);
    const node = { name, config, credentials, actors, runtime: createConnectorRuntime(config, () => false) };
    node.runtime.app.post('/synthetic-write', response => response.text('written'));
    for (const [index, ownerUserId] of owners.entries()) {
      hub.upsertConnection({ id: name, ownerUserId, label: name, kind: 'remote', connectorUrl: `http://${name}.test`, credentialToken: 'synthetic-daily' });
      hub.pinConnectionNode(name, ownerUserId, hub.connectionAuthority(name, ownerUserId)!, node.runtime.connectorUsers.nodeId);
      hub.updateMaintenanceCredential(name, credentials[index]!, ownerUserId);
    }
    return node;
  });
  const calls: Array<{ node: string; method: string; path: string }> = [];
  let loseReply = false, unavailable = false, revoked = false;
  let afterReply = () => {};
  context.mock.method(globalThis, 'fetch', async (input: Request) => {
    assert.ok(input instanceof Request);
    const url = new URL(input.url);
    const node = nodes.find(candidate => url.hostname === `${candidate.name}.test`);
    assert.ok(node, 'only synthetic Connector transport is allowed');
    calls.push({ node: node.name, method: input.method, path: url.pathname });
    if (unavailable && input.method === 'GET') throw new Error('synthetic original receipt unavailable');
    const response = await node.runtime.app.fetch(input);
    afterReply();
    if (loseReply && input.method === 'POST') {
      await response.body?.cancel();
      throw new Error('synthetic reply loss after durable maintenance');
    }
    return response;
  });
  let app = new Hono();
  const config = loadConfig({ AOD_SERVER_ROLE: 'hub', AOD_HUB_DATABASE_FILE: join(directory, 'hub.sqlite'),
    AOD_HUB_VAULT_SECRET: 'synthetic-vault', AOD_LOCAL_OPENCLAW_CLI: 'false' });
  const register = () => registerHubRoutes(app, { config, hubStore: hub, connectorClient: createConnectorClientResolver(hub),
    normalizeError: () => 'synthetic failure', principal: request => revoked ? undefined
      : { userId: request.headers.get('x-synthetic-member') ? member.id : 'default', admin: !request.headers.get('x-synthetic-member') } });
  let routes = register();
  const restartHub = async () => {
    routes?.close();
    await Promise.all([hub.maintenanceCommands.close(), hub.executionIssuers.close()]);
    hub.close();
    hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic-vault');
    app = new Hono();
    routes = register();
  };
  context.after(async () => {
    routes?.close();
    await hub.maintenanceCommands.close();
    hub.close();
    await Promise.all(nodes.map(node => node.runtime.close()));
    rmSync(directory, { recursive: true, force: true });
  });
  const request = (node: string, suffix: string, body?: unknown, asMember = false) => app.request(`/api/hub/v1/connections/${node}/maintenance/${suffix}`,
    { headers: asMember ? { 'x-synthetic-member': '1' } : {}, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  return { nodes, get hub() { return hub; }, calls, request, member, restartHub, setLoseReply(value: boolean) { loseReply = value; },
    setUnavailable(value: boolean) { unavailable = value; }, revoke() { revoked = true; }, afterReply(callback: () => void) { afterReply = callback; } };
}

test('Hub admission composes two-user/two-node fences with both queue start gates and restart recovery', async context => {
  const setup = fixture(context);
  const [first, second] = setup.nodes;
  const response = await setup.request('first', 'commands/pause', { idempotencyKey: 'pause-original' });
  assert.equal(response.status, 200);
  const paused = await response.json();
  assert.equal(paused.state, 'paused');
  assert.equal(paused.boundary, 'admission_only');
  assert.equal(paused.nativeQuiescent, false);
  assert.equal((await setup.request('first', 'commands/pause/pause-original', undefined, true)).status, 404);
  assert.equal((await first!.runtime.app.request('/synthetic-write', { method: 'POST' })).status, 503);
  assert.equal((await second!.runtime.app.request('/synthetic-write', { method: 'POST' })).status, 200);
  await first!.runtime.close();
  first!.runtime = createConnectorRuntime(first!.config, () => false);
  first!.runtime.app.post('/synthetic-write', response => response.text('written'));
  for (const runtime of ['openclaw', 'codex'] as const) {
    const sessionKey = runtime === 'codex' ? 'codex:synthetic' : 'agent:synthetic';
    for (const node of setup.nodes) await node.runtime.connectorUsers.turns.enqueueAsync(runtime, { id: runtime, sessionKey, createdAt: 1, payload: {} });
    assert.equal(first!.runtime.connectorUsers.turns.start(runtime, sessionKey, runtime), false);
    assert.equal(second!.runtime.connectorUsers.turns.start(runtime, sessionKey, runtime), true);
  }
  const foreign = await setup.request('first', 'commands/resume', { idempotencyKey: 'foreign-resume', fenceId: paused.fenceId }, true);
  assert.equal(foreign.status, 202);
  assert.equal((await foreign.json()).command.state, 'outcome_unknown');
  assert.equal((await (await setup.request('first', 'status')).json()).state, 'paused');
  const resumed = await setup.request('first', 'commands/resume', { idempotencyKey: 'resume-original', fenceId: paused.fenceId });
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).state, 'released');
  assert.equal((await first!.runtime.app.request('/synthetic-write', { method: 'POST' })).status, 200);
  const posts = setup.calls.filter(call => call.method === 'POST').length;
  assert.equal((await setup.request('first', 'commands/pause', { idempotencyKey: 'pause-original' })).status, 200);
  assert.equal(setup.calls.filter(call => call.method === 'POST').length, posts);
  assert.equal((await (await setup.request('first', 'status')).json()).state, 'released');
});

test('Hub admission lost pause reply remains query-only at original node after alias retargeting', async context => {
  const setup = fixture(context);
  setup.setLoseReply(true); setup.setUnavailable(true);
  const response = await setup.request('first', 'commands/pause', { idempotencyKey: 'lost-original' });
  assert.equal(response.status, 202);
  const second = setup.nodes[1]!;
  setup.hub.upsertConnection({ id: 'first', label: 'retargeted', kind: 'remote', connectorUrl: 'http://second.test' });
  assert.throws(() => setup.hub.pinConnectionNode('first', 'default', setup.hub.connectionAuthority('first')!, second.runtime.connectorUsers.nodeId), /identity or authorization changed/);
  setup.hub.updateMaintenanceCredential('first', second.credentials[0]!);
  setup.setLoseReply(false); setup.setUnavailable(false);
  const recovered = await setup.request('first', 'commands/pause/lost-original');
  assert.equal(recovered.status, 200);
  const { command } = await recovered.json();
  assert.equal(command.state, 'accepted');
  assert.equal(command.result.body.state, 'paused');
  assert.equal(setup.calls.at(-1)?.node, 'first');
  assert.equal((await setup.request('first', 'commands/pause', { idempotencyKey: 'lost-original' })).status, 200);
  assert.equal(setup.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal((await setup.request('first', 'status')).status, 502);
  assert.equal((await second.runtime.app.request('/synthetic-write', { method: 'POST' })).status, 200);
  assert.equal((await setup.nodes[0]!.runtime.app.request('/synthetic-write', { method: 'POST' })).status, 503);
});

test('Hub admission status requires current maintenance authority and withholds revoked login replies', async context => {
  const setup = fixture(context);
  setup.hub.updateMaintenanceCredential('first', '');
  assert.equal((await setup.request('first', 'status')).status, 401);
  assert.equal(setup.calls.length, 0);
  setup.hub.updateMaintenanceCredential('first', setup.nodes[0]!.credentials[0]!);
  const status = await setup.request('first', 'status');
  assert.equal(status.status, 200);
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.equal((await status.json()).nativeQuiescent, false);
  setup.afterReply(setup.revoke);
  const revoked = await setup.request('first', 'status');
  assert.equal(revoked.status, 401);
  assert.equal(JSON.stringify(await revoked.json()).includes('nativeQuiescent'), false);
});

for (const asMember of [false, true]) {
  test(`two-node writer-fenced restart retains both actors and runtimes during lost maintenance recovery (member=${asMember})`, async context => {
    const setup = fixture(context);
    const first = setup.nodes[0]!, second = setup.nodes[1]!;
    const identities = setup.nodes.map(node => node.runtime.connectorUsers.nodeId);
    assert.notEqual(identities[0], identities[1]);
    const originals = await Promise.all(setup.nodes.flatMap(node => node.actors.flatMap(actorId =>
      (['openclaw', 'codex'] as const).map(async runtime => {
        const users = node.runtime.connectorUsers;
        const sessionKey = runtime === 'codex' ? 'codex:synthetic-original' : 'agent:synthetic-original';
        const scope = JSON.stringify([actorId, sessionKey]);
        const text = `${node.name}/${actorId}/${runtime}`;
        const payload = runtime === 'codex' ? { actorId, text, images: [] }
          : { actorId, message: text, media: [], deliveryMode: 'web-only' };
        const nativeId = `${node.name}/${actorId}/${runtime}`;
        await users.commands.claimAsync(scope, 'accepted-original', payload);
        await users.turns.enqueueAsync(runtime, { id: nativeId, sessionKey, createdAt: 1, payload },
          users.commands.queueCommit(scope, 'accepted-original', { status: 200,
            body: { runId: nativeId, idempotencyKey: nativeId, status: 'queued' } }));
        const unknown = (await users.commands.claimAsync(scope, 'unknown-original', { message: 'uncertain-original' })).receipt;
        return { node, runtime, sessionKey, scope, payload, nativeId, unknown,
          accepted: users.commands.get(scope, 'accepted-original') };
      }))));
    assert.equal(originals.length, 8);
    for (const original of originals) {
      assert.equal(original.accepted?.state, 'accepted');
      assert.equal(original.unknown.state, 'outcome_unknown');
    }
    setup.setLoseReply(true);
    setup.setUnavailable(true);
    const response = await setup.request('first', 'commands/pause', { idempotencyKey: 'lost-pause' }, asMember);
    assert.equal(response.status, 202);
    const unresolved = (await response.json()).command;
    assert.equal(unresolved.state, 'outcome_unknown');
    await setup.restartHub();
    const queues = setup.nodes.map(node => (['openclaw', 'codex'] as const)
      .map(runtime => node.runtime.connectorUsers.turns.list(runtime)));
    for (const node of setup.nodes) {
      await node.runtime.close();
      const incompatible = new DatabaseSync(node.config.connector.usersDatabaseFile);
      try {
        assert.throws(() => incompatible.prepare(`INSERT INTO connector_users (id, label, created_at, updated_at)
          VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`).run('default', 'Synthetic legacy bootstrap', 1, 1),
        /agentopsdeck_connector_writer_epoch/);
      } finally { incompatible.close(); }
      node.runtime = createConnectorRuntime(node.config, () => false);
      node.runtime.app.post('/synthetic-write', reply => reply.text('written'));
    }
    assert.deepEqual(setup.nodes.map(node => node.runtime.connectorUsers.nodeId), identities);
    assert.deepEqual(setup.nodes.map(node => (['openclaw', 'codex'] as const)
      .map(runtime => node.runtime.connectorUsers.turns.list(runtime))), queues);
    for (const original of originals) {
      const users = original.node.runtime.connectorUsers;
      assert.deepEqual(users.commands.get(original.scope, 'accepted-original'), original.accepted);
      assert.deepEqual(users.commands.get(original.scope, 'unknown-original'), original.unknown);
      assert.equal(users.commands.claim(original.scope, 'accepted-original', original.payload).fresh, false);
      assert.equal(users.commands.claim(original.scope, 'unknown-original', { message: 'uncertain-original' }).fresh, false);
      assert.equal(users.turns.head(original.runtime, original.sessionKey)?.state, 'queued');
    }
    setup.setLoseReply(false);
    setup.setUnavailable(false);
    const posts = setup.calls.filter(call => call.method === 'POST').length;
    assert.equal((await setup.request('first', 'commands/pause/lost-pause', undefined, !asMember)).status, 404);
    assert.equal((await setup.request('second', 'commands/pause/lost-pause', undefined, asMember)).status, 404);
    const recovered = await setup.request('first', 'commands/pause/lost-pause', undefined, asMember);
    assert.equal(recovered.status, 200);
    const receipt = (await recovered.json()).command;
    assert.equal(receipt.id, unresolved.id);
    assert.equal(receipt.state, 'accepted');
    assert.equal(receipt.result.body.boundary, 'admission_only');
    assert.equal(receipt.result.body.nativeQuiescent, false);
    assert.equal(setup.calls.filter(call => call.method === 'POST').length, posts);
    assert.equal((await first.runtime.app.request('/synthetic-write', { method: 'POST' })).status, 503);
    assert.equal((await second.runtime.app.request('/synthetic-write', { method: 'POST' })).status, 200);
    for (const runtime of ['openclaw', 'codex'] as const) {
      const original = originals.find(entry => entry.node === first && entry.runtime === runtime)!;
      assert.equal(first.runtime.connectorUsers.turns.start(runtime, original.sessionKey, original.nativeId), false);
    }
    const resumed = await setup.request('first', 'commands/resume', {
      idempotencyKey: 'resume-original', fenceId: receipt.result.body.fenceId,
    }, asMember);
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json()).state, 'released');
    await setup.restartHub();
    assert.equal((await setup.request('first', 'commands/pause', { idempotencyKey: 'lost-pause' }, asMember)).status, 200);
    assert.equal(setup.calls.filter(call => call.method === 'POST').length, posts + 1);
    assert.equal((await (await setup.request('first', 'status', undefined, asMember)).json()).state, 'released');
    assert.deepEqual(setup.nodes.map(node => (['openclaw', 'codex'] as const)
      .map(runtime => node.runtime.connectorUsers.turns.list(runtime))), queues);
  });
}
