import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { registerDeletionReceipts, registerMessageReceipts } from './http.js';
import { CommandReceipts } from './receipts.js';
import { deleteConnectorSession } from '../connector/session-delete.js';

const root = '/sessions/synthetic';
const request = (app: Hono, key = 'delete-key', path = root, actor = 'alice') => app.request(path,
  { method: 'DELETE', headers: { 'idempotency-key': key, actor } });
const scope = (c: Context) => {
  const actor = c.req.header('actor');
  if (!actor) throw new HTTPException(403);
  return JSON.stringify([actor, c.req.param('sessionKey')]);
};

test('deletion aliases share receipts; actor-private recovery does not bypass session exclusion', async t => {
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db);
  t.after(() => db.close());
  const app = new Hono();
  let effects = 0;
  for (const prefix of ['/sessions', '/legacy/sessions']) {
    const path = `${prefix}/:sessionKey`;
    registerDeletionReceipts(app, path, { receipts, scope });
    app.delete(path, c => { effects++; return c.json({ ok: true }); });
  }
  registerMessageReceipts(app, '/sessions/:sessionKey', { receipts, scope });
  app.post('/sessions/:sessionKey/messages', c => c.json({ ok: true, message: true }));
  const initial = await (await request(app)).json() as any;
  assert.equal(initial.command.state, 'accepted');
  assert.deepEqual(await (await request(app, 'delete-key', '/legacy/sessions/synthetic')).json(), initial);
  assert.equal(effects, 1);
  for (const [path, actor] of [[root, 'bob'], ['/sessions/other', 'alice']] as const) {
    assert.equal((await app.request(`${path}/deletion-commands/delete-key`, { headers: { actor } })).status, 404);
    const other = await (await request(app, 'delete-key', path, actor)).json() as any;
    assert.notEqual(other.command.id, initial.command.id);
    assert.equal(other.command.state, path === root ? 'rejected' : 'accepted');
  }
  assert.equal(effects, 2);
  const message = await app.request(`${root}/messages`, { method: 'POST',
    headers: { actor: 'alice', 'content-type': 'application/json', 'idempotency-key': 'delete-key' }, body: '{}' });
  assert.equal((await message.json() as any).message, true);
  assert.equal((await app.request(`${root}/deletion-commands/delete-key`)).status, 403);
  assert.equal((await request(app, 'delete-key', root, '')).status, 403);
  assert.equal(effects, 2);
});

for (const outcome of ['ack', 'lost-ack'] as const) test(`deletion ${outcome}: concurrent delivery and SQLite reopen never redispatch`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-delete-reopen-'));
  const file = join(directory, 'synthetic.sqlite');
  let db = new DatabaseSync(file), receipts = new CommandReceipts(db), effects = 0;
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const app = new Hono();
  registerDeletionReceipts(app, '/sessions/:sessionKey', { receipts, scope });
  app.delete('/sessions/:sessionKey', async c => {
    effects++; entered(); await gate;
    return outcome === 'ack' ? c.json({ ok: true }) : c.json({ error: 'synthetic loss' }, 502);
  });
  const pending = request(app);
  await started;
  const duplicate = await request(app);
  assert.equal(duplicate.status, 202);
  assert.equal((await duplicate.json() as any).command.state, 'outcome_unknown');
  assert.equal(effects, 1);
  release();
  const response = await pending;
  assert.equal(response.status, outcome === 'ack' ? 200 : 202);
  const first = await response.json();
  db.close(); db = new DatabaseSync(file); receipts = new CommandReceipts(db);
  const restarted = new Hono();
  registerDeletionReceipts(restarted, '/sessions/:sessionKey', { receipts, scope });
  restarted.delete('/sessions/:sessionKey', () => assert.fail('reopened receipt is not a dispatch lease'));
  const retried = await request(restarted);
  assert.equal(retried.status, response.status);
  assert.deepEqual(await retried.json(), first);
  assert.equal(effects, 1);
});

for (const envelope of ['json', 'text', 'unknown'] as const) test(`native deletion ACK survives ${envelope} projection failure envelope`, async t => {
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db);
  t.after(() => db.close());
  const app = new Hono();
  registerDeletionReceipts(app, '/sessions/:sessionKey', { receipts, scope });
  let writes = 0;
  app.delete('/sessions/:sessionKey', c => {
    writes++;
    c.get('acknowledgeDeletion')({ status: 200, body: { ok: true, status: 'delete_accepted' } });
    return envelope === 'text' ? c.text('projection failed', 502)
      : c.json({ error: 'projection failed', ...(envelope === 'unknown' ? { command: { state: 'outcome_unknown' } } : {}) }, 502);
  });
  const initial = await request(app);
  assert.equal(initial.status, 200);
  const body = await initial.json() as any;
  assert.equal(body.status, 'delete_accepted');
  assert.equal(body.command.state, 'accepted');
  assert.deepEqual(await (await request(app)).json(), body);
  assert.equal(writes, 1);
});

test('deletion rejects invalid keys and exhausted receipt capacity before entering the handler', async t => {
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db, 1);
  t.after(() => db.close());
  const app = new Hono();
  registerDeletionReceipts(app, '/sessions/:sessionKey', { receipts, scope });
  let effects = 0;
  app.delete('/sessions/:sessionKey', c => { effects++; return c.json({ ok: true }); });
  assert.equal((await request(app, 'invalid/key')).status, 409);
  assert.equal(effects, 0);
  assert.equal((await request(app)).status, 200);
  assert.equal((await request(app, 'different')).status, 503);
  assert.equal((await request(app)).status, 200);
  assert.equal(effects, 1);
});

test('deletion must durably record native acceptance before removing its projection', async t => {
  const db = new DatabaseSync(':memory:');
  // Allocation is reserved at claim, but actual storage can still fail. A
  // failed settlement cannot authorize view removal or another native request.
  const receipts = new CommandReceipts(db), app = new Hono();
  receipts.settle = (scope, key) => receipts.get(scope, key)!;
  t.after(() => db.close());
  let writes = 0, removed = 0;
  registerDeletionReceipts(app, '/sessions/:sessionKey', { receipts, scope });
  app.delete('/sessions/:sessionKey', async c => {
    try {
      return c.json(await deleteConnectorSession({
        gateway: { requestBound: async (method: string) => {
          if (method === 'sessions.describe') return { payload: { session: { key: 'synthetic' } }, connectionId: 'synthetic' };
          writes++; return { payload: { ok: true, key: 'synthetic', deleted: true }, connectionId: 'synthetic' };
        } } as any,
        store: { removeSession: () => { removed++; return true; } }, refreshSessions: async () => {},
      }, 'synthetic', () => {}, body => c.get('acknowledgeDeletion')({ status: 200, body })));
    } catch { return c.json({ error: 'receipt storage unavailable' }, 502); }
  });
  assert.equal((await request(app)).status, 202);
  assert.equal(writes, 1);
  assert.equal(removed, 0);
  assert.equal((await request(app)).status, 202);
  assert.equal(writes, 1);
  const recovered = await app.request(`${root}/deletion-commands/delete-key`, { headers: { actor: 'alice' } });
  assert.equal((await recovered.json() as any).command.state, 'outcome_unknown');
});

test('native deletion receipt stores only bounded acceptance metadata, not the runtime response', async t => {
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db), app = new Hono();
  t.after(() => db.close());
  let writes = 0, removed = 0;
  registerDeletionReceipts(app, '/sessions/:sessionKey', { receipts, scope });
  app.delete('/sessions/:sessionKey', async c => c.json(await deleteConnectorSession({
    gateway: { requestBound: async (method: string) => {
      if (method === 'sessions.describe') return { payload: { session: { key: 'synthetic' } }, connectionId: 'synthetic' };
      writes++; return { payload: { ok: true, key: 'synthetic', deleted: true, archived: ['x'.repeat(70_000)] }, connectionId: 'synthetic' };
    } } as any,
    store: { removeSession: () => { removed++; return true; } }, refreshSessions: async () => {},
  }, 'synthetic', () => {}, body => c.get('acknowledgeDeletion')({ status: 200, body }))));
  const first = await request(app);
  assert.equal(first.status, 200);
  const accepted = await first.json() as any;
  assert.equal(accepted.command.state, 'accepted');
  assert.equal(accepted.status, 'delete_accepted');
  assert.equal(accepted.result, undefined);
  assert.equal(removed, 1);
  assert.deepEqual(await (await request(app)).json(), accepted);
  assert.equal(writes, 1);
  const receipt = (await (await app.request(`${root}/deletion-commands/delete-key`, { headers: { actor: 'alice' } })).json() as any).command;
  assert.deepEqual(receipt.result, { status: 200, body: { ok: true, status: 'delete_accepted' } });
});

test('deletion reserves its ACK budget before native dispatch', async t => {
  const db = new DatabaseSync(':memory:');
  const bytes = Buffer.byteLength(JSON.stringify(['delete', JSON.stringify(['alice', 'synthetic'])])) + 512 + 128;
  const receipts = new CommandReceipts(db, 10, bytes), app = new Hono();
  t.after(() => db.close());
  let writes = 0, removed = 0;
  registerDeletionReceipts(app, '/sessions/:sessionKey', { receipts, scope });
  app.delete('/sessions/:sessionKey', async c => c.json(await deleteConnectorSession({
    gateway: { requestBound: async (method: string) => {
      if (method === 'sessions.describe') return { payload: { session: { key: 'synthetic' } }, connectionId: 'synthetic' };
      writes++;
      assert.equal(Number(db.prepare('SELECT bytes FROM command_receipt_usage').get()!.bytes), bytes);
      assert.throws(() => receipts.claim('other', 'new-command', {}), /capacity/);
      return { payload: { ok: true, key: 'synthetic', deleted: true }, connectionId: 'synthetic' };
    } } as any,
    store: { removeSession: () => { removed++; return true; } }, refreshSessions: async () => {},
  }, 'synthetic', () => {}, body => c.get('acknowledgeDeletion')({ status: 200, body }))));
  const first = await request(app);
  assert.equal(first.status, 200);
  const accepted = await first.json() as any;
  assert.equal(accepted.command.state, 'accepted');
  assert.equal(removed, 1);
  assert.equal((await request(app, 'other-key')).status, 503);
  assert.deepEqual(await (await request(app)).json(), accepted);
  assert.equal(writes, 1);
});
