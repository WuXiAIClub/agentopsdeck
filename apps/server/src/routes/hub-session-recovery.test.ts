import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { HubStore } from '../hub/hub-store.js';
import { ConnectorClient } from '../hub/connector-client.js';
import { encodeHubSessionId } from '../hub/session-id.js';
import { registerHubSessionAuxiliary } from './hub-session-auxiliary.js';

function fixture(context: test.TestContext) {
  const store = new HubStore(':memory:', 'synthetic'), user = store.createUser('Owner');
  store.upsertConnection({ id: 'environment', ownerUserId: user.id, label: 'Environment', connectorUrl: 'http://fixture.invalid' });
  const state = { calls: 0, lost: false, malformed: false, revoke: false, actor: user.id };
  const client = new ConnectorClient('http://fixture.invalid', 'synthetic-credential', async request => {
    state.calls++;
    assert.equal(request.method, 'POST');
    assert.equal(new URL(request.url).pathname, '/api/connector/v1/sessions/codex%3Asynthetic/recovery');
    assert.deepEqual(await request.json(), { expectedRunId: 'turn' });
    if (state.lost) throw new Error('Synthetic lost response');
    if (state.revoke) store.upsertConnection({ id: 'environment', ownerUserId: user.id, label: 'Environment',
      connectorUrl: 'http://fixture.invalid', status: 'disabled' });
    return Response.json(state.malformed ? { unlocked: true } : { requested: true }, { headers: { [CONNECTOR_PROTOCOL_HEADER]: '1' } });
  });
  const app = new Hono(), routes = registerHubSessionAuxiliary(app, { hubStore: store,
    principal: () => ({ userId: state.actor, admin: false }), connectorClient: () => client,
    error: context => context.json({ error: 'Recovery unavailable' }, 502) });
  context.after(async () => { await routes.close(); store.close(); });
  const request = (body: unknown = { expectedRunId: 'turn' }) => app.request(
    `/api/hub/v1/sessions/${encodeURIComponent(encodeHubSessionId('environment', 'codex:synthetic'))}/recovery`, {
      method: 'POST', body: JSON.stringify(body),
    });
  return { state, request };
}

test('owner recovery proxy preserves execution identity and returns only a scheduling receipt', async context => {
  const f = fixture(context), response = await f.request();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { requested: true });
  assert.equal(f.state.calls, 1);
});

test('a different owner cannot request recovery on this environment', async context => {
  const f = fixture(context);
  f.state.actor = 'other-user';
  assert.equal((await f.request()).status, 404);
  assert.equal(f.state.calls, 0);
});

test('lost recovery response is never retried by the proxy', async context => {
  const f = fixture(context);
  f.state.lost = true;
  assert.equal((await f.request()).status, 502);
  assert.equal(f.state.calls, 1);
});

test('a revoked environment cannot deliver a prior recovery success', async context => {
  const f = fixture(context);
  f.state.revoke = true;
  assert.equal((await f.request()).status, 403);
  assert.equal(f.state.calls, 1);
});

test('invented unlock responses are rejected rather than shown as success', async context => {
  const f = fixture(context);
  f.state.malformed = true;
  assert.equal((await f.request()).status, 502);
});

test('background terminal stop proxy enforces owner auth, validates receipt and never retries', async context => {
  const store = new HubStore(':memory:', 'synthetic'), user = store.createUser('Owner');
  store.upsertConnection({ id: 'environment', ownerUserId: user.id, label: 'Environment', connectorUrl: 'http://fixture.invalid' });
  const state = { calls: 0, lost: false, malformed: false, actor: user.id };
  const client = new ConnectorClient('http://fixture.invalid', 'synthetic-credential', async request => {
    state.calls++;
    assert.equal(request.method, 'POST');
    assert.equal(new URL(request.url).pathname, '/api/connector/v1/sessions/codex%3Asynthetic/background-terminals/stop');
    assert.deepEqual(await request.json(), { expectedRunId: 'turn' });
    if (state.lost) throw new Error('Synthetic lost stop response');
    return Response.json(state.malformed ? { requested: true } : { stopped: true }, { headers: { [CONNECTOR_PROTOCOL_HEADER]: '1' } });
  });
  const app = new Hono(), routes = registerHubSessionAuxiliary(app, { hubStore: store,
    principal: () => ({ userId: state.actor, admin: false }), connectorClient: () => client,
    error: context => context.json({ error: 'Stop unavailable' }, 502) });
  context.after(async () => { await routes.close(); store.close(); });
  const send = (body: unknown = { expectedRunId: 'turn' }) => app.request(
    `/api/hub/v1/sessions/${encodeURIComponent(encodeHubSessionId('environment', 'codex:synthetic'))}/background-terminals/stop`, {
      method: 'POST', body: JSON.stringify(body),
    });

  const ok = await send();
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { stopped: true });
  assert.equal(state.calls, 1);

  assert.equal((await send({ expectedRunId: '' })).status, 400);
  assert.equal(state.calls, 1);

  state.actor = 'other-user';
  assert.equal((await send()).status, 404);
  assert.equal(state.calls, 1);

  state.actor = user.id;
  state.lost = true;
  assert.equal((await send()).status, 502);
  assert.equal(state.calls, 2);

  state.lost = false;
  state.malformed = true;
  assert.equal((await send()).status, 502);
  assert.equal(state.calls, 3);
});
