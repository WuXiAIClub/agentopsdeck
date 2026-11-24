import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { Hono } from 'hono';
import { ChangeSignal } from '../utils/change-signal.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { closeMachineServices, workerConnectorMachineAuthority } from './machine-authority.js';
import { TerminalSessions, type TerminalPty, type TerminalTarget } from './terminals.js';
import { registerConnectorTerminals } from './terminals-http.js';
import { registerConnectorWebsiteRoutes } from './websites-http.js';
import { registerConnectorWebsiteAccess } from './website-access-http.js';
import { registerConnectorWebsiteActions } from './website-actions-http.js';
import { ConnectorBoardBindings, type BoardBindingInput } from './board-bindings.js';
import { registerConnectorBoardBindings } from './board-bindings-http.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
const quiet = new PerformanceDiagnostics(() => {});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'machine-authority-'));
  const owner = new AsyncConnectorOwner({ file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json') }, quiet);
  await owner.open();
  return { root, owner, authority: workerConnectorMachineAuthority(owner), async close() {
    await owner.close(); await rm(root, { recursive: true, force: true });
  } };
}
const target: TerminalTarget = { id: 'shell', label: 'Shell', kind: 'local', tokenIds: ['one'], cwd: tmpdir(), home: tmpdir(),
  path: '/usr/bin:/bin', executable: '/bin/sh', args: [] };
class FakePty implements TerminalPty {
  stopped = gate();
  writes: string[] = []; sizes: number[][] = []; killed = 0;
  data = new Set<(value: string) => void>();
  write(value: string) { this.writes.push(value); }
  resize(cols: number, rows: number) { this.sizes.push([cols, rows]); }
  kill() { this.killed++; this.stopped.release(); }
  onData(fn: (value: string) => void) { this.data.add(fn); return { dispose: () => { this.data.delete(fn); } }; }
  onExit(_fn: (event: { exitCode: number }) => void) { return { dispose() {} }; }
}
function http(app: Hono, token: string) {
  return (path: string, method = 'GET', body?: unknown, signal?: AbortSignal) => app.request(path, {
    method, headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}),
  });
}

test('original terminal HTTP uses real worker authority, original PTY and non-replayed request/input identities', async () => {
  const f = await fixture(), app = new Hono(), pty = new FakePty(); let spawns = 0;
  const token = await f.owner.command('tokenCreate', { label: 'shell', scopes: ['terminals:use'] });
  const routes = registerConnectorTerminals(app, f.authority, [{ ...target, tokenIds: [token.record.id] }], async () => { spawns++; return pty; });
  const req = http(app, token.token), base = '/api/connector/v1/terminals';
  try {
    const input = { targetId: 'shell', requestId: randomUUID(), cols: 80, rows: 24 };
    const started = await req(base, 'POST', input); assert.equal(started.status, 200);
    const { id } = await started.json();
    assert.deepEqual(await (await req(base, 'POST', input)).json(), { id }); assert.equal(spawns, 1);
    assert.equal((await req(`${base}/${id}/input`, 'POST', { sequence: 1, data: 'echo test\n' })).status, 200);
    assert.equal((await req(`${base}/${id}/input`, 'POST', { sequence: 1, data: 'echo test\n' })).status, 409);
    assert.deepEqual(pty.writes, ['echo test\n']);
    assert.equal((await req(`${base}/${id}/resize`, 'POST', { cols: 100, rows: 30 })).status, 200);
    assert.deepEqual(pty.sizes, [[100, 30]]);
    for (const emit of pty.data) emit('output');
    assert.equal((await (await req(`${base}/${id}/output?cursor=0`)).json()).data, 'output');
    const waiting = req(`${base}/${id}/output?cursor=6`);
    await tick(); await f.owner.command('tokenRevoke', { tokenId: token.record.id });
    assert.ok([401, 403, 404].includes((await waiting).status)); await pty.stopped.promise; assert.ok(pty.killed > 0);
    await routes.close(); assert.equal((await req(`${base}/targets`)).status, 503);
    assert.equal(f.owner.authorityChanges.waiting, 0);
  } finally { await routes.close(); await f.close(); }
});

for (const finalPermission of ['allow', 'reject'] as const) test(`terminal close retains delayed spawn and kills late physical PTY: ${finalPermission}`, async () => {
  const entered = gate(), held = gate(), pty = new FakePty(); let calls = 0;
  const sessions = new TerminalSessions(async () => { entered.release(); await held.promise; return pty; }, async () => {
    if (++calls > 1 && finalPermission === 'reject') throw Error('owner closed'); return true;
  });
  const work = sessions.start('one', target, randomUUID(), 80, 24);
  const observed = assert.rejects(work);
  try {
    await entered.promise; let closed = false;
    const drain = sessions.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false);
    await assert.rejects(sessions.start('one', target, randomUUID(), 80, 24));
    held.release(); await observed; await drain;
    assert.ok(pty.killed > 0); assert.equal(pty.data.size, 0);
  } finally { held.release(); await observed; await sessions.close(); }
});

for (const effect of ['write', 'resize'] as const) test(`terminal ${effect} rechecks local close after awaited authority without effect`, async () => {
  const entered = gate(), held = gate(), pty = new FakePty(); let delay = false, aborted = false;
  const sessions = new TerminalSessions(async () => pty, async () => { if (delay) { entered.release(); await held.promise; } return true; });
  const { id } = await sessions.start('one', target, randomUUID(), 80, 24);
  delay = true;
  const check = () => { if (aborted) throw Error('request aborted'); };
  const work = effect === 'write' ? sessions.write('one', id, 1, 'private', check) : sessions.resize('one', id, 100, 30, check);
  const observed = assert.rejects(Promise.resolve(work), /aborted/);
  try {
    await entered.promise; aborted = true; held.release(); await observed;
    assert.deepEqual(pty.writes, []); assert.deepEqual(pty.sizes, []);
  } finally { held.release(); await observed; await sessions.close(); }
});

test('terminal change hints wake current async authority and close releases its listener', async () => {
  const changes = new ChangeSignal(), revoked = gate(), pty = new FakePty(); let allowed = true;
  const sessions = new TerminalSessions(async () => pty, async () => { if (!allowed) revoked.release(); return allowed; }, Date.now, changes);
  try {
    await tick(); assert.equal(changes.waiting, 0, 'idle service must not occupy shared event admission');
    const { id } = await sessions.start('one', target, randomUUID(), 80, 24);
    const read = sessions.read('one', id, 0, new AbortController().signal);
    const observed = assert.rejects(read);
    allowed = false; changes.notify(); await revoked.promise; await observed;
    assert.ok(pty.killed > 0);
    await tick(); assert.equal(changes.waiting, 0, 'last revoked PTY releases the hint listener before service close');
  } finally { await sessions.close(); }
  assert.equal(changes.waiting, 0);
});

test('terminal hint listener is reacquired after an empty watcher drains', async () => {
  const changes = new ChangeSignal(), ptys: FakePty[] = [];
  const sessions = new TerminalSessions(async () => { const pty = new FakePty(); ptys.push(pty); return pty; }, async () => true, Date.now, changes);
  try {
    for (let i = 0; i < 3; i++) {
      const { id } = await sessions.start('one', target, randomUUID(), 80, 24);
      await tick(); assert.equal(changes.waiting, 1);
      await sessions.stop('one', id);
      await tick(); assert.equal(changes.waiting, 0);
    }
    assert.ok(ptys.every(pty => pty.killed > 0));
  } finally { await sessions.close(); }
});

test('snapshot HTTP cancels promptly but close retains late fetch and late body cleanup', async () => {
  const f = await fixture(), app = new Hono(), entered = gate(), fetched = gate(), cancelling = gate(), cleaned = gate();
  const token = await f.owner.command('tokenCreate', { label: 'reader', scopes: ['websites:read'] });
  const routes = registerConnectorWebsiteRoutes(app, f.authority, [{ id: 'dev', label: 'Dev', url: 'http://127.0.0.1:3000/' }], async () => {
    entered.release(); await fetched.promise;
    return new Response(new ReadableStream({ cancel() { cancelling.release(); return cleaned.promise; } }), { headers: { 'content-type': 'text/plain' } });
  });
  const abort = new AbortController(), req = http(app, token.token);
  const work = req('/api/connector/v1/websites/dev/snapshot', 'GET', undefined, abort.signal);
  try {
    await entered.promise; abort.abort(); assert.equal((await work).status, 408);
    let closed = false; const drain = routes.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false);
    fetched.release(); await cancelling.promise; await tick(); assert.equal(closed, false);
    cleaned.release(); await drain; assert.equal(closed, true);
  } finally { fetched.release(); cleaned.release(); await work; await routes.close(); await f.close(); }
});

test('real worker website action preserves the original single execution receipt and drains uncertain completion', async () => {
  const f = await fixture(), app = new Hono(), entered = gate(), held = gate(); let calls = 0, aborted = false;
  const token = await f.owner.command('tokenCreate', { label: 'writer', scopes: ['websites:act'] });
  const action = { id: 'save', label: 'Save', path: '/save', method: 'POST' as const, contentType: 'application/json' as const, maxBytes: 1024 };
  const routes = registerConnectorWebsiteActions(app, f.authority, [{ id: 'dev', label: 'Dev', url: 'http://127.0.0.1:3000/', actions: [action] }], async (_url, init) => {
    calls++; init!.signal!.addEventListener('abort', () => { aborted = true; }, { once: true });
    entered.release(); await held.promise; return Response.json({ saved: true });
  });
  const req = http(app, token.token), base = '/api/connector/v1/website-actions';
  let work: Promise<Response> | undefined;
  try {
    const { accessId } = await (await req(base, 'POST', { serviceId: 'dev', actionId: 'save' })).json();
    const original = Promise.resolve(req(`${base}/${accessId}/execute`, 'POST', { body: '{}' }));
    work = original; await entered.promise;
    assert.deepEqual(await (await req(`${base}/${accessId}/execute`, 'POST', { body: '{}' })).json(), { state: 'pending' });
    let closed = false; const drain = routes.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false); assert.equal(aborted, true);
    held.release(); assert.equal((await original).status, 503); await drain; assert.equal(calls, 1);
    assert.equal(f.owner.authorityChanges.waiting, 0);
  } finally { held.release(); await work; await routes.close(); await f.close(); }
});

test('real worker resource revoke aborts original fetch and does not retry', async () => {
  const f = await fixture(), app = new Hono(), entered = gate(); let calls = 0;
  const token = await f.owner.command('tokenCreate', { label: 'browser', scopes: ['websites:browse'] });
  const routes = registerConnectorWebsiteAccess(app, f.authority, [{ id: 'dev', label: 'Dev', url: 'http://127.0.0.1:3000/', browse: true }], async (_url, init) => {
    calls++; entered.release();
    return new Promise((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(Error('aborted')), { once: true }); });
  });
  const req = http(app, token.token), base = '/api/connector/v1/website-access';
  try {
    const { accessId } = await (await req(base, 'POST', { serviceId: 'dev' })).json();
    const work = req(`${base}/${accessId}/resource`, 'POST', { path: '/' }); await entered.promise;
    await f.owner.command('tokenRevoke', { tokenId: token.record.id });
    assert.ok((await work).status >= 400); assert.equal(calls, 1);
    await routes.close(); assert.equal(f.owner.authorityChanges.waiting, 0);
  } finally { await routes.close(); await f.close(); }
});

test('real worker website socket uses original loopback channel and drains physical close on revoke', async () => {
  const server = createServer(), sockets = new WebSocketServer({ server }), closed = gate();
  sockets.on('connection', ws => { ws.on('message', data => ws.send(data)); ws.once('close', closed.release); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const f = await fixture(), app = new Hono();
  const token = await f.owner.command('tokenCreate', { label: 'channel', scopes: ['websites:browse', 'websites:connect'] });
  const routes = registerConnectorWebsiteAccess(app, f.authority, [{ id: 'dev', label: 'Dev', url: `http://127.0.0.1:${address.port}/`, browse: true, sockets: [{ path: '/echo', protocols: [] }] }]);
  const req = http(app, token.token), base = '/api/connector/v1/website-access';
  try {
    const { accessId } = await (await req(base, 'POST', { serviceId: 'dev' })).json();
    const socketBase = `${base}/${accessId}/sockets`;
    const opened = await req(socketBase, 'POST', { path: '/echo', protocols: [] }); assert.equal(opened.status, 200);
    const { socketId } = await opened.json(), endpoint = `${socketBase}/${socketId}`;
    assert.equal((await req(`${endpoint}/input`, 'POST', { bodyBase64: Buffer.from('hello').toString('base64'), binary: false })).status, 200);
    assert.equal((await req(`${endpoint}/output`)).status, 200);
    const waiting = req(`${endpoint}/output`);
    await f.owner.command('tokenRevoke', { tokenId: token.record.id });
    assert.ok((await waiting).status >= 400); await routes.close(); await closed.promise;
    assert.equal(f.owner.authorityChanges.waiting, 0);
  } finally {
    await routes.close(); await f.close();
    for (const ws of sockets.clients) ws.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

const endpoint = 'http://127.0.0.1:8791/api/workspace-agent/v1/board';
const binding = (): BoardBindingInput => ({ id: randomUUID(), runtime: 'ghcp', sessionId: randomUUID(),
  credential: { endpoint, token: 'aod_board_' + 'a'.repeat(43), expiresAt: Date.now() + 60_000 } });

for (const outcome of ['deny', 'reject', 'closed'] as const) test(`async binding final authority ${outcome} compensates original credential publication`, { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'async-binding-')), directory = join(root, 'private');
  await mkdir(directory, { mode: 0o700 }); const input = binding(); let stopped = false;
  const store = new ConnectorBoardBindings({ ghcp: directory }, [{ owner: 'one', runtime: 'ghcp', endpoint }], async () => {
    if ((await readdir(directory)).includes(`ghcp-${input.sessionId}.json`)) {
      if (outcome === 'reject') throw Error('owner failed');
      if (outcome === 'deny') return false;
      stopped = true;
    }
    return true;
  });
  try {
    await assert.rejects(store.install('one', input, () => { if (stopped) throw Error('closed'); }));
    const files = await readdir(directory);
    assert.ok(!files.includes(`ghcp-${input.sessionId}.json`));
    assert.ok(files.includes(`.removed-ghcp-${input.id}.json`));
    assert.ok(!files.some(file => file.endsWith('.pending')));
    await assert.rejects(store.install('one', input));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('binding original HTTP awaits real worker token and native session resolution with retained revoke cleanup', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture(), directory = join(f.root, 'private'), app = new Hono(); await mkdir(directory, { mode: 0o700 });
  const token = await f.owner.command('tokenCreate', { label: 'binder', scopes: ['boards:bind'] }); const input = binding();
  const routes = registerConnectorBoardBindings(app, { tokens: f.authority, directories: { ghcp: directory },
    policies: [{ owner: token.record.id, runtime: 'ghcp', endpoint }],
    resolveSession: async () => ({ runtime: 'ghcp', sessionId: input.sessionId, ready: true }),
  });
  const req = http(app, token.token), base = '/api/connector/v1/sessions/native/board-binding';
  try {
    await routes.ready;
    const grant = { id: input.id, credential: input.credential };
    assert.equal((await req(base, 'PUT', grant)).status, 200);
    assert.equal((await req(base, 'PUT', grant)).status, 200);
    assert.equal((await req(base)).status, 200);
    await f.owner.command('tokenRevoke', { tokenId: token.record.id }); await routes.close();
    assert.ok(!(await readdir(directory)).includes(`ghcp-${input.sessionId}.json`));
    assert.equal(f.owner.authorityChanges.waiting, 0);
    assert.equal((await req(base)).status, 503);
  } finally { await routes.close(); await f.close(); }
});

test('machine service close starts every sibling synchronously and retains all effects after a sibling throws', async () => {
  const held = gate(), calls: number[] = [], failure = Error('first'); let finished = false;
  const work = closeMachineServices([() => { calls.push(1); throw failure; },
    () => { calls.push(2); return held.promise; }, () => { calls.push(3); }]);
  const observed = assert.rejects(work, error => error === failure).then(() => { finished = true; });
  assert.deepEqual(calls, [1, 2, 3]); await tick(); assert.equal(finished, false);
  held.release(); await observed;
});
