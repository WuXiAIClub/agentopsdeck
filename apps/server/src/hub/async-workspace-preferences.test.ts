import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AsyncHubWorkspacePreferences } from './async-workspace-preferences.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import type { HubMemberKind } from './member-owner-domain.js';
import { HubMemberRequestError } from './async-member-request.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
const document = () => ({ revision: 0, groups: [], sessions: {} });
const snapshot = () => ({ principal: { userId: 'member', admin: false }, recoveryScope: 'a'.repeat(64) });
const request = (signal?: AbortSignal) => new Request('http://fixture.invalid/', {
  headers: { cookie: 'agentopsdeck_session=hub_session_' + 'x'.repeat(43) }, ...(signal ? { signal } : {}),
});
const port = (command: (kind: HubMemberKind, value: unknown) => unknown | Promise<unknown>) => ({
  command: async (kind: HubMemberKind, value: unknown) => command(kind, value),
}) as Pick<AsyncHubMemberOwner, 'command'>;
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const status = (code: number) => (error: unknown) => error instanceof HubMemberRequestError && error.status === code;

test('workspace caller captures credentials and document before its first permission wait', async () => {
  const wait = deferred<unknown>(); let checks = 0, captured: unknown;
  const service = new AsyncHubWorkspacePreferences(port((kind, input) => {
    if (kind === 'memberSnapshot') return ++checks === 1 ? wait.promise : snapshot();
    captured = input; return { document: { ...document(), revision: 1 } };
  }), quiet);
  const raw = request(), input = document();
  const pending = service.save(raw, 'member', input);
  raw.headers.set('cookie', 'agentopsdeck_session=hub_session_' + 'z'.repeat(43)); input.revision = 42;
  wait.resolve(snapshot());
  assert.equal((await pending)?.revision, 1);
  const copied = captured as { evidence: { sessionToken: string }; document: { revision: number } };
  assert.equal(copied.document.revision, 0); assert.equal(copied.evidence.sessionToken, 'hub_session_' + 'x'.repeat(43));
});

test('workspace caller never trusts supplied user ID as SQL authorization', async () => {
  let writes = 0;
  const service = new AsyncHubWorkspacePreferences(port(kind => { if (kind !== 'memberSnapshot') writes++; return snapshot(); }), quiet);
  await assert.rejects(service.save(request(), 'another-user', document()), status(401));
  await assert.rejects(service.get(request(), 'another-user'), status(401));
  assert.equal(writes, 0);
});

test('workspace save abort keeps original mutation pending, denies delivery after ACK and never retries', async () => {
  const wait = deferred<unknown>(), controller = new AbortController(), logs: string[] = []; let writes = 0;
  const service = new AsyncHubWorkspacePreferences(port(kind => {
    if (kind === 'memberSnapshot') return snapshot(); writes++; return wait.promise;
  }), new PerformanceDiagnostics(line => logs.push(line)), 5, 5);
  const pending = assert.rejects(service.save(request(controller.signal), 'member', document()), status(499));
  await tick(); controller.abort(); await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(writes, 1); assert.equal(service.pending, 1);
  assert.ok(logs.some(line => line.includes('"phase":"pending"')));
  wait.resolve({ document: { ...document(), revision: 1 } }); await pending;
  assert.equal(service.pending, 0); assert.equal(writes, 1);
  assert.equal(logs.join('').includes('x'.repeat(43)), false);
});

test('workspace read deadline does not release unresolved original owner work', async () => {
  const wait = deferred<unknown>(); let reads = 0;
  const service = new AsyncHubWorkspacePreferences(port(kind => {
    if (kind === 'memberSnapshot') return snapshot(); reads++; return wait.promise;
  }), quiet, 5, 5);
  await assert.rejects(service.get(request(), 'member'), status(503));
  assert.equal(service.pending, 1); assert.equal(reads, 1);
  wait.resolve({ document: document() }); await tick();
  assert.equal(service.pending, 0); assert.equal(reads, 1);
});

test('workspace committed response is withheld after persisted scope changes, not rolled back or replayed', async () => {
  let checks = 0, writes = 0;
  const service = new AsyncHubWorkspacePreferences(port(kind => {
    if (kind === 'memberSnapshot') return ++checks === 1 ? snapshot() : { ...snapshot(), recoveryScope: 'b'.repeat(64) };
    writes++; return { document: { ...document(), revision: 1 } };
  }), quiet);
  await assert.rejects(service.save(request(), 'member', document()), status(401));
  assert.equal(writes, 1); assert.equal(checks, 2); assert.equal(service.pending, 0);
});

test('workspace CAS conflict is returned once with no regenerated revision or write retry', async () => {
  let writes = 0;
  const service = new AsyncHubWorkspacePreferences(port(kind => {
    if (kind === 'memberSnapshot') return snapshot(); writes++; return { conflict: true };
  }), quiet);
  assert.equal(await service.save(request(), 'member', document()), undefined); assert.equal(writes, 1);
});

test('workspace unknown write failure stays classified unavailable and never invokes replacement writer', async () => {
  let writes = 0;
  const service = new AsyncHubWorkspacePreferences(port(kind => {
    if (kind === 'memberSnapshot') return snapshot(); writes++; throw Error('private_storage_detail');
  }), quiet);
  await assert.rejects(service.save(request(), 'member', document()), status(503)); assert.equal(writes, 1);
});

test('workspace getters, Proxy and toJSON never run before or inside admission', async () => {
  let commands = 0, effects = 0;
  const service = new AsyncHubWorkspacePreferences(port(() => { commands++; return snapshot(); }), quiet);
  const values = [Object.defineProperty(document(), 'revision', { get() { effects++; return 0; } }),
    new Proxy(document(), { ownKeys() { effects++; return []; } }),
    { ...document(), toJSON() { effects++; return document(); } }];
  for (const value of values) await assert.rejects(service.save(request(), 'member', value), status(400));
  assert.equal(effects, 0); assert.equal(commands, 0);
});
