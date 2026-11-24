import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HubStore } from './hub-store.js';
import { WeixinService } from './weixin-service.js';
import { HttpWeixinTransport, WEIXIN_ORIGIN, weixinOrigin, type WeixinTransport, type WeixinMessage } from './weixin-transport.js';
import { encodeHubSessionId } from './session-id.js';
import { AGENTOPSDECK_VERSION, type InteractionView } from '@agentopsdeck/shared';
import { Hono } from 'hono';
import { weixinBridge } from './weixin-bridge.js';
import type { HubPrincipal } from './identity.js';
import { hubMemberEvidence } from './member-owner-domain.js';

const account = { botId: 'synthetic-bot', peerId: 'synthetic-peer', token: 'private-channel-credential', baseUrl: WEIXIN_ORIGIN };
const signal = () => new AbortController().signal;
function fixture(administratorKey?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-weixin-test-')), file = join(dir, 'hub.sqlite');
  let hub = new HubStore(file, 'isolated-test-encryption', [], administratorKey);
  const key = hub.identities.issueKey('default');
  const create = () => hub.weixin.create('default', hub.weixinAdministratorKeyId ?? key.id, randomUUID()).row;
  return { get hub() { return hub; }, key, file, create,
    reopen(nextKey = administratorKey) { hub.close(); administratorKey = nextKey; hub = new HubStore(file, 'isolated-test-encryption', [], nextKey); },
    close() { hub.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function mockTransport(): WeixinTransport & { messages: WeixinMessage[]; sent: string[]; result: 'accepted' | 'unknown' } {
  return { messages: [], sent: [], result: 'accepted',
    qr: async () => ({ code: 'qr-secret', url: 'https://weixin.qq.com/synthetic-qr' }),
    pollQr: async () => ({ state: 'confirmed', account }),
    async receive() { return { cursor: 'cursor', messages: this.messages }; },
    async send(_account, _context, text) { this.sent.push(text); return this.result; } };
}

test('WeChat idempotent binding paths obey authorization, cancellation and service shutdown', async () => {
  const f = fixture(), transport = mockTransport(); let calls = 0;
  transport.qr = async () => { calls++; return { code: 'synthetic', url: 'https://weixin.qq.com/synthetic' }; };
  const service = new WeixinService(f.hub.weixin, transport, async () => ({}), () => {});
  try {
    const stopped = new AbortController(); stopped.abort();
    await assert.rejects(service.start('default', f.key.id, randomUUID(), stopped.signal, () => {}));
    assert.equal(f.hub.weixin.get('default'), undefined, 'cancelled start creates no stranded binding');
    const row = f.create(); f.hub.weixin.bind(row, account);
    await assert.rejects(service.poll('default', row.id, undefined, signal(), () => { throw Error('revoked'); }), /revoked/);
    await assert.rejects(service.poll('default', row.id, undefined, stopped.signal, () => {}));
    assert.equal((await service.poll('default', row.id, undefined, signal(), () => {})).state, 'confirmed');
    service.close();
    await assert.rejects(service.poll('default', row.id, undefined, signal(), () => {}), /busy/);
    await assert.rejects(service.start('default', f.key.id, row.id, signal(), () => {}), /busy/);
    assert.equal(calls, 0, 'fast paths never contact provider');
  } finally { service.close(); f.close(); }
});

for (const administrator of [false, true]) test(`WeChat ${administrator ? 'administrator' : 'personal'} bridge rejects arbitrary writes, bounds reads, and removes private identity`, async () => {
  const f = fixture(administrator ? 'synthetic-admin-bridge-key' : undefined), app = new Hono(), identities = new WeakMap<Request, () => HubPrincipal | undefined>();
  let mode = 'ok', request: Request | undefined;
  app.get('/api/hub/v1/sessions/state', c => {
    request = c.req.raw; assert.equal(identities.get(request)?.()?.userId, 'default');
    assert.equal(identities.get(request)?.()?.admin, administrator);
    const current = f.hub.weixin.get('default')!;
    assert.deepEqual(hubMemberEvidence(request), { weixinBinding: { id: current.id, user: current.user, keyId: current.keyId } });
    assert.deepEqual(hubMemberEvidence(new Request(request.url, { headers: {
      'x-weixin-user': current.user, 'x-internal-user': current.user, 'x-weixin-binding': current.id,
    } })), {}, 'HTTP headers cannot enroll a private bridge request');
    if (mode === 'hung') return new Response(new ReadableStream({ start() {} }));
    if (mode === 'large') return new Response('x'.repeat(4 * 1024 * 1024 + 1));
    if (mode === 'revoke') {
      if (administrator) f.hub.weixin.remove('default');
      else f.hub.identities.revokeKey('default', f.key.id);
    }
    return c.json({ groups: [] });
  });
  try {
    const row = f.create(); f.hub.weixin.bind(row, account);
    const bridge = weixinBridge(app, f.hub, identities, 50);
    await assert.rejects(bridge(row, '/api/hub/v1/sessions/arbitrary/messages', signal(), { message: 'execute me' }), /denied/);
    assert.deepEqual(await bridge(row, '/api/hub/v1/sessions/state', signal()), { groups: [] });
    assert.deepEqual(hubMemberEvidence(request!), {}, 'bridge settlement retires request evidence');
    assert.equal(identities.has(request!), false);
    mode = 'large'; await assert.rejects(bridge(row, '/api/hub/v1/sessions/state', signal()), /invalid_response/);
    mode = 'hung'; await assert.rejects(bridge(row, '/api/hub/v1/sessions/state', signal()), /unknown/);
    assert.equal(identities.has(request!), false);
    mode = 'revoke'; await assert.rejects(bridge(row, '/api/hub/v1/sessions/state', signal()), /denied/);
  } finally { f.close(); }
});

test('WeChat administrator reference is Hub-scoped, survives same-Key restart and purges on rotation/removal', () => {
  const secret = 'synthetic-admin-rotation-key', f = fixture(secret), other = fixture(secret);
  try {
    assert.notEqual(f.hub.weixinAdministratorKeyId, other.hub.weixinAdministratorKeyId);
    const row = f.create(); f.hub.weixin.bind(row, account);
    assert.throws(() => f.hub.weixin.create('other', row.keyId, randomUUID()), /denied/);
    assert.deepEqual(f.hub.weixin.principal(row), { userId: 'default', admin: true });
    f.reopen(); assert.equal(f.hub.weixin.current(row), true);
    assert.equal(f.hub.weixin.secrets(row).account?.token, account.token);
    assert.equal(readFileSync(f.file).includes(Buffer.from(secret)), false);
    f.reopen('synthetic-replacement-admin-key');
    assert.equal(f.hub.weixin.current(row), false); assert.equal(f.hub.weixin.principal(row), undefined);
    assert.deepEqual(f.hub.weixin.active(), []);
    const db = new DatabaseSync(f.file, { readOnly: true });
    try { assert.equal(db.prepare('SELECT 1 FROM env_credentials WHERE connection_id=? AND owner_user_id=?').get(row.id, '\0weixin'), undefined,
      'pruning purges the encrypted channel credential too'); } finally { db.close(); }
    const next = f.create(); f.hub.weixin.bind(next, account); f.reopen('');
    assert.equal(f.hub.weixin.current(next), false); assert.deepEqual(f.hub.weixin.active(), []);
  } finally { f.close(); other.close(); }
});

test('WeChat refuses unencrypted vault and duplicate account binding without replacing the original', () => {
  const f = fixture();
  try {
    const first = f.create(); f.hub.weixin.bind(first, account);
    const user = f.hub.createUser('Other'), key = f.hub.identities.issueKey(user.id);
    const second = f.hub.weixin.create(user.id, key.id, randomUUID()).row;
    assert.throws(() => f.hub.weixin.bind(second, account), /denied/);
    assert.equal(f.hub.weixin.get(user.id)?.phase, 'creating');
    assert.equal(f.hub.weixin.secrets(first).account?.botId, account.botId);
    assert.equal(f.hub.weixin.secrets(second).account, undefined, 'failed binding rolls back vault write');
  } finally { f.close(); }
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-weixin-disabled-')), hub = new HubStore(join(dir, 'hub.sqlite'), undefined);
  try { const key = hub.identities.issueKey('default'); assert.throws(() => hub.weixin.create('default', key.id, randomUUID()), /not_configured/); }
  finally { hub.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const kind of ['text', 'approval'] as const) for (const outcome of ['confirmed', 'unknown', 'revision', 'revoked'] as const) {
  test(`WeChat ${kind} answer: ${outcome}, exact question fence and no duplicate execution`, async () => {
    const f = fixture(), transport = mockTransport(); let now = Date.now() + 1000, writes = 0;
    const session = encodeHubSessionId('local', 'codex:question');
    const view: InteractionView = { revision: 1, status: 'pending', delivery: 'none', request: {
      version: 1, ownerId: 'default', nodeId: 'node', sessionKey: 'codex:question', runId: 'turn', requestId: 'question',
      kind, prompt: 'Synthetic explicit question', createdAt: now, expiresAt: now + 60_000,
    } };
    const snapshot = () => ({ version: 1, mode: 'interactive', capabilities: { version: 1, kinds: [kind], modes: ['interactive'] }, requests: [view] });
    const service = new WeixinService(f.hub.weixin, transport, async (_row, path, _signal, body) => {
      if (body) {
        writes++; assert.deepEqual((body as any).answer, kind === 'text' ? { kind, text: 'hello world' } : { kind, decision: 'allow-once' });
        assert.equal((body as any).expectedRevision, 1); assert.equal((body as any).runId, 'turn');
        return { ...view, status: 'answered', delivery: outcome === 'confirmed' ? 'confirmed' : 'unknown' };
      }
      if (path.endsWith('/interactions')) return snapshot();
      return { groups: [{ sessions: [{ sessionKey: session, title: 'Synthetic', status: 'waiting' }] }] };
    }, () => {}, () => now);
    try {
      const row = f.create(); f.hub.weixin.bind(row, account); f.hub.weixin.target(row, session, 'target');
      const command = async (text: string) => { now += 4000; transport.messages = [{ id: String(now), at: now, text, context: 'ctx', peerId: account.peerId }]; await service.tick(row); };
      await command('questions target'); assert.match(transport.sent.at(-1)!, /Synthetic explicit question/);
      const code = /^([a-f0-9]+) ·/.exec(transport.sent.at(-1)!)![1];
      if (outcome === 'revision') view.revision++;
      if (outcome === 'revoked') f.hub.identities.revokeKey('default', f.key.id);
      const answer = kind === 'text' ? `answer ${code} hello world` : `allow ${code}`;
      if (outcome === 'revoked') await assert.rejects(command(answer));
      else { await command(answer); await command(answer); }
      assert.equal(writes, ['revision', 'revoked'].includes(outcome) ? 0 : 1);
      if (outcome === 'unknown') assert.ok(transport.sent.some(text => text.includes('尚无原生确认')));
      if (outcome === 'confirmed') assert.ok(transport.sent.some(text => text.includes('原生交互已确认')));
    } finally { service.close(); f.close(); }
  });
}
test('WeChat encrypted binding survives restart; public status excludes credentials; Key revocation purges vault', async () => {
  const f = fixture();
  try {
    let row = f.create(); f.hub.weixin.bind(row, account); row = f.hub.weixin.get('default')!;
    assert.equal(f.hub.weixin.secrets(row).account?.token, account.token);
    assert.equal(readFileSync(f.file).includes(Buffer.from(account.token)), false);
    f.reopen(); row = f.hub.weixin.get('default')!; assert.equal(f.hub.weixin.secrets(row).account?.token, account.token);
    const service = new WeixinService(f.hub.weixin, mockTransport(), async () => ({}), () => {});
    const publicJson = JSON.stringify(service.status('default', true));
    for (const secret of [account.token, account.peerId, account.botId, f.key.token]) assert.equal(publicJson.includes(secret), false);
    f.hub.identities.revokeKey('default', f.key.id); assert.equal(f.hub.weixin.current(row), false);
    assert.deepEqual(f.hub.weixin.active(), []); assert.throws(() => f.hub.weixin.secrets(row)); service.close();
  } finally { f.close(); }
});
test('WeChat creation is idempotent, rate limited, scoped to personal Key and encryption', () => {
  const f = fixture(); try {
    const row = f.create(); assert.equal(f.hub.weixin.create('default', f.key.id, row.id).fresh, false);
    assert.throws(() => f.hub.weixin.create('default', f.key.id, randomUUID()), /busy/);
    assert.throws(() => f.hub.weixin.create('other', f.key.id, randomUUID()), /denied/);
    f.hub.weixin.remove('other', row.id); assert.ok(f.hub.weixin.current(row));
    f.hub.weixin.remove('default', randomUUID()); assert.ok(f.hub.weixin.current(row));
    for (let i = 0; i < 2; i++) { f.hub.weixin.remove('default'); f.create(); }
    f.hub.weixin.remove('default'); assert.throws(() => f.create(), /busy/);
  } finally { f.close(); }
});
test('WeChat replay ledger survives restart, and refreshing existing handles works at capacity', () => {
  const f = fixture(); try {
    let row = f.create(); f.hub.weixin.bind(row, account); row = f.hub.weixin.get('default')!;
    assert.equal(f.hub.weixin.claim(row, 'same'), true); f.reopen(); row = f.hub.weixin.get('default')!;
    assert.equal(f.hub.weixin.claim(row, 'same'), false);
    for (let i = 0; i < 50; i++) f.hub.weixin.target(row, `session-${i}`, `handle-${i}`);
    assert.equal(f.hub.weixin.target(row, 'session-0', 'replacement'), 'handle-0');
    assert.throws(() => f.hub.weixin.target(row, 'session-51', 'overflow'), /busy/);
    f.hub.weixin.recordDelivery(row, 'accepted'); f.hub.weixin.claim(row, 'new-inbound');
    assert.equal(f.hub.weixin.receipt(row)?.state, 'accepted', 'inbound claims are not delivery receipts');
  } finally { f.close(); }
});
test('WeChat unlink during QR response prevents late credential resurrection', async () => {
  const f = fixture(), transport = mockTransport(); let resolve!: (value: { code: string; url: string }) => void;
  transport.qr = () => new Promise(r => { resolve = r; });
  const service = new WeixinService(f.hub.weixin, transport, async () => ({}), () => {});
  try {
    const id = randomUUID(), pending = service.start('default', f.key.id, id, signal(), () => {});
    service.remove('default', id); resolve({ code: 'late', url: 'https://weixin.qq.com/late' });
    await assert.rejects(pending); assert.equal(f.hub.weixin.get('default'), undefined);
  } finally { service.close(); f.close(); }
});
test('WeChat only fresh bound-peer messages execute, unknown sends are not retried', async () => {
  const f = fixture(), transport = mockTransport(); let now = Date.now() + 1000, calls = 0;
  const service = new WeixinService(f.hub.weixin, transport, async () => { calls++; return { groups: [] }; }, () => {}, () => now);
  try {
    const row = f.create(); f.hub.weixin.bind(row, account); transport.result = 'unknown';
    transport.messages = [{ id: 'valid', peerId: account.peerId, at: now, text: 'sessions', context: 'context' },
      { id: 'old', peerId: account.peerId, at: now - 300_000, text: 'sessions', context: 'context' },
      { id: 'foreign', peerId: 'attacker', at: now, text: 'sessions', context: 'context' }];
    await service.tick(row); assert.equal(calls, 1); assert.equal(transport.sent.length, 1);
    now += 4000; await service.tick(row); assert.equal(calls, 1); assert.equal(transport.sent.length, 1);
    assert.equal(f.hub.weixin.receipt(row)?.state, 'unknown');
  } finally { service.close(); f.close(); }
});
test('WeChat notifications require explicit fresh runtime outcome and merge/deduplicate without text', async () => {
  const f = fixture(), transport = mockTransport(); let phase = 'running';
  const sessions = () => ({ groups: [{ sessions: [1, 2].map(i => ({ sessionKey: `s${i}`, title: 'PRIVATE TITLE', status: 'idle',
    runtime: { turnId: `t${i}`, phase, connection: 'connected', sync: 'current' } })) }] });
  const service = new WeixinService(f.hub.weixin, transport, async () => sessions(), () => {});
  try {
    const row = f.create(); f.hub.weixin.bind(row, account);
    f.hub.weixin.save(row, { ...f.hub.weixin.secrets(row), context: 'context', contextAt: Date.now() });
    for (const i of [1, 2]) { f.hub.weixin.target(row, `s${i}`, `h${i}`); f.hub.weixin.watch(row, `h${i}`, true); }
    await service.tick(row); assert.equal(transport.sent.length, 0);
    phase = 'completed'; await service.tick(row); assert.equal(transport.sent.length, 1);
    assert.match(transport.sent[0]!, /h1.*已完成/); assert.match(transport.sent[0]!, /h2.*已完成/); assert.doesNotMatch(transport.sent[0]!, /PRIVATE/);
    await service.tick(row); assert.equal(transport.sent.length, 1);
  } finally { service.close(); f.close(); }
});
test('WeChat stop requires one-time confirmation and fences changed Codex turn', async () => {
  const f = fixture(), transport = mockTransport(), session = encodeHubSessionId('local', 'codex:thread');
  let now = Date.now() + 1000, turn = 'first', executions = 0;
  const service = new WeixinService(f.hub.weixin, transport, async (_row, path, _signal, body) => {
    if (body) { executions++; assert.equal((body as any).expectedRunId, turn); return { status: 'interrupt_requested' }; }
    assert.equal(path, '/api/hub/v1/sessions/state');
    return { groups: [{ sessions: [{ sessionKey: session, title: 'Synthetic', status: 'running', runtime: { turnId: turn, phase: 'running', connection: 'connected', sync: 'current' } }] }] };
  }, () => {}, () => now);
  try {
    const row = f.create(); f.hub.weixin.bind(row, account); f.hub.weixin.target(row, session, 'target');
    const command = async (text: string) => { now += 4000; transport.messages = [{ id: String(now), at: now, text, context: 'c', peerId: account.peerId }]; await service.tick(row); };
    await command('stop target'); assert.equal(executions, 0);
    const first = /confirm ([a-f0-9]+)/.exec(transport.sent.at(-1)!)![1]!;
    turn = 'second'; await command(`confirm ${first}`); assert.equal(executions, 0);
    await command('stop target'); const second = /confirm ([a-f0-9]+)/.exec(transport.sent.at(-1)!)![1]!;
    await command(`confirm ${second}`); assert.equal(executions, 1);
    await command(`confirm ${second}`); assert.equal(executions, 1);
  } finally { service.close(); f.close(); }
});
for (const origin of ['http://ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com.evil.test', 'https://localhost', 'https://user@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com/path', 'https://ilinkai.weixin.qq.com:444']) test(`WeChat rejects credential origin ${origin}`, () => assert.throws(() => weixinOrigin(origin)));
test('WeChat transport preserves uint64 IDs, filters peers, sends exact wire format and forbids redirects', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const transport = new HttpWeixinTransport(async (url, init) => {
    requests.push({ url: String(url), init: init! });
    if (String(url).endsWith('getupdates')) return new Response('{"ret":0,"get_updates_buf":"next","msgs":[{"message_id":18446744073709551615,"message_type":1,"message_state":2,"from_user_id":"synthetic-peer","create_time_ms":10000,"context_token":"ctx","item_list":[{"type":1,"text_item":{"text":"help"}}]}]}');
    return Response.json({ ret: 0 });
  });
  const batch = await transport.receive(account, '', signal()); assert.equal(batch.messages[0]!.id, '18446744073709551615');
  assert.equal(await transport.send(account, 'ctx', 'hello', 'client-id', signal()), 'accepted');
  assert.equal(requests[0]!.init.redirect, 'error'); assert.equal((requests[0]!.init.headers as any).Authorization, `Bearer ${account.token}`);
  assert.equal(JSON.parse(requests[1]!.init.body as string).msg.to_user_id, account.peerId);
  for (const request of requests) {
    assert.deepEqual(JSON.parse(request.init.body as string).base_info, {
      channel_version: '2.4.9', bot_agent: `AgentOpsDeck/${AGENTOPSDECK_VERSION}`,
    });
  }
});
test('WeChat timeouts and errors are sanitized, unknown sends never retry, and bodies are bounded', async () => {
  let calls = 0;
  const transport = new HttpWeixinTransport(async () => { calls++; throw new Error('private upstream payload'); }, 20);
  assert.equal(await transport.send(account, 'ctx', 'hello', 'client', signal()), 'unknown'); assert.equal(calls, 1);
  await assert.rejects(transport.qr(signal()), { message: 'weixin_unavailable' });
  // A deadline requests cancellation; it cannot manufacture completion of an
  // uncooperative fetch. This provider acknowledges abort, as native fetch does.
  const hung = new HttpWeixinTransport((_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(new Error('private abort detail')), { once: true });
  }), 20);
  await assert.rejects(hung.qr(signal()), /weixin_unavailable/);
  const big = new HttpWeixinTransport(async () => new Response('x'.repeat(600_000)));
  await assert.rejects(big.qr(signal()), /invalid_response/);
});
test('WeChat empty poll retains cursor; QR confirmation and verification never expose credentials before bound', async () => {
  const requests: string[] = [];
  const transport = new HttpWeixinTransport(async url => { requests.push(String(url));
    return Response.json(String(url).includes('get_qrcode_status') ? { status: 'confirmed', ilink_bot_id: account.botId, ilink_user_id: account.peerId, bot_token: account.token, baseurl: account.baseUrl } : { ret: 0 });
  });
  assert.deepEqual(await transport.receive(account, 'old', signal()), { cursor: 'old', messages: [] });
  const result = await transport.pollQr('code', WEIXIN_ORIGIN, '1234', signal()); assert.equal(result.account?.token, account.token);
  assert.match(requests[1]!, /verify_code=1234/);
});
