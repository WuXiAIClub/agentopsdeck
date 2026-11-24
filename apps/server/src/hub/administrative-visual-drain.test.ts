import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { emptyDrawing, emptyNativeDrawio } from '@agentopsdeck/shared';
import { HubStore } from './hub-store.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { AsyncHubWorkspaceVisuals } from './async-workspace-visuals.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait } from '../auth/route-read-wait.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
const status = (code: number) => (error: unknown) => (error as { status?: number })?.status === code;
const tick = () => new Promise<void>(yes => setImmediate(yes));
for (const kind of ['card', 'drawing', 'native-drawio'] as const) for (const phase of ['initial', 'ack', 'final'] as const)
  test(`${kind}/${phase}: group close drains the complete operation and never closes original writer`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'hub-visual-drain-')), store = new HubStore(join(root, 'hub.sqlite'), 'isolated-visual-vault');
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
    const save = () => kind === 'card' ? services.visuals.saveCard(request(), 'default', resource,
      { title: 'Saved', value: '42', detail: '', tone: 'blue', progress: null, revision: 0, mutationId: randomUUID() })
      : kind === 'drawing' ? services.visuals.saveDrawing(request(), 'default', resource, { ...emptyDrawing(), revision: 0, mutationId: randomUUID() })
      : services.visuals.saveNativeDrawio(request(), 'default', resource, { ...emptyNativeDrawio(), revision: 0, mutationId: randomUUID() });
    try {
      const pending = assert.rejects(save(), status(503)); await admission;
      const closing = services.close(); assert.equal(services.close(), closing);
      let closed = false; void closing.then(() => { closed = true; }); await tick(); assert.equal(closed, false);
      const before = calls; await assert.rejects(save(), status(503));
      await assert.rejects(services.visuals.listCards(request(), 'default'), status(503));
      await assert.rejects(services.visuals.listDrawings(request(), 'default'), status(503)); await assert.rejects(services.visuals.listNativeDrawio(request(), 'default'), status(503)); assert.equal(calls, before);
      release(); await pending; await closing; assert.equal(closed, true); assert.equal(effects, phase === 'initial' ? 0 : 1);
      assert.equal((kind === 'card' ? store.cards.get('default', resource)?.revision ?? 0 : kind === 'drawing' ? store.drawings.get('default', resource).revision : store.nativeDrawio.get('default', resource).revision), phase === 'initial' ? 0 : 1);
      assert.equal(store.createUser('Writer survives').label, 'Writer survives');
    } finally { release(); await services.close(); await original.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
  });

for (const outcome of ['cancel', 'deadline'] as const) test(`visual read ${outcome}: bounded HTTP wait retains original read and close ownership`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-visual-read-')), store = new HubStore(join(root, 'hub.sqlite'), 'isolated-visual-vault');
  const original = new OriginalHubAdministrativeCommands(store, quiet), key = store.identities.issueKey('default');
  let release!: () => void, entered!: () => void, effects = 0;
  const gate = new Promise<void>(yes => { release = yes; }), admission = new Promise<void>(yes => { entered = yes; });
  const owner = { command: async (kind: string, input: unknown) => {
    if (kind === 'workspaceVisual') { effects++; entered(); await gate; }
    return original.command(kind as never, input as never);
  } } as Pick<AsyncHubMemberOwner, 'command'>;
  const diagnostics = new PerformanceDiagnostics(() => {}), visuals = new AsyncHubWorkspaceVisuals(owner, diagnostics, 5000, outcome === 'deadline' ? 40 : 30_000);
  try {
    const controller = new AbortController(), request = new Request('http://fixture.invalid/', { headers: { authorization: `Bearer ${key.token}` }, signal: controller.signal });
    const pending = assert.rejects(visuals.listDrawings(request, 'default'), status(outcome === 'cancel' ? 499 : 503));
    await admission; if (outcome === 'cancel') controller.abort(); await pending;
    const closing = visuals.close(); let drained = false; void closing.then(() => { drained = true; }); await tick(); assert.equal(drained, false);
    release(); await closing; assert.equal(effects, 1);
    assert.ok(diagnostics.snapshot().events.some(e => e.step === 75 && (outcome === 'cancel' ? e.cancelled : e.timedOut)));
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), new RegExp(key.token));
  } finally { release(); await visuals.close(); await original.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('visual original-write ACK phase 76 cannot be admitted to read cancellation/deadline machinery', async () => {
  const persistence = new AuthRoutePersistence(quiet), wait = new AuthRouteReadWait(persistence, quiet, 1); let effects = 0;
  await assert.rejects(wait.run(new Request('http://fixture.invalid'), 76 as never, () => { effects++; }));
  assert.equal(effects, 0); await persistence.close();
});
