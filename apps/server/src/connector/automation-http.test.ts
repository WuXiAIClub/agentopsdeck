import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore, DEFAULT_SCOPES } from '../auth/connector-token.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from '../codex/app-server.js';
import { ConnectorAutomationHost } from './automation-host.js';
import { registerConnectorAutomation } from './automation-http.js';
import { loadConfig } from '../config.js';

test('local automation capability requires an exact independent opt-in', () => {
  for (const flag of [undefined, '', '0', 'false', 'true', 'TRUE', '1']) {
    const config = loadConfig(flag === undefined ? {} : { AOD_AUTOMATION_LOCAL_MANAGE: flag });
    assert.equal(config.automationLocalManage, flag === '1');
  }
  assert.ok(!DEFAULT_SCOPES.includes('automation:manage'));
});

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'automation-http-'));
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'));
  const owner = tokens.createTransient(['automation:manage', 'messages:send'], 'owner');
  const users = new ConnectorUserStore(':memory:', () => true, { runtimeOwner: true });
  const codex = new CodexAppServer({ enabled: false, command: 'must-not-launch', defaultCwd: root,
    defaultModel: 'test', approvalPolicy: 'never', store: new DeckStore(), turnQueue: users.turns,
    executions: users.codexExecutions, authorizeTurn: () => true });
  const allowed = (id: string) => tokens.hasScope(id, 'automation:manage') && tokens.hasScope(id, 'messages:send');
  const host = new ConnectorAutomationHost(id => users.createCodexAutomation(codex, id, users.nodeId,
    () => allowed(id)), allowed);
  host.start([], false);
  const app = new Hono();
  registerConnectorAutomation(app, '/automation', { tokens, host, nodeId: users.nodeId });
  const input = { kind: 'save', expectedRevision: 0, confirmEnable: false, template: 'Synthetic fixture',
    rule: { id: 'rule', revision: 1, authorityEpoch: 1, enabled: false,
      target: { ownerId: 'owner', connectionId: users.nodeId, runtime: 'codex', sessionId: 'codex:fixture' },
      startsAt: 1000, expiresAt: 1000000, maxSends: 1, maxPerHour: 1, minIntervalMs: 60000,
      mode: { kind: 'interval', intervalMs: 60000 } } };
  const request = (path = '/automation', body?: unknown, token = owner.token) => app.request(path, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  t.after(async () => { await host.close(); await codex.close(); users.close(); owner.dispose(); rmSync(root, { recursive: true, force: true }); });
  return { app, tokens, owner, host, users, input, request };
}
test('config HTTP requires separate opt-in permission, not default sends or management alone', async t => {
  const f = fixture(t);
  assert.ok(!DEFAULT_SCOPES.includes('automation:manage'));
  assert.equal((await f.request('/automation', undefined, 'invalid')).status, 401);
  for (const scopes of [DEFAULT_SCOPES, ['automation:manage'] as const]) {
    const actor = f.tokens.createTransient([...scopes]);
    assert.equal((await f.request('/automation', undefined, actor.token)).status, 403); actor.dispose();
  }
  assert.equal(f.users.turns.maintenanceCount(), 0);
});
test('HTTP configuration persists original, explicit confirmation and owner/node fences', async t => {
  const f = fixture(t);
  const before = await f.request(); assert.equal(before.status, 200);
  assert.equal(before.headers.get('cache-control'), 'no-store');
  assert.equal((await f.request('/automation/configuration/req', { ...f.input, rule: { ...f.input.rule, enabled: true } })).status, 409);
  for (const target of [{ ...f.input.rule.target, ownerId: 'other' }, { ...f.input.rule.target, connectionId: 'other' }]) {
    assert.equal((await f.request('/automation/configuration/req', { ...f.input, rule: { ...f.input.rule, target } })).status,
      target.ownerId !== 'owner' ? 409 : 403);
  }
  const saved = await f.request('/automation/configuration/req', f.input); assert.equal(saved.status, 200);
  const original = await saved.json();
  assert.deepEqual(await (await f.request('/automation/configuration/req', f.input)).json(), original);
  assert.deepEqual(await (await f.request('/automation/configuration/req')).json(), original);
  assert.deepEqual(f.users.automationOwners(), ['owner']);
  assert.equal((await f.request('/automation/configuration/req', { ...f.input, template: 'reused' })).status, 409);
  assert.equal(f.users.turns.maintenanceCount(), 0);
});
test('bounded body and no public trigger/dispatch endpoints', async t => {
  const f = fixture(t);
  assert.equal((await f.request('/automation/configuration/req', { ...f.input, template: 'x'.repeat(50000) })).status, 413);
  for (const action of ['trigger', 'completed', 'dispatch', 'retry']) {
    assert.equal((await f.request(`/automation/${action}`, {})).status, 404);
  }
  assert.equal((await f.request('/automation/configuration/req', { ...f.input,
    rule: { ...f.input.rule, mode: { kind: 'completion', allowOwnTurns: false } } })).status, 200);
  assert.equal(f.users.turns.maintenanceCount(), 0);
});
test('revocation during streamed body read is rechecked before configuration', async t => {
  const f = fixture(t);
  const body = new ReadableStream({ pull(controller) {
    f.owner.dispose(); controller.enqueue(new TextEncoder().encode(JSON.stringify(f.input))); controller.close();
  } });
  const response = await f.app.request(new Request('http://local/automation/configuration/req', {
    method: 'POST', headers: { authorization: `Bearer ${f.owner.token}` }, body, duplex: 'half',
  } as RequestInit));
  assert.ok([401, 403].includes(response.status));
  assert.deepEqual(f.users.automationOwners(), []);
});
test('closed host cannot configure or revive a scheduler', async t => {
  const f = fixture(t); await f.host.close();
  assert.equal((await f.request('/automation/configuration/req', f.input)).status, 409);
  assert.throws(() => f.host.start([], false), /closed/);
  assert.deepEqual(f.users.automationOwners(), []);
});
