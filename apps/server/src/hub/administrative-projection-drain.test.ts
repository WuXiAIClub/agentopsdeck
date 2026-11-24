import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceFileCardResource } from '@agentopsdeck/shared';
import { HubStore } from './hub-store.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { AsyncHubWorkspaceProjections } from './async-workspace-projections.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
const quiet = new PerformanceDiagnostics(() => {}), status = (code: number) => (e: unknown) => (e as { status?: number })?.status === code;
const tick = () => new Promise<void>(yes => setImmediate(yes));
for (const phase of ['initial', 'effect', 'final'] as const) test(`${phase}: group close drains the entire projection operation, preserves original owner`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-projection-drain-')), store = new HubStore(join(root, 'hub.sqlite'), 'isolated-projection-vault');
  const original = new OriginalHubAdministrativeCommands(store, quiet), key = store.identities.issueKey('default');
  let release!: () => void, entered!: () => void, snapshots = 0, effects = 0, calls = 0;
  const gate = new Promise<void>(yes => { release = yes; }), admission = new Promise<void>(yes => { entered = yes; });
  const owner = { command: async (command: string, input: unknown) => {
    calls++; const reply = await original.command(command as never, input as never);
    if (command === 'memberSnapshot') snapshots++; else effects++;
    if (phase === 'effect' ? command === 'workspaceProjection' : command === 'memberSnapshot' && snapshots === (phase === 'initial' ? 1 : 2)) { entered(); await gate; }
    return reply;
  } } as Pick<AsyncHubMemberOwner, 'command'>;
  const services = createHubAdministrativeServices(owner, quiet), request = () => new Request('http://fixture.invalid/', { headers: { authorization: `Bearer ${key.token}` } });
  const read = () => services.projections.get(request(), 'default', workspaceFileCardResource('notebook', 'hub:default'));
  try {
    const pending = assert.rejects(read(), status(503));
    assert.equal(await Promise.race([admission.then(() => true), pending.then(() => false)]), true, 'Read settled before expected admission');
    const closing = services.close(); assert.equal(services.close(), closing);
    let closed = false; void closing.then(() => { closed = true; }); await tick(); assert.equal(closed, false);
    const before = calls; await assert.rejects(read(), status(503)); assert.equal(calls, before);
    release(); await pending; await closing;
    assert.equal(effects, phase === 'initial' ? 0 : 1); assert.equal(store.createUser('Writer survives').label, 'Writer survives');
  } finally { release(); await services.close(); await original.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
});
for (const outcome of ['cancel', 'deadline'] as const) test(`projection ${outcome}: HTTP wait ends, original read remains retained until drained`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-projection-wait-')), store = new HubStore(join(root, 'hub.sqlite'), 'isolated-projection-vault');
  const original = new OriginalHubAdministrativeCommands(store, quiet), key = store.identities.issueKey('default');
  let release!: () => void, entered!: () => void, effects = 0;
  const gate = new Promise<void>(yes => { release = yes; }), admission = new Promise<void>(yes => { entered = yes; });
  const owner = { command: async (kind: string, input: unknown) => {
    if (kind === 'workspaceProjection') { effects++; entered(); await gate; }
    return original.command(kind as never, input as never);
  } } as Pick<AsyncHubMemberOwner, 'command'>;
  const diagnostics = new PerformanceDiagnostics(() => {}), projections = new AsyncHubWorkspaceProjections(owner, diagnostics, 5000, outcome === 'deadline' ? 40 : 30_000);
  try {
    const controller = new AbortController(), request = new Request('http://fixture.invalid/', { headers: { authorization: `Bearer ${key.token}` }, signal: controller.signal });
    const pending = assert.rejects(projections.get(request, 'default', workspaceFileCardResource('browser', 'missing')), status(outcome === 'cancel' ? 499 : 503));
    assert.equal(await Promise.race([admission.then(() => true), pending.then(() => false)]), true, 'Read settled before original read admission');
    if (outcome === 'cancel') controller.abort(); await pending;
    const closing = projections.close(); let drained = false; void closing.then(() => { drained = true; }); await tick(); assert.equal(drained, false);
    release(); await closing; assert.equal(effects, 1);
    assert.ok(diagnostics.snapshot().events.some(e => e.step === 79 && (outcome === 'cancel' ? e.cancelled : e.timedOut)));
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), new RegExp(key.token));
  } finally { release(); await projections.close(); await original.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
});
test('scope changes during the original read cannot return a stale authorized projection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-projection-scope-')), store = new HubStore(join(root, 'hub.sqlite'), 'isolated-projection-vault');
  const original = new OriginalHubAdministrativeCommands(store, quiet), key = store.identities.issueKey('default');
  const owner = { command: async (kind: string, input: unknown) => {
    const result = await original.command(kind as never, input as never);
    if (kind === 'workspaceProjection') store.identities.revokeKey('default', key.id);
    return result;
  } } as Pick<AsyncHubMemberOwner, 'command'>;
  const projections = new AsyncHubWorkspaceProjections(owner, quiet);
  try {
    await assert.rejects(projections.get(new Request('http://fixture.invalid/', { headers: { authorization: `Bearer ${key.token}` } }), 'default', workspaceFileCardResource('notebook', 'hub:default')), status(401));
  } finally { await projections.close(); await original.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
});
