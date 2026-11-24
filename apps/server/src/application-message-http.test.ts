import assert from 'node:assert/strict';
import { awaitHttpAdmission, controlledHttpDeadline } from './lifecycle/http-deadline-test-support.js';
import test from 'node:test';
import { Hono } from 'hono';
import { sessionRuntimeId, type CommandReceipt } from '@agentopsdeck/shared';
import { registerApplicationMessagesHttp } from './application-message-http.js';
import { createApplicationMessageIngress } from './application-message-ingress.js';
import { createApplicationStopIngress } from './application-stop-ingress.js';
import { createApplicationStatusIngress } from './application-status-ingress.js';
import { createApplicationCompactIngress } from './application-compact-ingress.js';
import { createApplicationCommandScopes } from './auth/application-command-scope.js';
import { PerformanceDiagnostics } from './diagnostics/performance.js';
import { readJsonBody } from './utils/http-body.js';

const gate = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };
const tick = () => new Promise<void>(r => setImmediate(r));
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < end, 'HTTP owner did not converge'); await tick(); }
}
const runtimes = ['codex', 'openclaw', 'claude-code', 'ghcp', 'hermes'] as const;
type Scope = { key: string; commandKey: string; authorization: string };
function fixture(timeoutMs = 2000, stops = false, statuses = false, compacts = false) {
  let live = true, actor: string | undefined = 'original-admin', reads = 0;
  const logs: string[] = [], observed: string[] = [], sends: unknown[] = [], stopSends: unknown[] = [];
  const statusSends: unknown[] = [], statusReads: unknown[] = [];
  const compactSends: unknown[] = [], compactReads: unknown[] = [];
  const diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const hooks: { read?: () => Promise<void>; send?: () => Promise<void> } = {};
  const observe = (request: Request) => { observed.push(request.headers.get('x-agentopsdeck-key') ?? ''); return actor; };
  const commands = createApplicationCommandScopes({ authorize: request => !!observe(request),
    assertAvailable() { if (!live) throw Error('closed'); }, diagnostics });
  const result = (s: Scope) => ({ key: s.key, commandKey: s.commandKey,
    receipt: s.commandKey === 'missing' ? null : { id: 'original-receipt', key: s.commandKey,
      state: 'accepted', createdAt: 1, updatedAt: 1, result: { status: 202, body: { status: 'queued' } } } satisfies CommandReceipt,
    queue: { presence: 'absent' as const }, intent: null, admitted: true });
  const send = async <T extends Scope>(input: T) => { sends.push(input); await hooks.send?.(); return result(input); };
  const read = async (input: Scope) => { reads++; assert.equal(input.authorization, 'Bearer startup-only-private'); await hooks.read?.(); return result(input); };
  const codex = { sendPhysical: send, readReceiptPhysical: read, readSendReceiptPhysical: read };
  const openclaw = codex;
  const sdk = {
    sendPhysical: async (input: Scope & { runtime: 'claude-code' | 'ghcp' }) => ({ ...await send(input), runtime: input.runtime }),
    readReceiptPhysical: async (input: Scope & { runtime: 'claude-code' | 'ghcp' }) => ({ ...await read(input), runtime: input.runtime }),
    readSendReceiptPhysical: async (input: Scope & { runtime: 'claude-code' | 'ghcp' }) => ({ ...await read(input), runtime: input.runtime }),
  };
  const hermes = {
    sendPhysical: async (input: Scope) => ({ ...await send(input), runtime: 'hermes' as const }),
    readReceiptPhysical: async (input: Scope) => ({ ...await read(input), runtime: 'hermes' as const }),
    readSendReceiptPhysical: async (input: Scope) => ({ ...await read(input), runtime: 'hermes' as const }),
  };
  const ingress = createApplicationMessageIngress(commands, { codex, openclaw, sdk, hermes }, { messageTransactions: true });
  const stop = async (input: Scope & { payloadJson: string }) => {
    stopSends.push(input); await hooks.send?.(); return result(input);
  };
  const stopIngress = stops ? createApplicationStopIngress(commands, {
    codex: { stopPhysical: stop }, openclaw: { stopPhysical: stop },
    hermes: { stopPhysical: async input => ({ ...await stop(input), runtime: 'hermes', execution: null }) },
    sdk: { stopPhysical: async input => {
      const value = await stop(input); assert.ok(value.receipt);
      return { runtime: input.runtime, key: input.key, commandKey: input.commandKey, receipt: value.receipt, execution: null };
    } },
  }, { transactions: true }) : undefined;
  const statusSend = async (input: Scope & { payloadJson: string }) => {
    statusSends.push(input); await hooks.send?.(); return { ...result(input), admitted: false as const, report: null };
  };
  const statusRead = async (input: Scope) => {
    statusReads.push(input); await hooks.read?.(); return { ...result(input), admitted: false as const, report: null };
  };
  const statusIngress = statuses ? createApplicationStatusIngress(commands, {
    openclaw: { sendPhysical: statusSend, readPhysical: statusRead },
    hermes: { sendPhysical: async input => ({ ...await statusSend(input), runtime: 'hermes' }),
      readPhysical: async input => ({ ...await statusRead(input), runtime: 'hermes' }) },
    sdk: { sendPhysical: async input => ({ ...await statusSend(input), runtime: input.runtime }),
      readPhysical: async input => ({ ...await statusRead(input), runtime: input.runtime }) },
  }, { transactions: true }) : undefined;
  const compactIngress = compacts ? createApplicationCompactIngress(commands, {
    openclaw: {
      compactPhysical: async input => { compactSends.push(input); await hooks.send?.(); return { ...result(input), projection: null }; },
      readPhysical: async input => { compactReads.push(input); return { ...result(input), projection: null }; },
    },
    sdk: {
      compactPhysical: async input => { compactSends.push(input); await hooks.send?.(); return 'accepted'; },
      readPhysical: async input => {
        compactReads.push(input); return { runtime: input.runtime, key: input.key, commandKey: input.commandKey,
          receipt: compactSends.length ? result(input).receipt : null };
      },
    },
  }, { transactions: true }) : undefined;
  const app = new Hono();
  const http = registerApplicationMessagesHttp(app, { commands, ingress, credentials: { token: () => 'startup-only-private' },
    observeActor: observe, available: () => live, ports: { codex, openclaw, sdk, hermes }, ...(stopIngress ? { stopIngress } : {}),
    ...(statusIngress ? { statusIngress } : {}), ...(compactIngress ? { compactIngress } : {}), timeoutMs, diagnostics });
  app.post('/api/sessions/:sessionKey/messages', async c => {
    // Exercise the actual raw-request forwarding boundary, not only Hono's
    // JSON cache. The downstream owner must receive the unconsumed body.
    const forwarded = await readJsonBody(c.req.raw, 100_000);
    assert.deepEqual(forwarded, await c.req.json());
    assert.notEqual(c.req.header('authorization'), 'Bearer startup-only-private');
    return c.json({ control: true });
  });
  const path = (runtime = 'openclaw') => `/api/sessions/${encodeURIComponent(`${runtime}:original`)}`;
  const request = (suffix: string, init: RequestInit = {}, runtime?: string) => app.request(path(runtime) + suffix, init);
  const post = (body: unknown, headers: HeadersInit = {}, runtime?: string) => request('/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  }, runtime);
  return { commands, http, hooks, logs, observed, sends, stopSends, statusSends, statusReads, compactSends, compactReads, request, post, get reads() { return reads; },
    revoke() { actor = undefined; }, freeze() { live = false; } };
}

for (const runtime of ['openclaw', 'claude-code', 'ghcp']) test(`local HTTP ${runtime}: dedicated compact, recovery and original identity wire`, async () => {
  const f = fixture(2000, true, true, true);
  try {
    const post = (body: unknown, headers: Record<string, string> = {}) => f.request('/compact', { method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'original-cookie', ...headers }, body: JSON.stringify(body) }, runtime);
    const response = await post({ idempotencyKey: 'original-compact' });
    assert.equal(response.status, 202); assert.equal((await response.json()).command.id, 'original-receipt');
    assert.equal(f.compactSends.length, 1); assert.equal(f.sends.length, 0);
    assert.deepEqual(f.compactSends[0], { key: `${runtime}:original`, commandKey: 'original-compact', authorization: 'Bearer startup-only-private',
      payloadJson: '{}', application: { cookie: 'original-cookie' }, ...(runtime === 'openclaw' ? { operation: 'compact' } : { runtime }) });
    assert.equal((await f.request('/compact-commands/original-compact', {}, runtime)).status, 200);
    assert.equal(f.compactSends.length, 1);
    assert.equal((await post({ message: '/compact' })).status, 400);
    assert.equal((await post({ idempotencyKey: 'body' }, { 'idempotency-key': 'different' })).status, 400);
    assert.equal((await post({}, { 'x-agentopsdeck-execution-grant': 'forged' })).status, 403);
    assert.doesNotMatch(f.logs.join('\n'), /original-cookie|startup-only-private|original-compact/);
  } finally { await f.http.close(); await f.commands.close(); }
});

test('local HTTP: only original OpenClaw compact text is intercepted; unsupported SDK text is preserved', async () => {
  const f = fixture(2000, true, true, true);
  try {
    assert.equal((await f.post({ message: '/compact', idempotencyKey: 'message-compact' })).status, 202);
    assert.equal(f.compactSends.length, 1);
    assert.deepEqual(f.compactSends[0], { key: 'openclaw:original', commandKey: 'message-compact', authorization: 'Bearer startup-only-private',
      payloadJson: '{"message":"/compact"}', application: {}, operation: 'message' });
    for (const runtime of ['claude-code', 'ghcp']) {
      const response = await f.post({ message: '/compact extra' }, {}, runtime);
      assert.equal((await response.json()).control, true);
    }
    const unsupported = await f.post({ message: '/compact' }, {}, 'hermes');
    assert.equal((await unsupported.json()).control, true);
    assert.equal(f.compactSends.length, 1); assert.equal(f.sends.length, 0);
  } finally { await f.http.close(); await f.commands.close(); }
});

for (const runtime of ['openclaw', 'hermes', 'claude-code', 'ghcp']) test(`local HTTP ${runtime}: status original ingress and read-only recovery share private transport`, async () => {
  const f = fixture(2000, true, true);
  try {
    const response = await f.post({ message: ' /status ', idempotencyKey: 'original-status' }, { cookie: 'original-cookie' }, runtime);
    assert.equal(response.status, 202); assert.equal(f.sends.length, 0); assert.equal(f.stopSends.length, 0);
    assert.equal(f.statusSends.length, 1); assert.equal(f.statusReads.length, 1);
    assert.deepEqual(f.statusSends[0], { key: `${runtime}:original`, commandKey: 'original-status',
      authorization: 'Bearer startup-only-private', payloadJson: '{"message":" /status "}',
      application: { cookie: 'original-cookie' }, ...(runtime === 'claude-code' || runtime === 'ghcp' ? { runtime } : {}) });
    assert.equal((await f.request('/commands/original-status', {}, runtime)).status, 200);
    assert.equal((await f.request('/commands/original-status/queue', {}, runtime)).status, 200);
    assert.equal(f.statusReads.length, 3); assert.equal(f.statusSends.length, 1);
    f.revoke(); assert.equal((await f.request('/commands/original-status', {}, runtime)).status, 403);
    assert.equal(f.statusReads.length, 3, 'revoked application cannot read/project a buffered report');
    assert.doesNotMatch(f.logs.join('\n'), /original-cookie|startup-only-private|original-status/);
  } finally { await f.http.close(); await f.commands.close(); }
});

test('local HTTP: Codex status and OpenClaw media status retain original ordinary message semantics', async () => {
  const f = fixture(2000, true, true);
  try {
    assert.equal((await f.post({ message: '/status' }, {}, 'codex')).status, 202);
    assert.equal((await f.post({ message: '/status', media: [{ type: 'image', path: 'original' }] }, {}, 'openclaw')).status, 202);
    assert.equal(f.sends.length, 2); assert.equal(f.statusSends.length, 0);
  } finally { await f.http.close(); await f.commands.close(); }
});

for (const runtime of runtimes) test(`local HTTP ${runtime}: /stop uses original stop ingress, not ordinary message or slash fallback`, async () => {
  const f = fixture(2000, true);
  try {
    const response = await f.post({ message: ' /stop ', expectedRunId: 'original-run', idempotencyKey: 'original-stop' },
      { cookie: 'original-cookie', 'x-agentopsdeck-key': 'original-key' }, runtime);
    assert.equal(response.status, 202); assert.equal((await response.json()).command.id, 'original-receipt');
    assert.equal(f.sends.length, 0); assert.equal(f.stopSends.length, 1);
    assert.deepEqual(f.stopSends[0], { key: `${runtime}:original`, commandKey: 'original-stop',
      authorization: 'Bearer startup-only-private', payloadJson: '{"message":" /stop ","expectedRunId":"original-run"}',
      application: { cookie: 'original-cookie', accessKey: 'original-key' },
      ...(runtime === 'claude-code' || runtime === 'ghcp' ? { runtime } : {}) });
    assert.equal((await f.request('/commands/original-stop', {}, runtime)).status, 200);
    assert.equal(f.stopSends.length, 1, 'receipt recovery never interrupts again');
    assert.doesNotMatch(f.logs.join('\n'), /original-cookie|original-key|startup-only-private|original-run|original-stop/);
  } finally { await f.http.close(); await f.commands.close(); }
});

test('local HTTP /stop waiter timeout retains original physical work and shutdown drain', async t => {
  const f = fixture(30, true), native = gate(), entered = gate(); let drained = false;
  f.hooks.send = async () => { entered.release(); await native.promise; };
  const clock = controlledHttpDeadline(t);
  try {
    const pending = f.post({ message: '/stop', expectedRunId: 'original-run', idempotencyKey: 'original-stop' });
    await awaitHttpAdmission(entered.promise, pending);
    const response = await clock.expire(30, pending);
    assert.equal(response.status, 503); assert.equal(f.stopSends.length, 1); assert.equal(f.sends.length, 0);
    // The HTTP waiter and the physical command scope are separate owners.
    // Parent shutdown waits both; closing HTTP alone must not retire a command.
    const closing = Promise.all([f.http.close(), f.commands.close()]).then(() => { drained = true; });
    await tick(); assert.equal(drained, false); assert.ok(f.commands.pending > 0);
    native.release(); await closing; await f.commands.close(); assert.equal(drained, true);
  } finally { clock.restore(); native.release(); await f.http.close(); await f.commands.close(); }
});

for (const runtime of runtimes) test(`local HTTP ${runtime}: original evidence, fixed transport and receipt wire`, async () => {
  const f = fixture();
  try {
    const response = await f.post({ message: 'original-private-text', idempotencyKey: 'original-command' }, {
      'x-agentopsdeck-key': 'original-browser-key', authorization: 'Bearer browser-not-transport', cookie: 'original-cookie',
      'x-agentopsdeck-node-id': 'untrusted-node',
    }, runtime);
    assert.equal(response.status, 202); assert.equal(response.headers.get('x-agentopsdeck-command-key'), 'original-command');
    assert.equal((await response.json()).command.id, 'original-receipt');
    assert.equal(f.sends.length, 1);
    assert.deepEqual(f.sends[0], { key: `${runtime}:original`, commandKey: 'original-command',
      authorization: 'Bearer startup-only-private', payloadJson: '{"message":"original-private-text"}',
      ...(runtime === 'ghcp' || runtime === 'claude-code' ? { runtime } : {}),
      application: { authorization: 'Bearer browser-not-transport', accessKey: 'original-browser-key', cookie: 'original-cookie' },
    });
    assert.ok(f.observed.length >= 4); assert.ok(f.observed.every(value => value === 'original-browser-key'));
    const receipt = await f.request('/commands/original-command', {}, runtime);
    assert.equal(receipt.status, 200); assert.equal((await receipt.json()).command.id, 'original-receipt');
    assert.deepEqual(await (await f.request('/commands/original-command/queue', {}, runtime)).json(),
      { commandKey: 'original-command', queue: { presence: 'absent' } });
    assert.equal((await f.request('/commands/missing', {}, runtime)).status, 404);
    assert.equal(f.sends.length, 1, 'receipt recovery never sends or runs files');
    assert.equal(sessionRuntimeId(`${runtime}:original`), runtime);
    assert.doesNotMatch(f.logs.join('\n'), /original-browser-key|startup-only-private|original-cookie|original-private-text|original-command|untrusted-node/);
  } finally { await f.http.close(); await f.commands.close(); }
});

test('local HTTP: no-Key, generated keys, conflicts, malformed input and grants', async () => {
  const f = fixture();
  try {
    const generated = await f.post({ message: 'no-Key' });
    assert.equal(generated.status, 202); assert.ok(generated.headers.get('x-agentopsdeck-command-key'));
    assert.equal((await f.post({ message: 'x', idempotencyKey: 'body' }, { 'idempotency-key': 'header' })).status, 400);
    assert.equal((await f.post({ message: 'x', idempotencyKey: {} })).status, 400);
    assert.equal((await f.post([])).status, 400);
    assert.equal((await f.post({ message: 'x' }, { 'x-agentopsdeck-execution-grant': 'untrusted-grant' })).status, 403);
    assert.equal(f.sends.length, 1);
    f.freeze(); assert.equal((await f.post({ message: 'closed' })).status, 503);
  } finally { await f.http.close(); await f.commands.close(); }
});

for (const runtime of runtimes) test(`local HTTP ${runtime}: legacy slash controls never become ordinary messages`, async () => {
  const f = fixture();
  try {
    const controls = runtime === 'codex' ? ['/stop'] : ['/stop', '/status', '/compact'];
    if (runtime === 'claude-code' || runtime === 'ghcp') controls.push('/compact preserve context');
    for (const message of controls) {
      const response = await f.post({ message }, {}, runtime);
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), { control: true });
    }
    assert.equal(f.sends.length, 0); assert.equal(f.reads, 0);
  } finally { await f.http.close(); await f.commands.close(); }
});

for (const runtime of ['codex', 'openclaw'] as const) test(`local HTTP ${runtime}: original slash prose/media semantics remain ordinary`, async () => {
  const f = fixture();
  try {
    for (const message of ['/status', '/compact']) {
      const payload = { message, ...(runtime === 'openclaw' ? { media: [{ type: 'image', data: 'bounded-original-image' }] } : {}) };
      assert.equal((await f.post(payload, {}, runtime)).status, 202);
    }
    assert.equal(f.sends.length, 2);
    if (runtime === 'openclaw') {
      const result = await f.post({ message: '/compact', media: [{}], deliveryMode: 'mirror' }, {}, runtime);
      assert.deepEqual(await result.json(), { control: true }); assert.equal(f.sends.length, 2);
    }
  } finally { await f.http.close(); await f.commands.close(); }
});

test('local HTTP: original body capacity is bounded and close retains both actual readers', async () => {
  const f = fixture(5000);
  const held = () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    const request = f.request('/messages', { method: 'POST', body, duplex: 'half' } as RequestInit);
    return { request, release() { controller.enqueue(new TextEncoder().encode('{"message":"original body"}')); controller.close(); } };
  };
  const first = held(), second = held(); let closing: Promise<void> | undefined;
  try {
    await until(() => f.http.pending === 2);
    assert.equal((await f.post({ message: 'over capacity' })).status, 503);
    let closed = false; closing = f.http.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false); assert.equal(f.http.pending, 2);
    assert.equal((await f.post({ message: 'frozen' })).status, 503);
  } finally {
    first.release(); second.release();
    assert.equal((await first.request).status, 503); assert.equal((await second.request).status, 503);
    await closing; await f.http.close(); await f.commands.close();
  }
  assert.equal(f.sends.length, 0); assert.equal(f.http.pending, 0);
});

test('local HTTP: revoke during physical receipt read suppresses buffered success', async () => {
  const f = fixture(), entered = gate(), physical = gate();
  f.hooks.read = async () => { entered.release(); await physical.promise; };
  try {
    const pending = f.request('/commands/original-command'); await awaitHttpAdmission(entered.promise, pending);
    f.revoke(); physical.release(); assert.equal((await pending).status, 503);
    assert.equal(f.sends.length, 0); assert.equal(f.commands.pending, 0);
  } finally { physical.release(); await f.http.close(); await f.commands.close(); }
});

test('local HTTP: read deadline retains original command and authority through actual drain', async t => {
  const f = fixture(100), entered = gate(), physical = gate();
  f.hooks.read = async () => { entered.release(); await physical.promise; };
  let closing: Promise<void> | undefined;
  const clock = controlledHttpDeadline(t);
  try {
    const pending = f.request('/commands/original-command'); await awaitHttpAdmission(entered.promise, pending);
    assert.equal((await clock.expire(100, pending)).status, 503); assert.equal(f.commands.pending, 1); assert.equal(f.http.pending, 1);
    let closed = false; closing = f.http.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false);
    assert.equal((await f.request('/commands/original-command')).status, 503);
  } finally { clock.restore(); physical.release(); await closing; await f.commands.close(); }
  assert.equal(f.commands.pending, 0); assert.equal(f.http.pending, 0); assert.equal(f.sends.length, 0);
});
