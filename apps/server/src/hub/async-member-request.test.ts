import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import type { HubMemberKind } from './member-owner-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
const snapshot = () => ({ principal: { userId: 'admin', admin: true }, recoveryScope: 'a'.repeat(64) });
const issued = { id: '87654321-1234-4321-8765-123456789012', token: 'hub_key_' + 'x'.repeat(43) };
const request = (signal?: AbortSignal) => new Request('http://fixture.invalid/', {
  headers: { 'x-agentopsdeck-key': 'hub_key_' + 'z'.repeat(43) }, ...(signal ? { signal } : {}),
});
const port = (command: (kind: HubMemberKind, input: unknown) => unknown | Promise<unknown>) => ({
  command: async (kind: HubMemberKind, input: unknown) => command(kind, input),
}) as Pick<AsyncHubMemberOwner, 'command'>;
const rejectsStatus = (status: number) => (error: unknown) => error instanceof HubMemberRequestError && error.status === status;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('member request pins original credentials and performs fresh checks before and after each command', async () => {
  const calls: { kind: string; input: unknown }[] = [];
  const service = new AsyncHubMemberRequests(port((kind, input) => {
    calls.push({ kind, input }); return kind === 'memberSnapshot' ? snapshot() : issued;
  }), quiet);
  const raw = request(), caller = await service.begin(raw);
  raw.headers.set('x-agentopsdeck-key', 'different-account');
  assert.ok(Object.isFrozen(caller.principal));
  assert.deepEqual(await caller.issue('member'), issued);
  assert.deepEqual(calls.map(c => c.kind), ['memberSnapshot', 'memberSnapshot', 'memberKeyIssue', 'memberSnapshot']);
  for (const call of calls) {
    const body = call.input as { accessKey?: string; evidence?: { accessKey?: string }; expectedScope?: string };
    assert.equal(body.evidence?.accessKey ?? body.accessKey, 'hub_key_' + 'z'.repeat(43));
    if (call.kind === 'memberKeyIssue') assert.equal(body.expectedScope, 'a'.repeat(64));
  }
});

test('role/account/scope drift is sticky denial and cannot dispatch later writes', async () => {
  let current = snapshot(), mutations = 0, reads = 0;
  const service = new AsyncHubMemberRequests(port(kind => {
    if (kind === 'memberSnapshot') { reads++; return current; }
    mutations++; return issued;
  }), quiet);
  const caller = await service.begin(request());
  current = { principal: { userId: 'admin', admin: false }, recoveryScope: 'b'.repeat(64) };
  await assert.rejects(caller.issue('member'), rejectsStatus(401));
  current = snapshot();
  await assert.rejects(caller.issue('member'), rejectsStatus(401));
  assert.equal(mutations, 0); assert.equal(reads, 2);
});

test('ordinary member is not promoted by a target ID or captured snapshot', async () => {
  let commands = 0;
  const service = new AsyncHubMemberRequests(port(kind => {
    commands++; assert.equal(kind, 'memberSnapshot');
    return { principal: { userId: 'member', admin: false }, recoveryScope: 'a'.repeat(64) };
  }), quiet);
  const caller = await service.begin(request());
  await assert.rejects(caller.keys('admin'), rejectsStatus(403));
  await assert.rejects(caller.issue('admin'), rejectsStatus(403));
  assert.equal(commands, 2);
});

test('read deadline ends only HTTP wait and retains shared admission until the original owner settles', async () => {
  const wait = deferred<unknown>(), logs: string[] = [];
  const service = new AsyncHubMemberRequests(port(() => wait.promise), new PerformanceDiagnostics(line => logs.push(line)), 5, 5);
  await assert.rejects(service.begin(request()), rejectsStatus(503));
  assert.equal(service.pendingReads, 1);
  assert.ok(logs.some(line => line.includes('"timedOut":1')));
  wait.reject(Error('private-fixture-error')); await tick();
  assert.equal(service.pendingReads, 0);
  assert.equal(logs.join('').includes('private-fixture-error'), false);
  assert.equal(logs.join('').includes('z'.repeat(43)), false);
});

test('256 abandoned read waits still occupy one shared budget until actual completion', async () => {
  const wait = deferred<unknown>(); let commands = 0;
  const service = new AsyncHubMemberRequests(port(() => { commands++; return wait.promise; }), quiet, 5, 5000);
  const controllers = Array.from({ length: 256 }, () => new AbortController());
  const accepted = controllers.map(controller => assert.rejects(service.begin(request(controller.signal)), rejectsStatus(499)));
  await tick(); assert.equal(service.pendingReads, 256);
  await assert.rejects(service.begin(request()), rejectsStatus(503));
  assert.equal(commands, 256);
  controllers.forEach(controller => controller.abort()); await Promise.all(accepted);
  assert.equal(service.pendingReads, 256);
  wait.resolve(null); await tick(); assert.equal(service.pendingReads, 0);
});

test('disconnect cannot timeout or replay an admitted mutation; final response awaits original settlement then denies', async () => {
  const write = deferred<unknown>(), controller = new AbortController(); let writes = 0;
  const service = new AsyncHubMemberRequests(port(kind => {
    if (kind === 'memberSnapshot') return snapshot();
    writes++; return write.promise;
  }), quiet, 5, 5);
  const caller = await service.begin(request(controller.signal));
  let settled = false;
  const done = assert.rejects(caller.issue('member'), rejectsStatus(499)).then(() => { settled = true; });
  await tick(); assert.equal(writes, 1); controller.abort();
  await pause(15); assert.equal(settled, false, 'no fabricated mutation ACK from HTTP deadline');
  write.resolve(issued); await done;
  await assert.rejects(caller.issue('member'), rejectsStatus(499)); assert.equal(writes, 1);
});

test('unknown mutation outcome never retries and prevents subsequent commands on the request', async () => {
  let writes = 0;
  const service = new AsyncHubMemberRequests(port(kind => {
    if (kind === 'memberSnapshot') return snapshot();
    writes++; throw Error('private-unknown-effect');
  }), quiet);
  const caller = await service.begin(request());
  await assert.rejects(caller.issue('member'), rejectsStatus(503));
  await assert.rejects(caller.keys('member'), rejectsStatus(503));
  assert.equal(writes, 1);
});

for (const operation of ['issue', 'revoke'] as const) {
  test(`${operation} reports pending mutation without fabricating settlement or replay after disconnect`, async () => {
    const write = deferred<unknown>(), logs: string[] = [], controller = new AbortController(); let writes = 0;
    const service = new AsyncHubMemberRequests(port(kind => {
      if (kind === 'memberSnapshot') return snapshot();
      writes++; return write.promise;
    }), new PerformanceDiagnostics(line => logs.push(line)), 5, 5000);
    const caller = await service.begin(request(controller.signal));
    const step = operation === 'issue' ? 24 : 25;
    let settled = false;
    const done = assert.rejects(operation === 'issue' ? caller.issue('member', { ipHash: 'a'.repeat(24) })
      : caller.revoke('member', issued.id), rejectsStatus(499)).then(() => { settled = true; });
    await tick(); controller.abort(); await pause(25);
    assert.equal(writes, 1); assert.equal(settled, false); assert.equal(service.pendingReads, 1);
    const relevant = () => logs.map(line => JSON.parse(line)).filter(row => row.operation === 'auth-route-persistence' && row.step === step);
    assert.ok(relevant().some(row => row.phase === 'pending' && row.pending === 1));
    assert.equal(relevant().some(row => row.settled === 1), false);
    write.resolve(operation === 'issue' ? issued : { ok: true }); await done;
    assert.equal(service.pendingReads, 0); assert.equal(writes, 1);
    assert.equal(relevant().filter(row => row.phase === 'finished' && row.settled === 1).length, 1);
    for (const privateText of ['z'.repeat(43), issued.token, 'a'.repeat(24), issued.id])
      assert.equal(logs.join('').includes(privateText), false);
  });

  test(`${operation} records unknown owner rejection once without leaking private error`, async () => {
    const logs: string[] = []; let writes = 0;
    const service = new AsyncHubMemberRequests(port(kind => {
      if (kind === 'memberSnapshot') return snapshot();
      writes++; throw Error('private-mutation-error');
    }), new PerformanceDiagnostics(line => logs.push(line)), 5, 5000);
    const caller = await service.begin(request());
    await assert.rejects(operation === 'issue' ? caller.issue('member')
      : caller.revoke('member', issued.id), rejectsStatus(503));
    await assert.rejects(caller.keys('member'), rejectsStatus(503));
    assert.equal(writes, 1); assert.equal(service.pendingReads, 0);
    const rows = logs.map(line => JSON.parse(line)).filter(row => row.operation === 'auth-route-persistence'
      && row.step === (operation === 'issue' ? 24 : 25));
    assert.equal(rows.filter(row => row.phase === 'finished' && row.unknown === 1).length, 1);
    assert.equal(logs.join('').includes('private-mutation-error'), false);
  });

  test(`${operation} pins fingerprint before awaiting administrator proof`, async () => {
    const permission = deferred<unknown>(); let snapshots = 0;
    const commands: unknown[] = [];
    const service = new AsyncHubMemberRequests(port((kind, input) => {
      if (kind === 'memberSnapshot') return ++snapshots === 2 ? permission.promise : snapshot();
      commands.push(input); return operation === 'issue' ? issued : { ok: true };
    }), quiet);
    const caller = await service.begin(request());
    const fingerprint = { ipHash: 'a'.repeat(24), userAgentHash: 'b'.repeat(24) };
    const done = operation === 'issue' ? caller.issue('member', fingerprint)
      : caller.revoke('member', issued.id, fingerprint);
    fingerprint.ipHash = 'c'.repeat(24); delete (fingerprint as { userAgentHash?: string }).userAgentHash;
    permission.resolve(snapshot()); await done;
    assert.equal(commands.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify((commands[0] as { fingerprint: unknown }).fingerprint)),
      { ipHash: 'a'.repeat(24), userAgentHash: 'b'.repeat(24) });
  });

  test(`${operation} rejects unsafe fingerprints before proof/storage without invoking caller code`, async () => {
    let commands = 0, observed = 0;
    const service = new AsyncHubMemberRequests(port(kind => {
      commands++; return kind === 'memberSnapshot' ? snapshot() : operation === 'issue' ? issued : { ok: true };
    }), quiet);
    const caller = await service.begin(request());
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const unsafe: unknown[] = [
      { get ipHash() { observed++; return 'a'.repeat(24); } },
      new Proxy({}, { ownKeys() { observed++; return []; }, getPrototypeOf() { observed++; return null; } }),
      revoked.proxy, { toJSON() { observed++; return {}; } },
      { ipHash: 'plaintext-address' }, { userAgentHash: 1 }, { extra: undefined },
      { [Symbol('field')]: undefined }, Object.defineProperty({}, 'ipHash', { value: 'a'.repeat(24) }),
      new (class { ipHash = 'a'.repeat(24); })(), null,
    ];
    for (const fingerprint of unsafe) {
      const input = fingerprint as Parameters<typeof caller.issue>[1];
      await assert.rejects(operation === 'issue' ? caller.issue('member', input)
        : caller.revoke('member', issued.id, input), rejectsStatus(400));
    }
    assert.equal(observed, 0); assert.equal(commands, 1);
    // Invalid input is not a sticky authority/storage failure.
    const optionalUndefined = { ipHash: undefined } as unknown as Parameters<typeof caller.issue>[1];
    await (operation === 'issue' ? caller.issue('member', optionalUndefined)
      : caller.revoke('member', issued.id, optionalUndefined));
    assert.equal(commands, 4);
  });
}

for (const fail of [false, true]) test(`member close fences retained closures and drains original mutation; failure=${fail}`, async () => {
  const write = deferred<unknown>(), entered = deferred<void>(); let commands = 0, mutations = 0;
  const service = new AsyncHubMemberRequests(port(kind => {
    commands++; if (kind === 'memberSnapshot') return snapshot();
    mutations++; entered.resolve(); return write.promise;
  }), quiet);
  const caller = await service.begin(request());
  const response = assert.rejects(caller.issue('member'), rejectsStatus(503));
  await entered.promise;
  let closed = false; const closing = service.close(); assert.equal(service.close(), closing);
  void closing.then(() => { closed = true; });
  const count = commands;
  await assert.rejects(caller.check(), rejectsStatus(503));
  await assert.rejects(caller.issue('member'), rejectsStatus(503));
  await assert.rejects(service.begin(request()), rejectsStatus(503));
  await tick(); assert.equal(closed, false); assert.equal(commands, count); assert.equal(mutations, 1);
  if (fail) write.reject(Error('PRIVATE lost acknowledgement')); else write.resolve(issued);
  await response; await closing; assert.equal(closed, true); assert.equal(service.pendingReads, 0);
  assert.equal(mutations, 1);
});

test('read timeout is not member shutdown acknowledgement', async () => {
  const held = deferred<unknown>(); let calls = 0;
  const service = new AsyncHubMemberRequests(port(() => { calls++; return held.promise; }), quiet, 5, 5);
  await assert.rejects(service.begin(request()), rejectsStatus(503));
  let closed = false; const closing = service.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false); assert.equal(service.pendingReads, 1);
  held.resolve(snapshot()); await closing; assert.equal(service.pendingReads, 0); assert.equal(calls, 1);
});

for (const fail of [false, true]) test(`close fences an in-flight initial member observation; failure=${fail}`, async () => {
  const held = deferred<unknown>(); let calls = 0;
  const service = new AsyncHubMemberRequests(port(() => { calls++; return held.promise; }), quiet);
  const response = assert.rejects(service.begin(request()), rejectsStatus(503));
  assert.equal(service.pendingReads, 1);
  let closed = false; const closing = service.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  if (fail) held.reject(Error('PRIVATE late observation')); else held.resolve(snapshot());
  await response; await closing;
  await assert.rejects(service.begin(request()), rejectsStatus(503));
  assert.equal(calls, 1); assert.equal(service.pendingReads, 0);
});
