import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AsyncHubCompletions } from './async-completions.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import type { HubMemberKind } from './member-owner-domain.js';
import type { HubCompletionAction, HubCompletionProof } from './member-completion-domain.js';
import { HubMemberRequestError } from './async-member-request.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
const snapshot = () => ({ principal: { userId: 'member', admin: false }, recoveryScope: 'a'.repeat(64) });
const request = (signal?: AbortSignal) => new Request('http://fixture.invalid/', {
  headers: { cookie: 'agentopsdeck_session=hub_session_' + 'x'.repeat(43) }, ...(signal ? { signal } : {}),
});
const port = (command: (kind: HubMemberKind, value: unknown) => unknown | Promise<unknown>) => ({
  command: async (kind: HubMemberKind, value: unknown) => {
    if (kind === 'connectionDirectoryVersion') return { action: 'version', version: 1 };
    if (kind === 'connectionDirectoryCheck') return { action: 'check', version: 1, ok: true };
    return command(kind, value);
  },
}) as Pick<AsyncHubMemberOwner, 'command'>;
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const status = (code: number) => (error: unknown) => error instanceof HubMemberRequestError && error.status === code;

test('completion input and credentials are pinned before the first authority wait', async () => {
  const wait = deferred<unknown>(); let checks = 0, captured: HubCompletionProof | undefined;
  const service = new AsyncHubCompletions(port((kind, value) => {
    if (kind === 'memberSnapshot') return ++checks === 1 ? wait.promise : snapshot();
    captured = value as HubCompletionProof; return { throughSequence: 3 };
  }), quiet);
  const raw = request(), command = { action: 'read' as const, sessionKey: 'original:YQ', requestId: 'original-request',
    token: 'original-token', throughSequence: 3 };
  const pending = service.command(raw, 'member', command);
  raw.headers.set('cookie', 'agentopsdeck_session=hub_session_' + 'z'.repeat(43));
  command.requestId = 'replacement'; command.token = 'replacement'; command.throughSequence = 42;
  wait.resolve(snapshot());
  assert.deepEqual(await pending, { throughSequence: 3 });
  assert.deepEqual(captured?.command, { action: 'read', sessionKey: 'original:YQ', requestId: 'original-request', token: 'original-token', throughSequence: 3 });
  assert.equal(captured?.evidence.sessionToken, 'hub_session_' + 'x'.repeat(43));
});

for (const action of ['observe', 'read'] as const) test(`completion ${action} abort retains original write until ACK and logs pending without private data`, async () => {
  const wait = deferred<unknown>(), controller = new AbortController(), logs: string[] = []; let writes = 0;
  const service = new AsyncHubCompletions(port(kind => {
    if (kind === 'memberSnapshot') return snapshot(); writes++; return wait.promise;
  }), new PerformanceDiagnostics(line => logs.push(line)), 5, 5);
  const command: HubCompletionAction = action === 'observe' ? { action, sessionKey: 'private-session:YQ' }
    : { action, sessionKey: 'private-session:YQ', requestId: 'private-receipt', token: 'private-token', throughSequence: 1 };
  let settled = false;
  const pending = assert.rejects(service.command(request(controller.signal), 'member', command), status(499)).then(() => { settled = true; });
  await tick(); controller.abort(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(settled, false); assert.equal(writes, 1); assert.equal(service.pending, 1);
  assert.ok(logs.some(line => line.includes('"phase":"pending"') && line.includes(`"step":${action === 'observe' ? 27 : 28}`)));
  wait.resolve(action === 'observe' ? { observation: {} } : { throughSequence: 1 });
  await pending; assert.equal(service.pending, 0); assert.equal(writes, 1);
  for (const secret of ['private-session', 'private-receipt', 'private-token', 'x'.repeat(43)]) assert.equal(logs.join('').includes(secret), false);
});

test('completion summary cancellation preserves unresolved read ownership and logs cancellation', async () => {
  const wait = deferred<unknown>(), controller = new AbortController(), logs: string[] = []; let reads = 0;
  const service = new AsyncHubCompletions(port(kind => {
    if (kind === 'memberSnapshot') return snapshot(); reads++; return wait.promise;
  }), new PerformanceDiagnostics(line => logs.push(line)), 5, 500);
  const pending = assert.rejects(service.command(request(controller.signal), 'member', { action: 'summary', sessions: [] }), status(499));
  await tick(); controller.abort(); await pending;
  assert.equal(service.pending, 1); assert.equal(reads, 1);
  wait.resolve({ items: [] }); await tick();
  assert.equal(service.pending, 0); assert.equal(reads, 1);
  assert.ok(logs.some(line => line.includes('"cancelled":1') && line.includes('"step":26')));
});

test('completion summary deadline retains original work without retry or substitute owner', async () => {
  const wait = deferred<unknown>(); let reads = 0;
  const service = new AsyncHubCompletions(port(kind => kind === 'memberSnapshot' ? snapshot() : (reads++, wait.promise)), quiet, 5, 5);
  await assert.rejects(service.command(request(), 'member', { action: 'summary', sessions: [] }), status(503));
  assert.equal(service.pending, 1); assert.equal(reads, 1);
  wait.resolve({ items: [] }); await tick(); assert.equal(service.pending, 0);
});

test('completion committed ACK is withheld after recovery scope changes and is never rolled back or replayed', async () => {
  let checks = 0, writes = 0;
  const service = new AsyncHubCompletions(port(kind => {
    if (kind === 'memberSnapshot') return ++checks === 1 ? snapshot() : { ...snapshot(), recoveryScope: 'b'.repeat(64) };
    writes++; return { throughSequence: 1 };
  }), quiet);
  await assert.rejects(service.command(request(), 'member', { action: 'read', sessionKey: 'conn:YQ', requestId: 'read', token: 'token', throughSequence: 1 }), status(401));
  assert.equal(writes, 1); assert.equal(checks, 2); assert.equal(service.pending, 0);
});

test('completion unknown write failure returns unavailable once with only redacted unknown-effect logs', async () => {
  let writes = 0; const logs: string[] = [];
  const service = new AsyncHubCompletions(port(kind => {
    if (kind === 'memberSnapshot') return snapshot(); writes++; throw Error('private_storage_failure');
  }), new PerformanceDiagnostics(line => logs.push(line)));
  await assert.rejects(service.command(request(), 'member', { action: 'observe', sessionKey: 'conn:YQ' }), status(503));
  assert.equal(writes, 1); assert.equal(service.pending, 0);
  assert.ok(logs.some(line => line.includes('"step":27') && line.includes('"unknown":1') && line.includes('"category":"failed"')));
  assert.equal(logs.join('').includes('private_storage_failure'), false);
});

test('completion invalid/getter/Proxy/toJSON input executes no traps and admits no owner work', async () => {
  let commands = 0, effects = 0;
  const service = new AsyncHubCompletions(port(() => { commands++; return snapshot(); }), quiet);
  const values = [Object.defineProperty({ action: 'summary', sessions: [] }, 'sessions', { get() { effects++; return []; } }),
    new Proxy({ action: 'summary', sessions: [] }, { ownKeys() { effects++; return []; } }),
    { action: 'summary', sessions: [], toJSON() { effects++; return {}; } },
    { action: 'summary', sessions: Array(257).fill('conn:YQ') }];
  for (const value of values) await assert.rejects(service.command(request(), 'member', value as HubCompletionAction), status(400));
  assert.equal(commands, 0); assert.equal(effects, 0);
});

test('completion principal and command reject a stale recovery scope before any effect', async () => {
  let writes = 0;
  const service = new AsyncHubCompletions(port(kind => {
    if (kind === 'memberSnapshot') return snapshot(); writes++; return { items: [] };
  }), quiet);
  const raw = request(); raw.headers.set('x-agentopsdeck-recovery-scope', 'b'.repeat(64));
  await assert.rejects(service.principal(raw), status(409));
  await assert.rejects(service.command(raw, 'member', { action: 'summary', sessions: [] }), status(409));
  assert.equal(writes, 0); await service.close();
});

for (const action of ['summary', 'observe', 'read'] as const) for (const final of [1, 2]) {
  test(`completion ${action} rejects changed connection authority at final atomic proof ${final} without replay`, async () => {
    let effects = 0, checks = 0;
    const service = new AsyncHubCompletions({ command: async (kind: HubMemberKind) => {
      if (kind === 'memberSnapshot') return snapshot();
      if (kind === 'connectionDirectoryVersion') return { action: 'version', version: 7 };
      if (kind === 'connectionDirectoryCheck') return { action: 'check', version: 7, ok: ++checks !== final };
      effects++; return action === 'summary' ? { items: [] } : action === 'observe' ? { observation: {} } : { throughSequence: 1 };
    } } as Pick<AsyncHubMemberOwner, 'command'>, quiet);
    const command: HubCompletionAction = action === 'summary' ? { action, sessions: [] }
      : action === 'observe' ? { action, sessionKey: 'conn:YQ' }
      : { action, sessionKey: 'conn:YQ', requestId: 'receipt', token: 'token', throughSequence: 1 };
    await assert.rejects(service.command(request(), 'member', command), status(503));
    assert.equal(effects, 1); assert.equal(checks, final); await service.close();
  });
}
