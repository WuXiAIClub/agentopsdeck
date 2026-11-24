import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HubStore } from './hub-store.js';
import { WeixinService } from './weixin-service.js';
import { WeixinStore } from './weixin-store.js';
import { weixinBridge, weixinRequestBinding } from './weixin-bridge.js';
import { HttpWeixinTransport, WEIXIN_ORIGIN, WeixinError, type WeixinTransport } from './weixin-transport.js';
import { weixinOriginalEffect } from './weixin-original-effect.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { HubPrincipal } from './identity.js';

const account = { botId: 'synthetic-bot', peerId: 'synthetic-peer', token: 'secret-provider-token', baseUrl: WEIXIN_ORIGIN };
const signal = () => new AbortController().signal;
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(ok => { resolve = ok; }); return { promise, resolve };
}
async function flush() { for (let i = 0; i < 8; i++) await new Promise<void>(ok => setImmediate(ok)); }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-weixin-recovery-')), file = join(dir, 'hub.sqlite');
  let hub = new HubStore(file, 'isolated-recovery-encryption');
  const key = hub.identities.issueKey('default');
  return { get hub() { return hub; }, key, file,
    create() { const row = hub.weixin.create('default', key.id, randomUUID()).row; hub.weixin.bind(row, account); return row; },
    reopen() { hub.close(); hub = new HubStore(file, 'isolated-recovery-encryption'); },
    read<T>(run: (db: DatabaseSync) => T): T { const db = new DatabaseSync(file, { readOnly: true }); try { return run(db); } finally { db.close(); } },
    close() { hub.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function transport(): WeixinTransport {
  return { qr: async () => ({ code: 'qr-code', url: 'https://weixin.qq.com/qr' }),
    pollQr: async () => ({ state: 'confirmed', account }),
    receive: async () => ({ cursor: 'new-cursor', messages: [] }), send: async () => 'accepted' };
}

test('provider abort retains original late fetch and its late body cancel ACK', async () => {
  const dispatched = deferred(), response = deferred<Response>(), cancelled = deferred(), cancelAck = deferred();
  const controller = new AbortController(); let settled = false, calls = 0;
  const client = new HttpWeixinTransport(async () => { calls++; dispatched.resolve(); return response.promise; }, 10_000);
  const work = client.qr(controller.signal).finally(() => { settled = true; });
  const outcome = assert.rejects(work, /unavailable/);
  try {
    await dispatched.promise; controller.abort(); await flush(); assert.equal(settled, false);
    response.resolve(new Response(new ReadableStream({ cancel() { cancelled.resolve(); return cancelAck.promise; } })));
    await cancelled.promise; await flush(); assert.equal(settled, false);
    cancelAck.resolve(); await outcome; assert.equal(calls, 1);
  } finally { cancelAck.resolve(); await outcome; }
});

test('non-OK provider response retains body cancellation ACK instead of orphaning response', async () => {
  const cancelled = deferred(), cancelAck = deferred(); let settled = false;
  const client = new HttpWeixinTransport(async () => new Response(new ReadableStream({
    cancel() { cancelled.resolve(); return cancelAck.promise; },
  }), { status: 503 }));
  const outcome = assert.rejects(client.qr(signal()).finally(() => { settled = true; }), /unavailable/);
  try { await cancelled.promise; await flush(); assert.equal(settled, false); }
  finally { cancelAck.resolve(); await outcome; }
});

test('effect error and secret-free diagnostic survive failed body cancellation and broken diagnostic sink', async () => {
  const lines: string[] = [];
  const diagnostics = new PerformanceDiagnostics(line => { lines.push(line); throw Error('broken sink'); });
  const failure = new WeixinError('invalid_response');
  await assert.rejects(weixinOriginalEffect(signal(), 10_000, 'unknown', async (_signal, retain) => {
    retain(new ReadableStream({ cancel() { return Promise.reject(Error(account.token)); } })); throw failure;
  }, diagnostics), error => error === failure);
  assert.ok(lines.length); assert.equal(lines.join('').includes(account.token), false);
});

test('already-aborted effect never dispatches and retires diagnostics without an orphaned rejection', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(weixinOriginalEffect(controller.signal, 10_000, 'unknown', async () => { calls++; }));
  assert.equal(calls, 0);
});

for (const late of [false, true]) test(`private bridge retains ${late ? 'late dispatch and ' : ''}cancel ACK and unusable identity until original retirement`, async () => {
  const f = fixture(), app = new Hono(), identities = new WeakMap<Request, () => HubPrincipal | undefined>();
  const entered = deferred(), dispatchAck = deferred(), cancelled = deferred(), cancelAck = deferred();
  let request: Request | undefined, settled = false;
  app.get('/api/hub/v1/sessions/state', async c => {
    request = c.req.raw; entered.resolve(); if (late) await dispatchAck.promise;
    return new Response(new ReadableStream({ cancel() { cancelled.resolve(); return cancelAck.promise; } }));
  });
  const controller = new AbortController(), row = f.create();
  const outcome = assert.rejects(weixinBridge(app, f.hub, identities, 10_000)(row, '/api/hub/v1/sessions/state', controller.signal)
    .finally(() => { settled = true; }), /unknown/);
  try {
    await entered.promise; if (!late) await flush(); controller.abort(); await flush();
    assert.equal(settled, false); assert.ok(request); assert.ok(identities.has(request));
    assert.equal(identities.get(request)?.(), undefined, 'retained evidence is not a live authority grant');
    assert.equal(weixinRequestBinding(request)?.id, row.id);
    dispatchAck.resolve(); await cancelled.promise; await flush(); assert.equal(settled, false);
    cancelAck.resolve(); await outcome;
    assert.equal(identities.has(request), false); assert.equal(weixinRequestBinding(request), undefined);
  } finally { dispatchAck.resolve(); cancelAck.resolve(); await outcome; f.close(); }
});

test('service close seals new QR work and waits original QR ACK without committing a late QR', async () => {
  const f = fixture(), provider = transport(), entered = deferred(), qrAck = deferred<{ code: string; url: string }>();
  let calls = 0;
  provider.qr = async () => { calls++; entered.resolve(); return qrAck.promise; };
  const service = new WeixinService(f.hub.weixin, provider, async () => ({}), () => {}), id = randomUUID();
  const outcome = assert.rejects(service.start('default', f.key.id, id, signal(), () => {}));
  try {
    await entered.promise; const close = service.close(); assert.equal(service.close(), close);
    let drained = false; void close.then(() => { drained = true; }); await flush(); assert.equal(drained, false);
    await assert.rejects(service.start('default', f.key.id, randomUUID(), signal(), () => {}), /busy/);
    qrAck.resolve({ code: 'late', url: 'https://weixin.qq.com/late' }); await outcome; await close;
    assert.equal(drained, true); assert.equal(calls, 1); assert.equal(f.hub.weixin.get('default')?.phase, 'creating');
    assert.equal(f.hub.weixin.secrets(f.hub.weixin.get('default')!).qrCode, undefined);
  } finally { qrAck.resolve({ code: 'late', url: 'https://weixin.qq.com/late' }); await outcome; await service.close(); f.close(); }
});

for (const revoke of ['unlink', 'key', 'close'] as const) test(`late accepted send settles original fact across ${revoke}, close and reopen without replay`, async () => {
  const f = fixture(), row = f.create(), provider = transport(), entered = deferred(), sendAck = deferred<'accepted'>();
  const at = Date.now() + 1000; let sends = 0;
  provider.receive = async () => ({ cursor: 'new', messages: [{ id: 'original-message', peerId: account.peerId, at, text: 'help', context: 'original-context' }] });
  provider.send = async (_account, context) => { sends++; assert.equal(context, 'original-context'); entered.resolve(); return sendAck.promise; };
  const audit: string[] = [];
  const service = new WeixinService(f.hub.weixin, provider, async () => ({}), (_user, reason) => audit.push(reason), () => at);
  const outcome = assert.rejects(service.tick(row));
  try {
    await entered.promise;
    if (revoke === 'unlink') service.remove('default', row.id);
    if (revoke === 'key') f.hub.identities.revokeKey('default', f.key.id);
    const close = service.close(); let drained = false; void close.then(() => { drained = true; });
    await flush(); assert.equal(drained, false);
    sendAck.resolve('accepted'); await outcome; await close;
    assert.equal(drained, true); assert.equal(sends, 1); assert.ok(audit.includes('weixin_send_accepted'));
    const facts = () => f.read(db => db.prepare('SELECT state FROM hub_weixin_deliveries WHERE binding_id=?').all(row.id));
    assert.deepEqual(facts().map(v => v.state), ['accepted']);
    assert.equal(f.read(db => db.prepare('SELECT state FROM hub_weixin_receipts WHERE binding_id=?').get(row.id))?.state, 'accepted');
    f.reopen(); assert.deepEqual(facts().map(v => v.state), ['accepted']);
    if (revoke === 'unlink') {
      assert.equal(f.hub.weixin.get('default'), undefined);
      assert.throws(() => f.hub.weixin.create('default', f.key.id, row.id), /expired/);
      assert.equal(f.read(db => db.prepare("SELECT 1 FROM env_credentials WHERE connection_id=? AND owner_user_id=?").get(row.id, '\0weixin')), undefined);
    } else if (revoke === 'close') {
      const resumed = new WeixinService(f.hub.weixin, provider, async () => ({}), () => {}, () => at + 4000);
      try { await resumed.tick(row); assert.equal(sends, 1, 'reopened original message is not resent'); }
      finally { await resumed.close(); }
    }
  } finally { sendAck.resolve('accepted'); await outcome; await service.close(); f.close(); }
});

test('receive cursor, context, throttle and all message claims roll back together on original vault failure', () => {
  const f = fixture(), row = f.create(), store = f.hub.weixin, at = Date.now() + 1000;
  const batch = { cursor: 'next', messages: [{ id: 'message', peerId: account.peerId, at, text: 'help', context: 'ctx' }] };
  const save = store.save;
  try {
    store.save = function (binding, value) { save.call(this, binding, value); throw Error('synthetic-after-vault-write'); };
    assert.throws(() => store.receiveAdmission(row, '', batch, at), /synthetic-after-vault-write/);
    store.save = save;
    assert.equal(store.secrets(row).cursor, ''); assert.equal(store.secrets(row).context, undefined);
    assert.equal(f.read(db => db.prepare('SELECT count(*) AS n FROM hub_weixin_deliveries WHERE binding_id=?').get(row.id))?.n, 0);
    assert.equal(store.receiveAdmission(row, '', batch, at).length, 1);
    assert.throws(() => store.receiveAdmission(row, '', batch, at), /denied/, 'stale cursor cannot replace committed cursor');
    assert.equal(store.receiveAdmission(row, 'next', batch, at + 4000).length, 0, 'original message cannot gain another claim');
  } finally { store.save = save; f.close(); }
});

test('malformed receive batch cannot commit earlier claims or a new cursor', () => {
  const f = fixture(), row = f.create(), at = Date.now() + 1000;
  try {
    const messages = [{ id: 'first', peerId: account.peerId, at, text: 'help', context: 'ctx' },
      { id: 'second', peerId: account.peerId, at: at + 1, text: 'help', context: '' }];
    assert.throws(() => f.hub.weixin.receiveAdmission(row, '', { cursor: 'next', messages }, at), /invalid_response/);
    assert.equal(f.hub.weixin.secrets(row).cursor, '');
    assert.equal(f.read(db => db.prepare('SELECT count(*) AS n FROM hub_weixin_deliveries WHERE binding_id=?').get(row.id))?.n, 0);
  } finally { f.close(); }
});

test('original settlement references cannot be fabricated, crossed between stores or downgraded after revocation', () => {
  const f = fixture(), other = fixture(), row = f.create();
  try {
    const ref = f.hub.weixin.claimAction(row, 'action:original'); assert.ok(ref);
    assert.throws(() => f.hub.weixin.settleOriginal({ kind: 'weixin-original-receipt' }, 'accepted'), /denied/);
    assert.throws(() => other.hub.weixin.settleOriginal(ref, 'accepted'), /denied/);
    f.hub.weixin.remove('default', row.id); f.hub.weixin.settleOriginal(ref, 'accepted'); f.hub.weixin.settleOriginal(ref, 'unknown');
    assert.deepEqual(f.read(db => db.prepare('SELECT state FROM hub_weixin_deliveries WHERE binding_id=?').all(row.id)).map(v => v.state), ['accepted']);
    assert.throws(() => f.hub.weixin.claimAction(row, 'action:new'), /denied/);
  } finally { f.close(); other.close(); }
});

test('retirement capacity reserves unlink, preserves unknown across prune, reclaims only old confirmed tombstones', () => {
  const db = new DatabaseSync(':memory:'), values = new Map<string, string>(); let now = 1000;
  const store = new WeixinStore(db, { read: id => values.get(id), write: (id, value) => { values.set(id, value); }, remove: id => { values.delete(id); } }, true,
    () => ({ userId: 'default', admin: false }), () => now);
  try {
    const unknown = store.create('default', 'key', randomUUID()).row; store.claim(unknown, 'effect'); store.remove('default', unknown.id);
    const accepted = store.create('default', 'key', randomUUID()).row, reference = store.claimAction(accepted, 'effect'); assert.ok(reference);
    store.settleOriginal(reference, 'accepted'); store.remove('default', accepted.id);
    now += 31 * 86400_000; store.prune();
    assert.ok(db.prepare('SELECT 1 FROM hub_weixin_retired WHERE binding_id=?').get(unknown.id));
    assert.equal(db.prepare('SELECT 1 FROM hub_weixin_retired WHERE binding_id=?').get(accepted.id), undefined);
    for (let i = 0; i < 254; i++) db.prepare('INSERT INTO hub_weixin_retired VALUES(?,?)').run(randomUUID(), now);
    const last = store.create('default', 'key', randomUUID()).row; store.remove('default', last.id);
    assert.equal(db.prepare('SELECT count(*) AS n FROM hub_weixin_retired').get()?.n, 256);
    assert.throws(() => store.create('default', 'key', randomUUID()), /busy/);
  } finally { db.close(); }
});
