import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HUB_CONFIGURATION_KINDS } from './member-configuration-domain.js';
import { configurationWrite } from './configuration-test-fixtures.js';
import { HubStore } from './hub-store.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { AsyncHubWorkspaceConfigurations } from './async-workspace-configurations.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait } from '../auth/route-read-wait.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
const status = (code: number) => (error: unknown) => (error as { status?: number })?.status === code;
const tick = () => new Promise<void>(yes => setImmediate(yes));
for (const kind of HUB_CONFIGURATION_KINDS) for (const phase of ['initial', 'ack', 'final'] as const)
  test(`${kind}/${phase}: group close drains the complete operation and never closes original writer`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'hub-configuration-drain-')), store = new HubStore(join(root, 'hub.sqlite'), 'isolated-configuration-vault');
    const original = new OriginalHubAdministrativeCommands(store, quiet), key = store.identities.issueKey('default'), resource = randomUUID();
    let release!: () => void, entered!: () => void, snapshots = 0, effects = 0, calls = 0;
    const gate = new Promise<void>(yes => { release = yes; }), admission = new Promise<void>(yes => { entered = yes; });
    const owner = { command: async (command: string, input: unknown) => {
      calls++; const reply = await original.command(command as never, input as never);
      if (command === 'memberSnapshot') snapshots++; else effects++;
      if (phase === 'ack' ? command !== 'memberSnapshot' : command === 'memberSnapshot' && snapshots === (phase === 'initial' ? 1 : 2)) { entered(); await gate; }
      return reply;
    } } as Pick<AsyncHubMemberOwner, 'command'>;
    const services = createHubAdministrativeServices(owner, quiet), request = () => new Request('http://fixture.invalid/', { headers: { authorization: `Bearer ${key.token}` } });
    const save = () => services.configurations.save(request(), 'default', kind, resource, configurationWrite(kind));
    try {
      const pending = assert.rejects(save(), status(503)); await admission;
      const closing = services.close(); assert.equal(services.close(), closing);
      let closed = false; void closing.then(() => { closed = true; }); await tick(); assert.equal(closed, false);
      const before = calls; await assert.rejects(save(), status(503));
      await assert.rejects(services.configurations.get(request(), 'default', kind, resource), status(503)); assert.equal(calls, before);
      release(); await pending; await closing; assert.equal(closed, true); assert.equal(effects, phase === 'initial' ? 0 : 1);
      assert.equal(store.cardConfigurations.get('default', kind, resource)?.revision ?? 0, phase === 'initial' ? 0 : 1);
      assert.equal(store.createUser('Writer survives').label, 'Writer survives');
    } finally { release(); await services.close(); await original.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
  });

for (const outcome of ['cancel', 'deadline'] as const) test(`configuration read ${outcome}: bounded HTTP wait retains original read and close ownership`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-configuration-read-')), store = new HubStore(join(root, 'hub.sqlite'), 'isolated-configuration-vault');
  const original = new OriginalHubAdministrativeCommands(store, quiet), key = store.identities.issueKey('default');
  let release!: () => void, entered!: () => void, effects = 0;
  const gate = new Promise<void>(yes => { release = yes; }), admission = new Promise<void>(yes => { entered = yes; });
  const owner = { command: async (kind: string, input: unknown) => {
    if (kind === 'workspaceConfiguration') { effects++; entered(); await gate; }
    return original.command(kind as never, input as never);
  } } as Pick<AsyncHubMemberOwner, 'command'>;
  const diagnostics = new PerformanceDiagnostics(() => {}), configurations = new AsyncHubWorkspaceConfigurations(owner, diagnostics, 5000, outcome === 'deadline' ? 40 : 30_000);
  try {
    const controller = new AbortController(), request = new Request('http://fixture.invalid/', { headers: { authorization: `Bearer ${key.token}` }, signal: controller.signal });
    const pending = assert.rejects(configurations.get(request, 'default', 'browser', randomUUID()), status(outcome === 'cancel' ? 499 : 503));
    await admission; if (outcome === 'cancel') controller.abort(); await pending;
    const closing = configurations.close(); let drained = false; void closing.then(() => { drained = true; }); await tick(); assert.equal(drained, false);
    release(); await closing; assert.equal(effects, 1);
    assert.ok(diagnostics.snapshot().events.some(e => e.step === 77 && (outcome === 'cancel' ? e.cancelled : e.timedOut)));
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), new RegExp(key.token));
  } finally { release(); await configurations.close(); await original.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('configuration original-write ACK phase 78 cannot be admitted to read cancellation/deadline machinery', async () => {
  const persistence = new AuthRoutePersistence(quiet), wait = new AuthRouteReadWait(persistence, quiet, 1); let effects = 0;
  await assert.rejects(wait.run(new Request('http://fixture.invalid'), 78 as never, () => { effects++; }));
  assert.equal(effects, 0); await persistence.close();
});
