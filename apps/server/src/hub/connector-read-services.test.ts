import assert from 'node:assert/strict';
import test from 'node:test';
import { createHubConnectorReadServices } from './connector-read-services.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { encodeHubSessionId } from './session-id.js';

const request = (signal?: AbortSignal) => new Request('http://hub/?limit=10', {
  headers: { 'x-agentopsdeck-key': 'synthetic' }, ...(signal ? { signal } : {}),
});
const target = { ownerUserId: 'default', connectionId: 'node', grantId: 'grant' };
const control = { operation: 'create' as const, connectionId: 'node', agentId: 'codex' };
const shared = { ownerUserId: 'default', sessionId: 'fixture' };
const sharedRead = { ownerUserId: 'default', sessionId: encodeHubSessionId('node', 'codex:fixture') };
const creation = { ownerUserId: 'default', connectionId: 'node' };
const lifecycle = { connectionId: 'fixture', operation: 'restart' as const };
const maintenance = { connectionId: 'fixture', operation: 'pause' as const };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

for (const lane of ['connector', 'directory', 'ownerControl', 'sharedCommands', 'lifecycleCommands', 'maintenanceCommands', 'eventReplay', 'sharedReads', 'sharedCreation', 'creationDiscovery'] as const) test(`aggregate close retains the original ${lane} SQL and fences all lanes`, async () => {
  let calls = 0, settle!: (value: unknown) => void, drained = false;
  const result = new Promise(resolve => { settle = resolve; });
  const owner = { command: () => { calls++; return result; } } as Pick<AsyncHubMemberOwner, 'command'>;
  const services = createHubConnectorReadServices(owner, undefined, new PerformanceDiagnostics(() => {}));
  const pending = assert.rejects(lane === 'connector' ? services.connector(request(), 'node')
    : lane === 'directory' ? services.directory.sessions(request(), target)
      : lane === 'ownerControl' ? services.ownerControl.open(request(), 'default', control)
        : lane === 'sharedCommands' ? services.sharedCommands.open(request(), shared)
          : lane === 'lifecycleCommands' ? services.lifecycleCommands.open(request(), lifecycle)
            : lane === 'maintenanceCommands' ? services.maintenanceCommands.open(request(), maintenance)
              : lane === 'sharedReads' ? services.sharedReads.open(request(), sharedRead)
                : lane === 'sharedCreation' ? services.sharedCreation.open(request(), creation)
                  : lane === 'creationDiscovery' ? services.creationDiscovery.environments(request(), '')
                    : services.eventReplay.open(request()), { status: 503 });
  assert.equal(calls, 1);
  const closing = services.close(); assert.equal(services.close(), closing);
  void closing.then(() => { drained = true; });
  await assert.rejects(services.connector(request(), 'node'), { status: 503 });
  await assert.rejects(services.directory.sessions(request(), target), { status: 503 });
  await assert.rejects(services.ownerControl.open(request(), 'default', control), { status: 503 });
  await assert.rejects(services.sharedCommands.open(request(), shared), { status: 503 });
  await assert.rejects(services.lifecycleCommands.open(request(), lifecycle), { status: 503 });
  await assert.rejects(services.maintenanceCommands.open(request(), maintenance), { status: 503 });
  await assert.rejects(services.eventReplay.open(request()), { status: 503 });
  await assert.rejects(services.sharedReads.open(request(), sharedRead), { status: 503 });
  await assert.rejects(services.sharedCreation.open(request(), creation), { status: 503 });
  await assert.rejects(services.creationDiscovery.environments(request(), ''), { status: 503 });
  await tick(); assert.equal(drained, false); assert.equal(calls, 1);
  settle({ principal: { userId: 'default', admin: true }, recoveryScope: 'a'.repeat(64) });
  await pending; await closing; assert.equal(drained, true); assert.equal(calls, 1);
});

test('aggregate diagnostic reentry cannot dispatch on another lane before its close callback', async () => {
  let calls = 0, reentry = false, nested: Promise<void> | undefined;
  const owner = { command: async () => { calls++; throw Error('must not dispatch'); } } as Pick<AsyncHubMemberOwner, 'command'>;
  const diagnostics = new PerformanceDiagnostics(() => {}), services = createHubConnectorReadServices(owner, undefined, diagnostics);
  const original = diagnostics.start.bind(diagnostics), checks: Promise<void>[] = [];
  diagnostics.start = (...args) => {
    if (!reentry && args[0] === 'hub-route-drain') {
      reentry = true;
      checks.push(assert.rejects(services.connector(request(), 'node'), { status: 503 }),
        assert.rejects(services.directory.sessions(request(), target), { status: 503 }),
        assert.rejects(services.ownerControl.open(request(), 'default', control), { status: 503 }),
        assert.rejects(services.sharedCommands.open(request(), shared), { status: 503 }),
        assert.rejects(services.lifecycleCommands.open(request(), lifecycle), { status: 503 }),
        assert.rejects(services.maintenanceCommands.open(request(), maintenance), { status: 503 }),
        assert.rejects(services.eventReplay.open(request()), { status: 503 }),
        assert.rejects(services.sharedReads.open(request(), sharedRead), { status: 503 }),
        assert.rejects(services.sharedCreation.open(request(), creation), { status: 503 }),
        assert.rejects(services.creationDiscovery.environments(request(), ''), { status: 503 }));
      nested = services.close();
    }
    return original(...args);
  };
  const closing = services.close(); assert.equal(nested, closing);
  await Promise.all(checks); await closing;
  assert.equal(reentry, true); assert.equal(calls, 0);
});

test('cancelled connector wait does not release original SQL or admit a replacement during close', async () => {
  let calls = 0, settle!: (value: unknown) => void, drained = false;
  const result = new Promise(resolve => { settle = resolve; });
  const owner = { command: () => { calls++; return result; } } as Pick<AsyncHubMemberOwner, 'command'>;
  const services = createHubConnectorReadServices(owner, undefined, new PerformanceDiagnostics(() => {}));
  const controller = new AbortController();
  const pending = assert.rejects(services.connector(request(controller.signal), 'node'), { status: 499 });
  controller.abort(); await pending;
  const closing = services.close(); void closing.then(() => { drained = true; });
  await tick(); assert.equal(drained, false); assert.equal(calls, 1);
  settle(undefined); await closing; assert.equal(drained, true); assert.equal(calls, 1);
});
