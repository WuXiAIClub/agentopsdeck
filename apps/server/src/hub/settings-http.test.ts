import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { registerSessionSettingsRoutes } from '../connector/session-settings-http.js';
import { DeckStore } from '../projection/deck-store.js';
import { ConnectorClient } from './connector-client.js';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { HubStore } from './hub-store.js';
import { encodeHubSessionId } from './session-id.js';
import { registerHubSettingsRoutes } from './settings-http.js';

test('settings lost ACK survives Hub restart and recovers by GET with the original delivery identity', async t => {
  const f = fixture(); t.after(f.close);
  f.mode.lose = true;
  assert.equal((await f.patch('a', 'lost')).status, 202);
  assert.equal(f.writes(), 1); f.reopen();
  assert.equal((await f.patch('a', 'lost')).status, 202);
  assert.equal(f.writes(), 1);
  assert.equal((await f.patch('a', 'lost', { model: 'other' })).status, 409);
  f.mode.lose = false;
  const recovered = await (await f.read('a', 'lost')).json() as any;
  assert.equal(recovered.command.state, 'accepted');
  assert.deepEqual(recovered.command.result.body, { sessionKey: f.id('a'), settings: { model: 'resolved-model', modelProvider: 'synthetic-provider', thinkingLevel: 'high' } });
  assert.equal(JSON.stringify(recovered).includes('private-message'), false);
  assert.equal((await f.patch('a', 'lost')).status, 200);
  assert.equal(f.deliveries.length, 1);
});

test('settings accepted before projection failure is retained, with no native replay', async t => {
  const f = fixture(); t.after(f.close);
  f.nodeStore.persistSessionThinkingOverride = () => { throw new Error('synthetic projection failure'); };
  const response = await f.patch('a', 'accepted');
  assert.equal(response.status, 200);
  assert.equal((await response.json() as any).command.state, 'accepted');
  assert.equal((await f.patch('a', 'accepted')).status, 200); assert.equal(f.writes(), 1);
});

test('partial settings failure blocks different actors and deletion admission but never replays', async t => {
  const f = fixture(); t.after(f.close); f.mode.nativeFail = true;
  assert.equal((await f.patch('a', 'partial')).status, 202);
  assert.equal(f.nodeDb.canDeleteSession(f.native), false);
  assert.equal((await f.patch('b', 'different')).status, 409);
  assert.equal((await f.patch('a', 'partial')).status, 202);
  assert.equal(f.writes(), 1);
  assert.equal((await f.read('b', 'partial')).status, 404);
});

test('settings owner and node generation changes cannot expose or migrate an old receipt', async t => {
  const f = fixture(); t.after(f.close); f.mode.lose = true;
  assert.equal((await f.patch('a', 'old')).status, 202); f.bump('a');
  const count = f.deliveries.length;
  assert.equal((await f.read('a', 'old')).status, 409);
  assert.equal((await f.patch('a', 'old')).status, 409);
  assert.equal(f.deliveries.length, count);
});

for (const malformed of ['identity', 'key', 'settings', 'state', 'node', 'missing'] as const) test(`settings rejects malformed ${malformed} ACK, without synthesizing success`, async t => {
  const f = fixture(); t.after(f.close); f.mode.malformed = malformed;
  assert.equal((await f.patch('a', 'bad')).status, 202);
  assert.equal((await f.patch('a', 'bad')).status, 202); assert.equal(f.writes(), 1);
  f.mode.malformed = '';
  assert.equal((await (await f.read('a', 'bad')).json() as any).command.state, 'accepted');
});

test('concurrent identical settings commands submit once; different owners use isolated delivery keys', async t => {
  const f = fixture(); t.after(f.close);
  const responses = await Promise.all(Array.from({ length: 8 }, () => f.patch('a', 'same')));
  assert.ok(responses.every(response => [200, 202].includes(response.status)));
  assert.equal(f.writes(), 1);
  assert.equal((await f.patch('b', 'same')).status, 200);
  assert.equal(f.writes(), 2); assert.equal(new Set(f.deliveries).size, 2);
});

test('settings prewrite validation and body limits never reach native writer', async t => {
  const f = fixture(); t.after(f.close);
  for (const [index, payload] of [{ model: '' }, { model: 12 }, { title: '' }, { model: 'x', thinking: {} }, { model: 'x', thinking: '' }].entries()) {
    assert.equal((await f.patch('a', `bad.${index}`, payload)).status, 400);
  }
  assert.equal((await f.patch('a', 'large', { model: 'x'.repeat(128 * 1024) })).status, 413);
  assert.equal(f.writes(), 0);
});

test('settings release requires exact audits on both original nodes and never settles or replays', async t => {
  const f = fixture(); t.after(f.close); f.mode.nativeFail = true;
  assert.equal((await f.patch('a', 'released')).status, 202);
  const read = async () => (await (await f.read('a', 'released')).json() as any).command;
  const original = await read();
  assert.equal(original.settingsStartReleased, undefined);
  f.audit('hub');
  assert.equal((await read()).settingsStartReleased, undefined, 'Hub-only audit is insufficient');
  f.audit('connector');
  assert.deepEqual(await read(), { ...original, settingsStartReleased: true });
  for (const malformed of ['key', 'node', 'missing']) {
    f.mode.malformed = malformed;
    const response = await f.read('a', 'released');
    const body = await response.json() as any;
    assert.notEqual(body.command?.settingsStartReleased, true);
  }
  f.mode.malformed = '';
  f.reopen();
  assert.equal((await read()).settingsStartReleased, true);
  assert.equal((await f.patch('a', 'released')).status, 202);
  assert.equal(f.writes(), 1);
  assert.equal((await read()).state, 'outcome_unknown');
  f.bump('a');
  assert.equal((await f.read('a', 'released')).status, 409);
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-settings-hub-')), file = join(dir, 'hub.sqlite');
  let store = new HubStore(file, 'synthetic-vault');
  const setup = new DatabaseSync(file);
  for (const owner of ['a', 'b']) setup.prepare('INSERT INTO users (id,label,created_at,updated_at) VALUES (?,?,1,1)').run(owner, owner);
  setup.close();
  const nodeDb = new ConnectorUserStore(join(dir, 'connector.sqlite'));
  const nodeStore = new DeckStore({ eventLog: nodeDb.events, sessionTitlesFile: join(dir, 'titles.json'), sessionThinkingOverridesFile: join(dir, 'thinking.json') });
  const native = 'agent:synthetic:settings', id = (owner: string) => encodeHubSessionId(owner, native);
  nodeStore.upsertSession({ sessionKey: native, title: 'Synthetic', status: 'running', recent: 'private-message', agentId: 'synthetic' });
  const mode = { lose: false, nativeFail: false, malformed: '' }, deliveries: string[] = [];
  let writes = 0;
  const connector = new Hono();
  registerSessionSettingsRoutes(connector, '/api/connector/v1/sessions/:sessionKey', {
    settingsAdmission: key => nodeDb.canChangeSettings(key),
    store: nodeStore, receipts: nodeDb.commands, actor: () => 'shared-token', sessionKey: c => c.req.param('sessionKey')!, refreshSessions: async () => {},
    gateway: { requestBound: async (_method: string, _params: unknown, _connection: unknown, beforeSend: () => void) => {
      beforeSend(); writes++;
      if (mode.nativeFail) throw new Error('synthetic partial write');
      return { payload: { resolved: { model: 'resolved-model', modelProvider: 'synthetic-provider' }, private: 'private-message' } };
    } } as any,
  });
  const bump = (owner: string) => {
    store.upsertConnection({ id: owner, ownerUserId: owner, label: 'Synthetic', connectorUrl: 'http://synthetic', kind: 'remote', capabilities: [] });
    store.pinConnectionNode(owner, owner, store.connectionAuthority(owner, owner)!, nodeDb.nodeId);
  };
  bump('a'); bump('b');
  const client = () => new ConnectorClient('http://synthetic', 'synthetic-credential', async request => {
    if (request.method === 'PATCH') deliveries.push(request.headers.get('idempotency-key')!);
    const response = await connector.fetch(request), body = await response.json() as any;
    const headers = { [NODE_ID_HEADER]: mode.malformed === 'node' ? 'another-node' : nodeDb.nodeId };
    if (mode.lose) return Response.json({}, { status: 502, headers });
    const result = body.command?.result?.body ?? body;
    if (mode.malformed === 'identity') result.sessionKey = 'wrong';
    if (mode.malformed === 'settings') result.settings = { model: 'x', status: 'idle' };
    if (mode.malformed === 'key' && body.command) body.command.key = 'wrong';
    if (mode.malformed === 'state' && body.command) body.command.state = 'outcome_unknown';
    if (mode.malformed === 'missing') delete body.command;
    return Response.json(body, { status: response.status, headers });
  }, undefined, undefined, { nodeId: nodeDb.nodeId });
  const createApp = () => {
    const app = new Hono();
    registerHubSettingsRoutes(app, { store, client, owner: c => {
      const owner = c.req.header('owner'); if (owner !== 'a' && owner !== 'b') throw new HTTPException(401); return owner;
    }, error: c => c.json({ error: 'synthetic failure' }, 502) });
    return app;
  };
  let app = createApp();
  return { native, id, mode, deliveries, nodeDb, nodeStore, bump, writes: () => writes,
    audit: (side: 'hub' | 'connector') => {
      // Synthetic, non-runtime-owned stores only. Production audits are offline.
      const db = (side === 'hub' ? store : nodeDb) as unknown as { db: DatabaseSync };
      db.db.exec(`INSERT INTO settings_start_releases SELECT scope, command_key, id, fingerprint, '{}' FROM command_receipts WHERE state = 'outcome_unknown'`);
    },
    patch: (owner: string, key: string, payload: unknown = { model: 'requested', thinking: 'high' }) => app.request(`/api/sessions/${encodeURIComponent(id(owner))}`,
      { method: 'PATCH', headers: { owner, 'idempotency-key': key }, body: JSON.stringify(payload) }),
    read: (owner: string, key: string) => app.request(`/api/hub/v1/sessions/${encodeURIComponent(id(owner))}/settings-commands/${key}`, { headers: { owner } }),
    reopen: () => { store.close(); store = new HubStore(file, 'synthetic-vault'); app = createApp(); },
    close: () => { store.close(); nodeDb.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
