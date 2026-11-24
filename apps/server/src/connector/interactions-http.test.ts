import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore, type ConnectorScope } from '../auth/connector-token.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { InteractionRuntime } from '../commands/interaction-runtime.js';
import { registerInteractions } from './interactions-http.js';
import { sdkInteractionCapabilities } from './sdk-interaction.js';

function fixture(t: test.TestContext, agent = 'codex') {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-interaction-http-'));
  const users = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'));
  const owner = tokens.createTransient(['messages:read', 'messages:send'], 'owner');
  const runtime = new InteractionRuntime(users.interactions, () => ready, undefined, Date.now, 20);
  const scope = { ownerId: 'owner', nodeId: users.nodeId, sessionKey: `${agent}:thread`, runId: 'run' };
  let ready = true, exists = true, deliveries = 0;
  let beforePermission: () => Promise<void> = async () => {};
  const app = new Hono();
  registerInteractions(app, { runtime, users, tokens, exists: () => exists, ready: () => ready, changed: () => {} });
  const auth = (scopes: ConnectorScope[], id = 'foreign') => tokens.createTransient(scopes, id);
  const request = (suffix: string, method = 'GET', body?: unknown, token = owner.token, headers = {}) => app.request(
    `/api/connector/v1/sessions/${encodeURIComponent(scope.sessionKey)}${suffix}`,
    { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const open = () => runtime.open({ kind: 'text', prompt: 'Choose next step' }, sdkInteractionCapabilities, {
    scope, active: () => true, continuation: async () => ({ connectionId: 'epoch', goal: { status: 'absent', version: 'absent' } }),
    permitted: async () => { await beforePermission(); return true; }, deliver: async () => { deliveries++; return 'confirmed'; }, cancel: () => {},
  });
  t.after(() => { runtime.close(); users.close(); rmSync(root, { recursive: true, force: true }); });
  return { request, open, owner, auth, runtime, scope, deliveries: () => deliveries,
    ready: (v: boolean) => { ready = v; }, exists: (v: boolean) => { exists = v; },
    permission: (fn: () => Promise<void>) => { beforePermission = fn; } };
}
const submission = (view: Awaited<ReturnType<InteractionRuntime['open']>>) => ({ runId: view.request.runId,
  responseId: 'browser-response', expectedRevision: view.revision, answer: { kind: 'text', text: 'Continue safely' } });

for (const agent of ['codex', 'claude-code', 'ghcp']) test(`${agent}: owner HTTP snapshot/mode/answer/receipt, no duplicate delivery`, async t => {
  const f = fixture(t, agent);
  assert.equal((await f.request('/interaction-mode', 'PATCH', { mode: 'interactive' })).status, 200);
  const view = await f.open();
  const snapshot = await f.request('/interactions');
  assert.equal(snapshot.headers.get('cache-control'), 'no-store');
  assert.equal((await snapshot.json()).requests[0].request.requestId, view.request.requestId);
  const path = `/interactions/${view.request.requestId}/answer`, body = submission(view);
  assert.equal((await (await f.request(path, 'POST', body)).json()).delivery, 'confirmed');
  assert.equal((await (await f.request(path, 'POST', body)).json()).delivery, 'confirmed');
  assert.equal((await f.request(path, 'POST', { ...body, responseId: 'another-response' })).status, 409);
  assert.equal(f.deliveries(), 1);
});
test('HTTP auth separates owners/readers/senders/delegation and malformed bodies', async t => {
  const f = fixture(t), view = await f.open(), path = `/interactions/${view.request.requestId}/answer`;
  for (const scopes of [['sessions:read'], ['messages:read'], ['messages:send'], ['messages:read', 'messages:send', 'execution:delegate']] as ConnectorScope[][]) {
    const token = f.auth(scopes, `scopes-${scopes.join('-')}`).token;
    assert.equal((await f.request(path, 'POST', submission(view), token)).status, 403);
  }
  const foreign = f.auth(['messages:read', 'messages:send']);
  assert.equal((await f.request(path, 'POST', submission(view), foreign.token)).status, 409);
  assert.equal((await (await f.request('/interactions', 'GET', undefined, foreign.token)).json()).requests.length, 0);
  assert.equal((await f.request(path, 'POST', submission(view), 'invalid')).status, 403);
  assert.equal((await f.request(path, 'POST', submission(view), f.owner.token, { 'x-agentopsdeck-execution-grant': 'fake' })).status, 403);
  assert.equal((await f.request(path, 'POST', { ...submission(view), runId: 'foreign' })).status, 409);
  assert.equal((await f.request(path, 'POST', {})).status, 400);
  assert.equal((await f.request('/interaction-mode', 'PATCH', { mode: 'interactive', allowAll: true })).status, 400);
  assert.equal((await f.request(path, 'POST', { ...submission(view), answer: { kind: 'text', text: 'x'.repeat(41_000) } })).status, 413);
  assert.equal(f.deliveries(), 0);
});
test('permission revoked during async validation cannot deliver, unavailable mode does not mutate', async t => {
  const f = fixture(t), view = await f.open();
  f.permission(async () => { f.owner.dispose(); });
  assert.equal((await f.request(`/interactions/${view.request.requestId}/answer`, 'POST', submission(view))).status, 403);
  assert.equal(f.deliveries(), 0);
  const token = f.auth(['messages:read', 'messages:send']).token;
  f.ready(false);
  assert.equal((await f.request('/interaction-mode', 'PATCH', { mode: 'interactive' }, token)).status, 503);
  f.exists(false); assert.equal((await f.request('/interactions', 'GET', undefined, token)).status, 404);
});
