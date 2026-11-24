import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { workspaceFileCardResource, type WorkspaceFileCardWrite } from '@agentopsdeck/shared';
import { HubStore } from './hub-store.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { AsyncHubWorkspaceReports } from './async-workspace-reports.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
const quiet = new PerformanceDiagnostics(() => {}), status = (code: number) => (e: unknown) => (e as { status?: number })?.status === code;
const tick = () => new Promise<void>(yes => setImmediate(yes));
const write = (): WorkspaceFileCardWrite => ({ kind: 'report', content: { title: 'Report', text: 'secret-report-content' }, revision: 0, mutationId: randomUUID() });
for (const phase of ['initial', 'effect', 'final'] as const) test(`${phase}: close freezes all lanes, drains original report ACK and never closes writer`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-report-drain-')), store = new HubStore(join(root, 'hub.sqlite'), 'isolated-report-vault');
  const original = new OriginalHubAdministrativeCommands(store, quiet), key = store.identities.issueKey('default');
  let release!: () => void, entered!: () => void, snapshots = 0, effects = 0, calls = 0;
  const gate = new Promise<void>(yes => { release = yes; }), admission = new Promise<void>(yes => { entered = yes; });
  const owner = { command: async (kind: string, input: unknown) => {
    calls++; const reply = await original.command(kind as never, input as never);
    if (kind === 'memberSnapshot') snapshots++; else effects++;
    if (phase === 'effect' ? kind === 'workspaceReport' : kind === 'memberSnapshot' && snapshots === (phase === 'initial' ? 1 : 2)) { entered(); await gate; }
    return reply;
  } } as Pick<AsyncHubMemberOwner, 'command'>;
  const services = createHubAdministrativeServices(owner, quiet), resourceId = workspaceFileCardResource('report', randomUUID());
  const save = () => services.reports.save(new Request('http://fixture.invalid/', { headers: { authorization: `Bearer ${key.token}` } }), 'default', resourceId, write());
  try {
    const pending = assert.rejects(save(), status(503));
    assert.equal(await Promise.race([admission.then(() => true), pending.then(() => false)]), true);
    const closing = services.close(); assert.equal(services.close(), closing);
    let closed = false; void closing.then(() => { closed = true; }); await tick(); assert.equal(closed, false);
    const before = calls; await assert.rejects(save(), status(503)); assert.equal(calls, before);
    release(); await pending; await closing;
    assert.equal(effects, phase === 'initial' ? 0 : 1);
    const saved = store.cardFileProjection.get('default', resourceId)!;
    assert.equal(saved.kind, 'report'); assert.ok(saved.kind === 'report');
    assert.equal(saved.content.text, phase === 'initial' ? '' : 'secret-report-content');
    assert.equal(store.createUser('Writer survives').label, 'Writer survives');
  } finally { release(); await services.close(); await original.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
});
for (const failure of ['abort', 'lost-ack', 'revoke'] as const) test(`${failure}: admitted report effect remains original, never replayed, diagnostics redact body and credentials`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-report-unknown-')), store = new HubStore(join(root, 'hub.sqlite'), 'isolated-report-vault');
  const original = new OriginalHubAdministrativeCommands(store, quiet), key = store.identities.issueKey('default');
  let release!: () => void, entered!: () => void, effects = 0;
  const gate = new Promise<void>(yes => { release = yes; }), admission = new Promise<void>(yes => { entered = yes; });
  const owner = { command: async (kind: string, input: unknown) => {
    const reply = await original.command(kind as never, input as never);
    if (kind === 'workspaceReport') { effects++; entered(); await gate;
      if (failure === 'lost-ack') throw Error('secret-report-content');
      if (failure === 'revoke') store.identities.revokeKey('default', key.id);
    }
    return reply;
  } } as Pick<AsyncHubMemberOwner, 'command'>;
  const lines: string[] = [];
  const diagnostics = new PerformanceDiagnostics(line => lines.push(line)), reports = new AsyncHubWorkspaceReports(owner, diagnostics, 5000, 40);
  const resourceId = workspaceFileCardResource('report', randomUUID()), controller = new AbortController();
  try {
    const pending = assert.rejects(reports.save(new Request('http://fixture.invalid/', { headers: { authorization: `Bearer ${key.token}` }, signal: controller.signal }), 'default', resourceId, write()), status(failure === 'abort' ? 499 : failure === 'revoke' ? 401 : 503));
    assert.equal(await Promise.race([admission.then(() => true), pending.then(() => false)]), true);
    if (failure === 'abort') controller.abort();
    let settled = false; void pending.then(() => { settled = true; }); await tick(); assert.equal(settled, false, 'HTTP abort cannot release the original write ACK');
    const saved = store.cardFileProjection.get('default', resourceId)!;
    assert.equal(saved.kind, 'report'); assert.ok(saved.kind === 'report');
    assert.equal(saved.content.text, 'secret-report-content');
    release(); await pending; await reports.close(); assert.equal(effects, 1);
    // Routine successful ACKs are sampled into the log sink, not retained in
    // the recovery-only snapshot. Check actual output as well as that snapshot.
    assert.ok(lines.some(line => JSON.parse(line).step === 80));
    assert.doesNotMatch(JSON.stringify({ snapshot: diagnostics.snapshot(), lines }), new RegExp(key.token + '|secret-report-content'));
  } finally { release(); await reports.close(); await original.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
});
