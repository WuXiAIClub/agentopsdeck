import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { createHubConnectorReadServices } from './connector-read-services.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { NODE_ID_HEADER, EXPECTED_NODE_HEADER } from '../connector/node-identity.js';
import { registerAsyncHubRoutes } from '../routes/hub-async.js';
import { WeixinService } from './weixin-service.js';
import { encodeHubSessionId } from './session-id.js';
import { loadConfig } from '../config.js';

/** Complete async production assembly, but simulated Connector HTTP responses.
 * Distinct nodes and credentials must not collapse same-name native resources. */
async function fixture(t: TestContext, mode: 'original' | 'worker') {
  const root = mkdtempSync(join(tmpdir(), 'multi-node-collision-'));
  const file = join(root, 'hub.sqlite'), seed = new HubStore(file, 'multi-node');
  const member = seed.createUser('Owner'), key = seed.identities.issueKey(member.id);
  const hubId = seed.identities.hubId, native = randomUUID(), remoteKey = `codex:${native}`;
  const scope = seed.identities.recoveryScope({ userId: member.id, admin: false });
  const targets = ['left', 'right'].map(id => ({ id, node: `node_${randomUUID()}`,
    origin: `http://${id}.connector.invalid`, token: `PRIVATE_${id}_CONNECTOR_TOKEN`,
    sessionKey: encodeHubSessionId(id, remoteKey) }));
  for (const target of targets) {
    seed.upsertConnection({ id: target.id, ownerUserId: member.id, label: 'Twin Connector',
      connectorUrl: target.origin, credentialToken: target.token });
    seed.pinConnectionNode(target.id, member.id, seed.connectionAuthority(target.id, member.id)!, target.node);
  }
  await seed.close();
  const calls: string[] = [], diagnostics = new PerformanceDiagnostics(() => {});
  const behavior = { wrongNode: false };
  t.mock.method(WeixinService.prototype, 'startWorker', () => {});
  t.mock.method(globalThis, 'fetch', async (raw: Request | string | URL, init?: RequestInit) => {
    const request = raw instanceof Request ? raw : new Request(raw, init), url = new URL(request.url);
    const target = targets.find(value => value.origin === url.origin);
    assert.ok(target, 'Only the disposable Connector endpoints may be used');
    assert.equal(url.pathname, '/api/connector/v1/sessions/state');
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.get(EXPECTED_NODE_HEADER), target.node);
    assert.equal(request.headers.get('authorization'), `Bearer ${target.token}`);
    calls.push(target.id);
    return Response.json({ groups: [{ agentId: 'codex', sessions: [{ sessionKey: remoteKey,
      agentId: 'codex', title: 'Same native title', status: 'idle', lastActiveAt: 7 }] }] },
    { headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max),
      [NODE_ID_HEADER]: behavior.wrongNode && target.id === 'right' ? targets[0]!.node : target.node } });
  });
  const mount = async () => {
    const metadata = new HubStore(mode === 'original' ? file : join(root, 'metadata.sqlite'), 'multi-node');
    const owner = mode === 'original' ? new OriginalHubAdministrativeCommands(metadata, diagnostics)
      : new AsyncHubMemberOwner({ file, encryptionSecret: 'multi-node' }, diagnostics);
    const services = createHubAdministrativeServices(owner, diagnostics);
    const reads = createHubConnectorReadServices(owner, undefined, diagnostics);
    const app = new Hono();
    const routes = await registerAsyncHubRoutes(app, {
      config: loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub' }), hubId,
      administrative: services, reads, eventFeed: () => { throw Error('NO_EVENT_SUBSCRIPTION'); },
      normalizeError: () => 'unavailable',
    });
    await routes.activate();
    return { app, dispose: async () => {
      await routes.close(); await services.close(); await reads.close(); await owner.close(); await metadata.close();
    } };
  };
  let current = await mount();
  t.after(async () => { await current.dispose(); rmSync(root, { recursive: true, force: true }); });
  const request = async (path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => {
    const response = await current.app.request(path, { method,
      headers: { 'x-agentopsdeck-key': key.token, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('set-cookie'), null);
    const text = await response.text();
    for (const target of targets) assert.equal(text.includes(target.token), false);
    return { status: response.status, body: JSON.parse(text) };
  };
  return { targets, native, scope, calls, behavior, request,
    reopen: async () => { await current.dispose(); current = await mount(); } };
}

for (const mode of ['original', 'worker'] as const) {
  test(`multi-node ${mode}: same native ID/title retain exact node, credential and preference after reopen`, async t => {
    const f = await fixture(t, mode), [left, right] = f.targets;
    assert.ok(left && right);
    for (let round = 0; round < 2; round++) {
      const state = await f.request('/api/hub/v1/sessions/state', 'GET', undefined,
        round === 0 ? {} : { 'x-agentopsdeck-recovery-scope': f.scope });
      assert.equal(state.status, 200);
      assert.deepEqual(state.body.groups.flatMap((group: { sessions: { hubSessionId: string }[] }) =>
        group.sessions.map(session => session.hubSessionId)).sort(), f.targets.map(target => target.sessionKey).sort());
      for (const target of f.targets) {
        const reference = await f.request(`/api/hub/v1/session-reference?nodeId=${target.node}&runtimeId=codex&nativeSessionKey=${f.native}`);
        assert.equal(reference.status, 200); assert.equal(reference.body.sessionKey, target.sessionKey);
      }
      const readsBeforeUnknown = f.calls.length;
      const unknown = await f.request(`/api/hub/v1/session-reference?nodeId=node_${randomUUID()}&runtimeId=codex&nativeSessionKey=${f.native}`);
      assert.equal(unknown.status, 404);
      assert.equal(f.calls.length, readsBeforeUnknown);
      if (round === 0) await f.reopen();
    }
    const archived = await f.request(`/api/sessions/${left.sessionKey}/archive`, 'PATCH', { archived: true });
    assert.equal(archived.status, 200); assert.equal(archived.body.archived, true);
    await f.reopen();
    const visible = await f.request('/api/hub/v1/sessions/state');
    assert.equal(visible.status, 200); assert.equal(visible.body.archivedCount, 1);
    assert.deepEqual(visible.body.groups.flatMap((group: { sessions: { hubSessionId: string }[] }) =>
      group.sessions.map(session => session.hubSessionId)), [right.sessionKey]);
    const all = await f.request('/api/hub/v1/sessions/state?includeArchived=1');
    assert.equal(all.status, 200);
    const sessions = all.body.groups.flatMap((group: { sessions: { hubSessionId: string; archived?: boolean }[] }) => group.sessions);
    assert.equal(sessions.find((session: { hubSessionId: string }) => session.hubSessionId === left.sessionKey).archived, true);
    assert.notEqual(sessions.find((session: { hubSessionId: string }) => session.hubSessionId === right.sessionKey).archived, true);
    assert.ok(f.calls.includes('left') && f.calls.includes('right'));
  });

  test(`multi-node ${mode}: stale account scope makes no remote read; wrong-node response never relabels a sibling`, async t => {
    const f = await fixture(t, mode);
    const stale = await f.request('/api/hub/v1/sessions/state', 'GET', undefined, { 'x-agentopsdeck-recovery-scope': 'stale' });
    assert.equal(stale.status, 409); assert.deepEqual(f.calls, []);
    f.behavior.wrongNode = true;
    const state = await f.request('/api/hub/v1/sessions/state');
    assert.equal(state.status, 200);
    assert.equal(state.body.sourceStates.find((source: { connectionId: string }) => source.connectionId === 'left').state, 'ready');
    assert.notEqual(state.body.sourceStates.find((source: { connectionId: string }) => source.connectionId === 'right').state, 'ready');
    assert.deepEqual(state.body.groups.flatMap((group: { sessions: { hubSessionId: string }[] }) =>
      group.sessions.map(session => session.hubSessionId)), [f.targets[0]!.sessionKey]);
    await f.reopen();
    const readsBeforeReference = f.calls.length;
    const reference = await f.request(`/api/hub/v1/session-reference?nodeId=${f.targets[1]!.node}&runtimeId=codex&nativeSessionKey=${f.native}`);
    // Reference translation uses the pinned local directory, not remote existence.
    assert.equal(reference.status, 200);
    assert.equal(reference.body.sessionKey, f.targets[1]!.sessionKey);
    assert.equal(f.calls.length, readsBeforeReference);
    const reopened = await f.request('/api/hub/v1/sessions/state');
    assert.equal(reopened.status, 200);
    assert.notEqual(reopened.body.sourceStates.find((source: { connectionId: string }) => source.connectionId === 'right').state, 'ready');
    assert.deepEqual(reopened.body.groups.flatMap((group: { sessions: { hubSessionId: string }[] }) =>
      group.sessions.map(session => session.hubSessionId)), [f.targets[0]!.sessionKey]);
  });
}
