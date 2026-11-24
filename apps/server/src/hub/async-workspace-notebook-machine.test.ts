import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Hono} from 'hono';
import {asyncNativeFileFixture, nativeNotebook, deferredNative} from './async-native-file-fixture.js';
import {AsyncWorkspaceNotebookMachine} from './async-workspace-notebook-machine.js';
import {createHubAdministrativeServices} from './administrative-route-services.js';
import {notebookHash, NotebookMoveConflict, type NotebookMove} from './notebook-operations.js';
import {validHubNotebookMachineCommand, notebookMachineExpectation, validHubNotebookMachineReply} from './member-notebook-machine-domain.js';
import {registerWorkspaceAgentNotebook} from '../routes/workspace-agent-notebook.js';
import {registerHubSessionNotebookRoutes} from '../routes/hub-session-notebooks.js';
import type {NotebookFacet} from './notebook-capabilities.js';

const path = '/api/workspace-agent/v1/notebook';
const status = (code: number) => (e: unknown) => !!e && typeof e === 'object' && 'status' in e && e.status === code;
const tick = () => new Promise<void>(done => setImmediate(done));
async function fixture(t: TestContext, mode: 'original' | 'worker', bound = false, facets: NotebookFacet[] = ['hot:read', 'cold:read', 'move']) {
  const f = await asyncNativeFileFixture(t, mode, 'card');
  let bindingId: string | undefined;
  if (bound) {
    bindingId = randomUUID();
    await (await f.begin()).bind({requestId: bindingId, sessionId: f.sessionId, revision: f.revision});
  }
  const services = createHubAdministrativeServices(f.current().owner);
  const issued = await services.notebookControl.issue(f.request(), 'default', nativeNotebook, {facets, expiresAt: Date.now() + 60_000});
  assert.ok(issued);
  const machine = new AsyncWorkspaceNotebookMachine(f.current().port, f.current().service);
  const token = issued.token;
  t.after(async () => {await machine.close(); await services.close(); assert.equal(f.logs.join('').includes(token), false);});
  const input = (): NotebookMove => ({requestId: randomUUID(), direction: 'archive', ...f.notebookRevisions(),
    ranges: [{start: 4, end: 7, sha256: notebookHash('old')}]});
  const revoke = () => services.notebookControl.revoke(f.request(), 'default', nativeNotebook, issued.capability.id);
  const app = new Hono(); registerWorkspaceAgentNotebook(app, {mode: 'async', notebookMachine: machine});
  const headers = {authorization: `Bearer ${token}`};
  return {f, services, machine, token, input, revoke, bindingId, app, headers};
}

for (const mode of ['original', 'worker'] as const) {
  test(`${mode}: machine local slice/search/dual CAS/receipt preserves wire and UUID intent`, async t => {
    const {f, machine, token, input, app, headers} = await fixture(t, mode);
    const response = await app.request(path, {headers});
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {resourceId: nativeNotebook, area: 'hot', revision: 1, start: 0, end: 7, total: 7, text: 'new old'});
    const search = await machine.read(f.request(), token, [['q', 'old'], ['area', 'both']]);
    assert.equal(search.status, 200);
    assert.equal((await machine.read(f.request(), token, [['area', 'both']])).status, 400);
    assert.equal((await machine.read(f.request(), token, [['revision', '0']])).status, 409);
    assert.equal((await machine.read(f.request(), token, [['area', 'hot'], ['area', 'cold']])).status, 400);
    const move = input(), saved = await machine.move(f.request(), token, move.requestId, move);
    assert.equal(saved?.moved, 3);
    assert.deepEqual(await machine.move(f.request(), token, move.requestId), saved);
    assert.deepEqual(await machine.move(f.request(), token, move.requestId, move), saved);
    await assert.rejects(machine.move(f.request(), token, move.requestId, {...move, direction: 'restore'}), NotebookMoveConflict);
    assert.equal(f.calls.write, 0);
    const cold = await machine.read(f.request(), token, [['area', 'cold']]);
    assert.equal(cold.status, 200); assert.ok('text' in cold.body && cold.body.text === 'old');
    assert.equal((await app.request(`${path}/moves/${randomUUID()}`, {headers})).status, 404);
    assert.equal((await app.request(`${path}/moves/bad`, {headers})).status, 400);
  });

  test(`${mode}: hot-only machine cannot read cold/search-both/move or select a human owner`, async t => {
    const {f, machine, token, input, app, headers} = await fixture(t, mode, false, ['hot:read']);
    assert.equal((await machine.read(f.request(), token, [])).status, 200);
    await assert.rejects(machine.read(f.request(), token, [['area', 'cold']]), status(403));
    await assert.rejects(machine.read(f.request(), token, [['area', 'both'], ['q', 'old']]), status(403));
    const move = input(); await assert.rejects(machine.move(f.request(), token, move.requestId, move), status(403));
    assert.equal((await app.request(path + '/moves', {method: 'POST', headers, body: JSON.stringify(move)})).status, 403);
    assert.equal(validHubNotebookMachineCommand({token, action: 'context', userId: 'default'}), false);
    assert.equal(validHubNotebookMachineCommand({token, action: 'read', query: [], owner: 'default'}), false);
    assert.deepEqual(f.notebookRevisions(), {hotRevision: 1, coldRevision: 0});
  });

  test(`${mode}: read delivery rechecks original grant and owns mutable query before ACK`, async t => {
    const {f, machine, token, revoke} = await fixture(t, mode);
    const entered = deferredNative(), release = deferredNative();
    const command = f.current().port.command;
    const guarded = new AsyncWorkspaceNotebookMachine({command: async (kind, input) => {
      const result = await command(kind, input);
      if (kind === 'notebookMachine' && (input as {action: string}).action === 'read') {entered.resolve(); await release.promise;}
      return result;
    }}, f.current().service);
    t.after(() => guarded.close());
    const query: [string, string][] = [['area', 'hot']];
    const flight = guarded.read(f.request(), token, query); await entered.promise;
    query[0]![1] = 'cold'; await revoke(); release.resolve();
    await assert.rejects(flight, status(403));
    assert.equal(await machine.authorized(f.request(), token), false);
  });

  test(`${mode}: read query is copied independently of a still-valid original grant`, async t => {
    const {f, token} = await fixture(t, mode);
    const entered = deferredNative(), release = deferredNative();
    const guarded = new AsyncWorkspaceNotebookMachine({command: async (kind, input) => {
      const result = await f.current().port.command(kind, input);
      if (kind === 'notebookMachine' && (input as {action: string}).action === 'read') {entered.resolve(); await release.promise;}
      return result;
    }}, f.current().service);
    t.after(() => guarded.close());
    const query: [string, string][] = [['area', 'hot']], flight = guarded.read(f.request(), token, query);
    await entered.promise; query[0]![1] = 'cold'; query.push(['revision', '999']); release.resolve();
    const result = await flight;
    assert.equal(result.status, 200); assert.ok('text' in result.body && result.body.area === 'hot' && result.body.text === 'new old');
  });

  for (const malformed of [false, true]) test(`${mode}: body-wait revocation rejects ${malformed ? 'malformed' : 'valid'} machine move before admission`, async t => {
    const {f, app, headers, input, revoke} = await fixture(t, mode, true);
    const revisions = f.notebookRevisions();
    const entered = deferredNative(); let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({start(c) {controller = c;}, pull() {entered.resolve();}}, {highWaterMark: 0});
    const flight = app.request(new Request('http://hub.invalid' + path + '/moves', {method: 'POST', headers, body, duplex: 'half'} as RequestInit));
    await entered.promise; await revoke();
    controller.enqueue(Buffer.from(malformed ? '{' : JSON.stringify(input()))); controller.close();
    assert.equal((await flight).status, 403); assert.equal(f.calls.write, 0);
    assert.deepEqual(f.notebookRevisions(), revisions);
  });

  test(`${mode}: bound move rechecks revoked grant between original plan ACK and native effect`, async t => {
    const {f, machine, token, input, revoke} = await fixture(t, mode, true), move = input();
    const revisions = f.notebookRevisions();
    f.hooks.machineAck = async command => {
      if (command.action === 'native' && command.command.action === 'write-plan') {
        f.hooks.machineAck = undefined; await revoke();
      }
    };
    await assert.rejects(machine.move(f.request(), token, move.requestId, move));
    assert.equal(f.calls.write, 0); assert.deepEqual(f.notebookRevisions(), revisions);
  });

  test(`${mode}: machine transport rejects unrelated bindings, methods and paths before dispatch`, async t => {
    const {f, token} = await fixture(t, mode, true), current = f.current();
    const result = await current.owner.command('notebookMachine', {token, action: 'context'});
    assert.ok(result?.action === 'context' && result.context);
    const client = await current.resolver.notebookMachine!({command: input => current.owner.command('notebookMachine', input)}, token, result.context);
    const base = '/workspace/card-files/' + result.context.bindingId, before = {...f.calls};
    for (const [path, method] of [[base, 'PUT'], [base, 'DELETE'], [base + '/subscribe', 'POST'],
      ['/workspace/card-files/' + randomUUID() + '/snapshot', 'GET'], ['/sessions', 'GET'],
      [base + '/writes/../snapshot', 'GET'], [base + '/snapshot?secret=x', 'GET']] as const)
      await assert.rejects(client.jsonOriginal(path!, {method}), status(403));
    assert.deepEqual(f.calls, before);
  });

  test(`${mode}: bound machine moves through original executor once; rejects other lanes/receipts`, async t => {
    const {f, machine, token, input, bindingId} = await fixture(t, mode, true);
    let initialRefresh: Extract<Parameters<NonNullable<typeof f.hooks.machineAck>>[0], {action: 'native'}> | undefined;
    f.hooks.machineAck = command => {
      if (command.action === 'native' && command.command.action === 'refresh-apply' && !initialRefresh) initialRefresh = command;
    };
    const move = input();
    await assert.rejects(machine.move(f.request(), token, move.requestId, move, false), status(503));
    assert.equal(f.calls.write, 0);
    const saved = await machine.move(f.request(), token, move.requestId, move);
    assert.equal(saved?.moved, 3);
    assert.deepEqual(await machine.move(f.request(), token, move.requestId), saved);
    assert.equal(f.calls.write, 1);
    assert.ok(initialRefresh); assert.equal(initialRefresh.command.action, 'refresh-apply');
    // The initial null-baseline exception cannot refresh an initialized file,
    // nor can a fresh move UUID borrow a previous write's settled authority.
    assert.equal(await f.current().owner.command('notebookMachine', {...initialRefresh, requestId: randomUUID()}), null);
    await assert.rejects(machine.move(f.request(), token, move.requestId, {...move, direction: 'restore'}), status(409));
    for (const native of [
      {...f.scope, action: 'write-read' as const, bindingId: bindingId!, mutationId: randomUUID()},
      {...f.scope, action: 'get' as const, bindingId: randomUUID()},
    ]) assert.equal(await f.current().owner.command('notebookMachine', {token, action: 'native', requestId: move.requestId, command: native}), null);
    for (const action of ['revoke', 'cancel', 'editor-select', 'bind-plan'])
      assert.equal(validHubNotebookMachineCommand({token, action: 'native', command: {...f.scope, action, bindingId}}), false);
    const original = {token, action: 'receipt' as const, requestId: move.requestId};
    assert.equal(validHubNotebookMachineReply(notebookMachineExpectation(original), {action: 'receipt', requestId: randomUUID(), result: saved, conflict: false}), false);
  });

  for (const lost of ['admission', 'response'] as const) test(`${mode}: bound machine lost ${lost} recovers GET-only across owner reopen`, async t => {
    const {f, machine, token, input} = await fixture(t, mode, true), move = input();
    if (lost === 'admission') f.hooks.machineAck = command => {if (command.action === 'native' && command.command.action === 'write-admit') throw Error('lost_ack');};
    else f.hooks.after = async (request, response) => {if (request.method === 'POST') {await response.text(); throw Error('lost_response');} return response;};
    await assert.rejects(machine.move(f.request(), token, move.requestId, move), status(503));
    f.hooks.machineAck = undefined; f.hooks.after = undefined;
    await machine.close(); await f.reopen();
    const recovered = new AsyncWorkspaceNotebookMachine(f.current().port, f.current().service); t.after(() => recovered.close());
    if (lost === 'admission') {
      await assert.rejects(recovered.move(f.request(), token, move.requestId), status(503));
      await assert.rejects(recovered.move(f.request(), token, move.requestId, move), status(503));
      assert.deepEqual(f.notebookRevisions(), {hotRevision: move.hotRevision, coldRevision: move.coldRevision});
    } else assert.equal((await recovered.move(f.request(), token, move.requestId))?.moved, 3);
    assert.equal(f.calls.write, lost === 'admission' ? 0 : 1); assert.ok(f.calls.receipt >= 1);
  });

  test(`${mode}: close holds original effect despite ignored abort and never local-falls-back`, async t => {
    const {f, machine, token, input} = await fixture(t, mode, true), move = input();
    const entered = deferredNative(), release = deferredNative();
    f.hooks.before = async request => {if (request.method === 'POST') {entered.resolve(); await release.promise;}};
    const flight = machine.move(f.request(), token, move.requestId, move); const rejected = assert.rejects(flight, status(503));
    await entered.promise;
    let closed = false; const closing = machine.close().then(() => {closed = true;});
    await tick(); assert.equal(closed, false); assert.equal(machine.pending, 1);
    await assert.rejects(machine.authorized(f.request(), token), status(503));
    release.resolve(); await rejected; await closing;
    assert.equal(f.calls.write, 1); assert.equal(machine.pending, 0);
  });

  test(`${mode}: browser notebook routes register without store/principal and retain original private wire`, async t => {
    const {f, services, machine} = await fixture(t, mode), app = new Hono();
    registerHubSessionNotebookRoutes(app, {mode: 'async', nativeFiles: f.current().service, notebookMachine: machine,
      editorAccess: services.members, privateNotebooks: services.privateNotebooks,
      sessionNotebooks: services.privateNotebooks, notebookControl: services.notebookControl});
    const headers = {'x-agentopsdeck-key': f.key.token};
    for (const path of ['/api/hub/v1/notebook', '/api/hub/v1/notebooks/default', '/api/hub/v1/notebooks/default/archive',
      '/api/hub/v1/notebooks', '/api/hub/v1/notebooks/default/layout', '/api/hub/v1/notebooks/default/search?q=old', '/api/hub/v1/notebooks/default/capabilities']) {
      const response = await app.request(path, {headers}); assert.equal(response.status, 200, path); assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    const saved = await app.request('/api/hub/v1/notebook', {method: 'PUT', headers, body: JSON.stringify({resourceId: nativeNotebook, revision: 1, text: 'new text'})});
    assert.equal(saved.status, 200); assert.equal((await saved.json()).text, 'new text');
    assert.equal((await app.request('/api/hub/v1/notebook', {headers})).status, 200);
  });
}

test('missing async machine/browser ports fail before installing any routes', () => {
  const app = new Hono();
  assert.throws(() => registerWorkspaceAgentNotebook(app, {mode: 'async', notebookMachine: {} as never}));
  assert.equal(app.routes.length, 0);
  assert.throws(() => registerHubSessionNotebookRoutes(app, {mode: 'async'} as never));
  assert.equal(app.routes.length, 0);
});

test('machine routes retain both per-token slots until complete original move settlement', async () => {
  const app = new Hono(), entered = deferredNative(), release = deferredNative(); let calls = 0;
  registerWorkspaceAgentNotebook(app, {mode: 'async', notebookMachine: {
    authorized: async () => true,
    read: async () => ({status: 400, body: {error: 'unused'}}),
    move: async () => {if (++calls === 2) entered.resolve(); await release.promise; return {hotRevision: 2, coldRevision: 1, moved: 3};},
  }});
  const headers = {authorization: 'Bearer aod_note_' + 'x'.repeat(43)};
  const send = () => app.request(path + '/moves', {method: 'POST', headers, body: JSON.stringify({requestId: randomUUID(),
    direction: 'archive', hotRevision: 1, coldRevision: 0, ranges: [{start: 0, end: 3, sha256: notebookHash('old')}]})});
  const first = send(), second = send(); await entered.promise;
  try {assert.equal((await app.request(path, {headers})).status, 429); assert.equal(calls, 2);}
  finally {release.resolve();}
  assert.equal((await first).status, 200); assert.equal((await second).status, 200);
  assert.equal((await app.request(path, {headers})).status, 400);
});

for (const entry of ['../routes/hub-session-notebooks.js', './member-native-file-domain.js', './member-notebook-machine-domain.js'])
  test(`cold module startup is independent of import order: ${entry}`, () => {
    const loader = import.meta.url.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : [];
    const urls = [entry, './member-owner-domain.js', './member-notebook-machine-domain.js'].map(path => new URL(path, import.meta.url).href);
    const script = [...urls.map(url => `await import(${JSON.stringify(url)});`), "console.log('cold-module-imports-complete');"].join('\n');
    const child = spawnSync(process.execPath, [...loader, '--input-type=module', '--eval', script],
      {encoding: 'utf8', timeout: 15_000});
    assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), 'cold-module-imports-complete');
  });
