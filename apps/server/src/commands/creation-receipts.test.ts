import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { registerCreationReceipts } from './http.js';
import { CommandReceipts } from './receipts.js';

const path = '/agents/:agentId/sessions', root = '/agents/codex/sessions';
const scope = (c: Context) => {
  const actor = c.req.header('actor');
  if (!actor) throw new HTTPException(403);
  return JSON.stringify([actor, c.req.param('agentId')]);
};
const request = (app: Hono, key = 'create-key', url = root, actor = 'alice', body = '{"title":"synthetic"}') => app.request(url,
  { method: 'POST', headers: { 'idempotency-key': key, actor, 'content-type': 'application/json' }, body });

test('creation receipts isolate actor and agent, reject changed payload and recover without a session ID', async t => {
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db), app = new Hono();
  t.after(() => db.close());
  registerCreationReceipts(app, path, { receipts, scope });
  let writes = 0;
  app.post(path, c => { writes++; c.get('acknowledgeCreation')({ status: 201, body: { key: `native:${writes}` } }); return c.json({ key: `native:${writes}` }, 201); });
  const initial = await (await request(app)).json() as any;
  assert.equal(initial.command.state, 'accepted');
  assert.deepEqual(await (await request(app)).json(), initial);
  assert.equal((await request(app, 'create-key', root, 'alice', '{"title":"different"}')).status, 409);
  const recovery = await app.request(`${root}/creation-commands/create-key`, { headers: { actor: 'alice' } });
  assert.equal((await recovery.json() as any).command.result.body.key, 'native:1');
  assert.equal(recovery.headers.get('cache-control'), 'no-store');
  assert.equal((await app.request(`${root}/creation-commands/create-key`, { headers: { actor: 'bob' } })).status, 404);
  assert.equal((await app.request('/agents/other/sessions/creation-commands/create-key', { headers: { actor: 'alice' } })).status, 404);
  assert.equal((await app.request(`${root}/creation-commands/create-key`)).status, 403);
  assert.equal((await request(app, 'create-key', root, '')).status, 403);
  for (const [url, actor] of [[root, 'bob'], ['/agents/other/sessions', 'alice']]) {
    const other = await (await request(app, 'create-key', url, actor)).json() as any;
    assert.equal(other.command.state, 'accepted'); assert.notEqual(other.command.id, initial.command.id);
  }
  assert.equal(writes, 3);
});

for (const outcome of ['ack', 'lost-ack'] as const) test(`creation ${outcome}: concurrent duplicates and database reopen never redispatch`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-create-reopen-')), file = join(directory, 'synthetic.sqlite');
  let db = new DatabaseSync(file), receipts = new CommandReceipts(db);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  let release!: () => void, enter!: () => void, writes = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { enter = resolve; });
  const app = new Hono();
  registerCreationReceipts(app, path, { receipts, scope });
  app.post(path, async c => {
    writes++; enter(); await gate;
    if (outcome === 'lost-ack') return c.json({ error: 'synthetic transport loss' }, 502);
    c.get('acknowledgeCreation')({ status: 201, body: { key: 'native:created' } });
    return c.json({ key: 'native:created' }, 201);
  });
  const pending = request(app); await entered;
  assert.equal((await request(app)).status, 202); assert.equal(writes, 1);
  release(); const response = await pending, first = await response.json();
  assert.equal(response.status, outcome === 'ack' ? 201 : 202);
  db.close(); db = new DatabaseSync(file); receipts = new CommandReceipts(db);
  const restarted = new Hono(); registerCreationReceipts(restarted, path, { receipts, scope });
  restarted.post(path, () => assert.fail('a receipt is not a new creation permit'));
  const retry = await request(restarted);
  assert.equal(retry.status, response.status); assert.deepEqual(await retry.json(), first); assert.equal(writes, 1);
});

for (const envelope of ['json', 'text', 'throw', 'unknown', 'revoke'] as const) test(`creation ACK survives ${envelope} after acceptance`, async t => {
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db), app = new Hono();
  t.after(() => db.close()); app.onError(error => error instanceof HTTPException ? error.getResponse() : new Response('synthetic projection failure', { status: 500 }));
  let authorized = true, writes = 0;
  registerCreationReceipts(app, path, { receipts, scope: c => { if (!authorized) throw new HTTPException(403); return scope(c); } });
  app.post(path, c => {
    writes++; c.get('acknowledgeCreation')({ status: 201, body: { key: 'native:created', title: 'synthetic' } });
    if (envelope === 'revoke') authorized = false;
    if (envelope === 'throw') throw new Error('synthetic failure');
    return envelope === 'text' ? c.text('synthetic failure', 502)
      : c.json({ error: 'projection failed', ...(envelope === 'unknown' ? { command: { state: 'outcome_unknown' } } : {}) }, 502);
  });
  const response = await request(app), initial = await response.json() as any;
  assert.equal(response.status, 201); assert.equal(initial.key, 'native:created'); assert.equal(initial.command.state, 'accepted');
  if (envelope === 'revoke') assert.equal((await request(app)).status, 403);
  authorized = true; assert.deepEqual(await (await request(app)).json(), initial); assert.equal(writes, 1);
});

test('creation receipt exhaustion fails before native dispatch', async t => {
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db, 10, 1024), app = new Hono();
  t.after(() => db.close());
  registerCreationReceipts(app, path, { receipts, scope });
  app.post(path, () => assert.fail('capacity rejection must precede native creation'));
  assert.equal((await request(app)).status, 503);
  assert.equal(db.prepare('SELECT count(*) AS n FROM command_receipts').get()!.n, 0);
});

test('creation cannot switch actors while waiting for the body', async t => {
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db), app = new Hono();
  t.after(() => db.close());
  let actor = 'original';
  registerCreationReceipts(app, path, { receipts, scope: () => JSON.stringify([actor, 'codex']) });
  app.post(path, () => assert.fail('changed actor must not dispatch'));
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    actor = 'replacement'; controller.enqueue(new TextEncoder().encode('{}')); controller.close();
  } }, { highWaterMark: 0 });
  const response = await app.fetch(new Request(`http://synthetic${root}`, { method: 'POST', body, duplex: 'half' } as RequestInit));
  assert.equal(response.status, 403);
  assert.equal(db.prepare('SELECT count(*) AS n FROM command_receipts').get()!.n, 0);
});

for (const crash of ['before-ack', 'after-ack'] as const) test(`creation process exit ${crash} keeps its durable outcome without replay`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-create-crash-')), file = join(directory, 'synthetic.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = `
    import { DatabaseSync } from 'node:sqlite';
    import { Hono } from ${JSON.stringify(import.meta.resolve('hono'))};
    import { registerCreationReceipts } from ${JSON.stringify(new URL(import.meta.url.endsWith('.ts') ? './http.ts' : './http.js', import.meta.url).href)};
    import { CommandReceipts } from ${JSON.stringify(new URL(import.meta.url.endsWith('.ts') ? './receipts.ts' : './receipts.js', import.meta.url).href)};
    const receipts = new CommandReceipts(new DatabaseSync(${JSON.stringify(file)})), app = new Hono();
    registerCreationReceipts(app, '/agents/:agentId/sessions', { receipts, scope: () => JSON.stringify(['alice', 'codex']) });
    app.post('/agents/:agentId/sessions', c => {
      if (${JSON.stringify(crash)} === 'before-ack') process.exit(71);
      c.get('acknowledgeCreation')({status:201,body:{key:'native:crash-created'}});
      process.exit(72);
    });
    await app.request('http://synthetic/agents/codex/sessions', {method:'POST',headers:{'idempotency-key':'create-key'},body:'{"title":"synthetic"}'});
  `;
  const child = spawnSync(process.execPath, [...(import.meta.url.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : []), '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(child.status, crash === 'before-ack' ? 71 : 72, child.stderr);
  const db = new DatabaseSync(file), receipts = new CommandReceipts(db), app = new Hono();
  try {
    registerCreationReceipts(app, path, { receipts, scope });
    app.post(path, () => assert.fail('process death never authorizes redispatch'));
    const response = await request(app), body = await response.json() as any;
    assert.equal(response.status, crash === 'before-ack' ? 202 : 201);
    assert.equal(body.command.state, crash === 'before-ack' ? 'outcome_unknown' : 'accepted');
    assert.equal(body.key, crash === 'before-ack' ? undefined : 'native:crash-created');
  } finally { db.close(); }
});
