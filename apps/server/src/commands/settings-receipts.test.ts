import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { CommandReceipts, MAX_COMMAND_RESULT_BYTES } from './receipts.js';
import { registerSettingsReceipts } from './http.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';

const path = '/sessions/:sessionKey';
const nativeKey = (c: Context) => c.req.param('sessionKey')!.replace(/^alias:/, '');
const scope = (c: Context) => {
  const actor = c.req.header('actor');
  if (!actor) throw new HTTPException(403);
  return JSON.stringify([actor, nativeKey(c)]);
};
function request(app: Hono, key = 'settings-key', actor = 'alice', session = 'native', body = { model: 'model' }) {
  return app.request(`/sessions/${encodeURIComponent(session)}`, { method: 'PATCH',
    headers: { actor, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
}

test('exclusive startup recovers only proven settings prewrites, never dispatched or legacy unknowns', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-prewrite-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'connector.sqlite');
  let users = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
  const scopeFor = (key: string) => JSON.stringify(['settings', JSON.stringify(['alice', key])]);
  for (const key of ['prewrite', 'dispatched', 'legacy']) {
    (await users.commands.claimAsync(scopeFor(key), key, {}, false, undefined, undefined, undefined, key !== 'legacy'));
    assert.equal(users.commands.sessionSettingsPending(key), true);
  }
  users.commands.beginSettingsWrite(scopeFor('dispatched'), 'dispatched');
  assert.throws(() => users.commands.beginSettingsWrite(scopeFor('dispatched'), 'dispatched'));
  assert.throws(() => users.commands.beginSettingsWrite(scopeFor('legacy'), 'legacy'));
  users.close();
  users = new ConnectorUserStore(file);
  assert.equal(users.commands.get(scopeFor('prewrite'), 'prewrite')!.state, 'outcome_unknown', 'management open cannot recover active work');
  users.close();
  users = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
  try {
    assert.equal(users.commands.get(scopeFor('prewrite'), 'prewrite')!.state, 'rejected');
    assert.equal(users.commands.sessionSettingsPending('prewrite'), false);
    for (const key of ['dispatched', 'legacy']) {
      assert.equal(users.commands.get(scopeFor(key), key)!.state, 'outcome_unknown');
      assert.equal(users.commands.sessionSettingsPending(key), true);
    }
    assert.equal((await users.commands.claimAsync(scopeFor('prewrite'), 'prewrite', {}, false, undefined, undefined, undefined, true)).fresh, false);
  } finally { users.close(); }
});

test('settings dispatch fence is durable before writer and refuses failed persistence', async t => {
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db), app = new Hono();
  t.after(() => db.close());
  registerSettingsReceipts(app, path, { receipts, scope, sessionKey: nativeKey });
  let writes = 0;
  db.exec("CREATE TRIGGER deny_dispatch BEFORE UPDATE OF settings_dispatch_phase ON command_receipts BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
  app.patch(path, c => { c.get('beginSettingsWrite')(); writes++; return c.json({}); });
  await request(app);
  assert.equal(writes, 0);
  assert.equal(db.prepare('SELECT settings_dispatch_phase AS phase FROM command_receipts').get()!.phase, 'prewrite');
  assert.equal(receipts.sessionSettingsPending('native'), true);
  db.exec('DROP TRIGGER deny_dispatch');
  receipts.recoverSettingsPrewrites();
  assert.equal(receipts.sessionSettingsPending('native'), false);
});

test('offline audited settings recovery releases only exact start fence, never resolves or replays unknown write', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'store.sqlite');
  let db = new DatabaseSync(file), receipts = new CommandReceipts(db);
  const s = JSON.stringify(['settings', JSON.stringify(['alice', 'native'])]);
  const unknown = receipts.claim(s, 'settings-key', { model: 'model' }).receipt;
  const other = JSON.stringify(['settings', JSON.stringify(['alice', 'other'])]);
  receipts.claim(other, 'other-key', {});
  const row = db.prepare('SELECT fingerprint FROM command_receipts WHERE scope = ? AND command_key = ?').get(s, 'settings-key')!;
  assert.equal(typeof row.fingerprint, 'string');
  const fingerprint = String(row.fingerprint);
  assert.equal(receipts.sessionSettingsPending('native'), true);
  // A wrong identity cannot release the fence, even with an audit row.
  db.exec('BEGIN');
  db.prepare('INSERT INTO settings_start_releases VALUES (?, ?, ?, ?, ?)').run(s, 'settings-key', 'wrong', fingerprint, '{}');
  assert.equal(receipts.sessionSettingsPending('native'), true);
  db.exec('ROLLBACK');
  db.prepare('INSERT INTO settings_start_releases VALUES (?, ?, ?, ?, ?)').run(s, 'settings-key', unknown.id, fingerprint,
    JSON.stringify({ authorization: 'explicit accept-current-settings', stopped: true, goal: null }));
  assert.equal(receipts.sessionSettingsPending('native'), false);
  assert.equal(receipts.sessionSettingsPending('other'), true);
  assert.throws(() => db.exec('DELETE FROM settings_start_releases'), /immutable/);
  assert.throws(() => db.exec("UPDATE settings_start_releases SET audit_json = '{}'"), /immutable/);
  db.close(); db = new DatabaseSync(file); receipts = new CommandReceipts(db);
  t.after(() => db.close());
  assert.equal(receipts.sessionSettingsPending('native'), false);
  assert.deepEqual(receipts.get(s, 'settings-key'), unknown);
  const app = new Hono();
  registerSettingsReceipts(app, path, { receipts, scope, sessionKey: nativeKey });
  let writes = 0;
  app.patch(path, c => { writes++; c.get('beginSettingsWrite')(); return c.json({}, 502); });
  const presented = await (await app.request('/sessions/native/settings-commands/settings-key', { headers: { actor: 'alice' } })).json() as any;
  assert.equal(presented.command.settingsStartReleased, true);
  assert.equal(presented.command.state, 'outcome_unknown');
  assert.equal(presented.command.id, unknown.id);
  assert.equal((await request(app)).status, 202);
  assert.equal(writes, 0, 'original unknown key cannot be replayed');
  assert.equal((await request(app, 'new-explicit-setting')).status, 202);
  assert.equal(writes, 1);
  assert.equal(receipts.sessionSettingsPending('native'), true, 'new ambiguous write is still protected');
});

for (const outcome of ['ack', 'lost-ack'] as const) test(`settings ${outcome}: concurrent aliases, actors and database reopen never repeat a write`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-settings-http-'));
  const file = join(directory, 'receipts.sqlite');
  let db = new DatabaseSync(file), receipts = new CommandReceipts(db);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const app = new Hono();
  registerSettingsReceipts(app, path, { receipts, scope, sessionKey: nativeKey });
  let release!: () => void, entered!: () => void, writes = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  app.patch(path, async c => {
    c.get('beginSettingsWrite')(); writes++; entered(); await gate;
    if (outcome === 'ack') c.get('acknowledgeSettings')({ status: 200, body: { sessionKey: nativeKey(c), model: 'model' } });
    return c.json({ error: 'synthetic projection/transport failure' }, 400);
  });
  const pending = request(app);
  await started;
  assert.equal(receipts.sessionSettingsPending('native'), true);
  assert.equal((await request(app, 'settings-key', 'alice', 'alias:native')).status, 202);
  assert.equal((await request(app, 'settings-key', 'alice', 'native', { model: 'different' })).status, 409);
  assert.equal((await request(app, 'other-key', 'bob')).status, 409);
  assert.equal((await app.request('/sessions/native/settings-commands/settings-key', { headers: { actor: 'bob' } })).status, 404);
  assert.equal(writes, 1);
  release();
  const response = await pending, original = await response.json();
  assert.equal(response.status, outcome === 'ack' ? 200 : 202);
  assert.equal(receipts.sessionSettingsPending('native'), outcome !== 'ack');
  db.close(); db = new DatabaseSync(file); receipts = new CommandReceipts(db);
  const restarted = new Hono();
  registerSettingsReceipts(restarted, path, { receipts, scope, sessionKey: nativeKey });
  restarted.patch(path, () => assert.fail('neither unknown nor a terminal receipt is a replay lease'));
  assert.deepEqual(await (await request(restarted)).json(), original);
  assert.equal((await request(restarted, 'other-key', 'bob')).status, 409, 'previously rejected request stays rejected even after release');
  assert.equal((await app.request('/sessions/native/settings-commands/settings-key')).status, 403);
  assert.equal(writes, 1);
});

for (const status of [200, 400, 502] as const) test(`settings dispatched ${status} without explicit ACK stays unknown`, async t => {
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db), app = new Hono();
  t.after(() => db.close());
  registerSettingsReceipts(app, path, { receipts, scope, sessionKey: nativeKey });
  app.patch(path, c => { c.get('beginSettingsWrite')(); return c.json({ model: 'unproven' }, status); });
  assert.equal((await request(app)).status, 202);
  assert.equal(receipts.sessionSettingsPending('native'), true);
});

test('settings success envelope alone cannot manufacture an ACK; prewrite rejection releases admission', async t => {
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db), app = new Hono();
  t.after(() => db.close());
  registerSettingsReceipts(app, path, { receipts, scope, sessionKey: nativeKey });
  app.patch(path, c => c.req.header('idempotency-key') === 'reject' ? c.json({ error: 'invalid model' }, 400) : c.json({ model: 'unproven' }));
  assert.equal((await request(app, 'reject')).status, 400);
  assert.equal(receipts.sessionSettingsPending('native'), false);
  assert.equal((await request(app)).status, 202);
  assert.equal(receipts.sessionSettingsPending('native'), true);
});

for (const deletion of ['accepted', 'rejected', 'outcome_unknown'] as const) test(`settings admission respects native deletion ${deletion}`, async t => {
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db), app = new Hono();
  t.after(() => db.close());
  const deletionScope = JSON.stringify(['delete', JSON.stringify(['bob', 'native'])]);
  receipts.claim(deletionScope, 'delete', {});
  if (deletion !== 'outcome_unknown') receipts.settle(deletionScope, 'delete', { status: deletion === 'accepted' ? 200 : 409, body: {} });
  registerSettingsReceipts(app, path, { receipts, scope, sessionKey: nativeKey });
  let writes = 0;
  app.patch(path, c => {
    c.get('beginSettingsWrite')(); writes++;
    c.get('acknowledgeSettings')({ status: 200, body: { sessionKey: nativeKey(c), model: 'model' } });
    return c.json({});
  });
  assert.equal((await request(app, 'settings-key', 'alice', 'alias:native')).status, deletion === 'rejected' ? 200 : 409);
  assert.equal(writes, deletion === 'rejected' ? 1 : 0);
});

test('settings ACK consumes pre-reserved UTF-8 metadata budget and survives projection exceptions', async t => {
  const db = new DatabaseSync(':memory:'), app = new Hono();
  t.after(() => db.close());
  const commandScope = JSON.stringify(['settings', JSON.stringify(['alice', 'native'])]);
  const receipts = new CommandReceipts(db, 10, Buffer.byteLength(commandScope) + 512 + MAX_COMMAND_RESULT_BYTES);
  registerSettingsReceipts(app, path, { receipts, scope, sessionKey: nativeKey });
  app.onError(() => new Response('synthetic projection failed', { status: 500 }));
  let writes = 0;
  const body = { sessionKey: 'native', model: 'model', title: '中'.repeat(2000) };
  app.patch(path, c => {
    c.get('beginSettingsWrite')(); writes++;
    c.get('acknowledgeSettings')({ status: 200, body });
    throw new Error('synthetic projection failed');
  });
  const result = await request(app);
  assert.equal(result.status, 200);
  const saved = await result.json() as any;
  const { result: _result, ...metadata } = receipts.get(commandScope, 'settings-key')!;
  assert.deepEqual(saved, { ...body, command: metadata });
  assert.deepEqual(await (await request(app)).json(), saved);
  assert.equal(writes, 1);
});

test('settings insufficient result reserve refuses admission before calling the writer', async t => {
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db, 10, 2048), app = new Hono();
  t.after(() => db.close());
  registerSettingsReceipts(app, path, { receipts, scope, sessionKey: nativeKey });
  app.patch(path, () => assert.fail('capacity failure must precede native settings'));
  assert.equal((await request(app)).status, 503);
  assert.equal(receipts.sessionSettingsPending('native'), false);
});

test('settings lost delivery recovers by GET only using isolated original key', async t => {
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db), app = new Hono();
  t.after(() => db.close());
  let writes = 0, reads = 0;
  registerSettingsReceipts(app, path, { receipts, scope, sessionKey: nativeKey, isolatedDelivery: true,
    recover: async (_c, key) => {
      reads++;
      assert.notEqual(key, 'settings-key');
      return { key, id: 'native-receipt', state: 'accepted', createdAt: 1, updatedAt: 2,
        result: { status: 200, body: { sessionKey: 'native', model: 'model' } } };
    } });
  app.patch(path, c => { c.get('beginSettingsWrite')(); writes++; return c.json({}, 502); });
  assert.equal((await request(app)).status, 202);
  assert.equal((await app.request('/sessions/native/settings-commands/settings-key', { headers: { actor: 'alice' } })).status, 200);
  assert.equal((await request(app)).status, 200);
  assert.equal(writes, 1); assert.equal(reads, 1);
  assert.equal(receipts.sessionSettingsPending('native'), false);
});

test('settings actor change during request body read does not allocate or write', async t => {
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db), app = new Hono();
  t.after(() => db.close());
  let actor = 'alice';
  registerSettingsReceipts(app, path, { receipts, scope: c => JSON.stringify([actor, nativeKey(c)]), sessionKey: nativeKey });
  app.patch(path, () => assert.fail('original actor cannot be replaced'));
  const body = new ReadableStream({ pull(controller) {
    actor = 'bob'; controller.enqueue(new TextEncoder().encode('{"model":"model"}')); controller.close();
  } });
  assert.equal((await app.request(new Request('http://synthetic/sessions/native', { method: 'PATCH', body, duplex: 'half' } as RequestInit))).status, 403);
  assert.equal(db.prepare('SELECT count(*) AS n FROM command_receipts').get()!.n, 0);
});

test('settings receipt storage failure cannot release unknown or authorize projection', async t => {
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db), app = new Hono();
  t.after(() => db.close());
  registerSettingsReceipts(app, path, { receipts, scope, sessionKey: nativeKey });
  let writes = 0, projections = 0;
  app.patch(path, c => {
    c.get('beginSettingsWrite')(); writes++;
    db.exec("CREATE TRIGGER synthetic_failure BEFORE UPDATE OF result ON command_receipts BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    try {
      c.get('acknowledgeSettings')({ status: 200, body: { sessionKey: 'native', model: 'model' } });
      projections++;
      return c.json({});
    } catch { return c.json({ error: 'legacy error envelope' }, 400); }
  });
  assert.equal((await request(app)).status, 202);
  assert.equal(receipts.sessionSettingsPending('native'), true);
  db.exec('DROP TRIGGER synthetic_failure');
  assert.equal((await request(app)).status, 202);
  assert.equal(writes, 1); assert.equal(projections, 0);
});

test('settings bounds actual body bytes before claim and passes the parsed payload without rereading', async t => {
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db), app = new Hono();
  t.after(() => db.close());
  registerSettingsReceipts(app, path, { receipts, scope, sessionKey: nativeKey });
  app.patch(path, c => {
    assert.deepEqual(c.get('settingsPayload'), { model: 'model' });
    c.get('beginSettingsWrite')();
    c.get('acknowledgeSettings')({ status: 200, body: { sessionKey: 'native', model: 'model' } });
    return c.json({});
  });
  assert.equal((await request(app, 'oversized', 'alice', 'native', { model: '中'.repeat(50_000) })).status, 413);
  assert.equal(db.prepare('SELECT count(*) AS n FROM command_receipts').get()!.n, 0);
  assert.equal((await request(app)).status, 200);
});

for (const outcome of ['revoke', 'replace', 'transport-revoke'] as const) test(`settings GET recovery ${outcome} cannot expose the original actor receipt`, async t => {
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db), app = new Hono();
  t.after(() => db.close());
  let actor: string | undefined = 'alice';
  const originalScope = JSON.stringify(['settings', JSON.stringify(['alice', 'native'])]);
  registerSettingsReceipts(app, path, { receipts, sessionKey: nativeKey, scope: c => {
    if (!actor) throw new HTTPException(403);
    return JSON.stringify([actor, nativeKey(c)]);
  }, recover: async (_c, key) => {
    actor = outcome === 'replace' ? 'bob' : undefined;
    if (outcome === 'transport-revoke') throw new Error('synthetic transport loss');
    return { key, id: 'remote', state: 'accepted', createdAt: 1, updatedAt: 2,
      result: { status: 200, body: { sessionKey: 'native', model: 'private-model' } } };
  } });
  app.patch(path, c => { c.get('beginSettingsWrite')(); return c.json({}, 502); });
  assert.equal((await request(app)).status, 202);
  const result = await app.request('/sessions/native/settings-commands/settings-key');
  assert.equal(result.status, 403);
  assert.equal((await result.text()).includes('private-model'), false);
  assert.equal(receipts.get(originalScope, 'settings-key')!.state, 'outcome_unknown');
});
