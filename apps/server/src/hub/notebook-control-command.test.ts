import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { HubStore } from './hub-store.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { WorkspaceNativeFileLocks } from './workspace-native-file-locks.js';
import { notebookHash } from './notebook-operations.js';
import { hubNotebookControlExpectation, validHubNotebookControlCommand, validHubNotebookControlReply,
  type HubNotebookControlCommand } from './member-notebook-control-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const resourceId = JSON.stringify(['hub-notebook', 1]);
const input = () => ({ requestId: randomUUID(), hotRevision: 1, coldRevision: 0, direction: 'archive' as const,
  ranges: [{ start: 0, end: 5, sha256: notebookHash('hello') }] });
const grant = () => ({ facets: ['hot:read' as const], expiresAt: Date.now() + 600_000 });
async function fixture(work: (f: { store: HubStore; command: (c: HubNotebookControlCommand) => Promise<unknown>;
  token: string; scope: string; owner: OriginalHubAdministrativeCommands }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'notebook-control-'));
  const store = new HubStore(join(root, 'hub.sqlite'), 'isolated-control');
  const owner = new OriginalHubAdministrativeCommands(store, new PerformanceDiagnostics(() => {}));
  const token = store.identities.issueKey('default').token;
  const proof = await owner.command('memberSnapshot', { accessKey: token }); assert.ok(proof);
  store.notebooks.save('default', { resourceId, revision: 0, text: 'hello world' });
  try { await work({ store, owner, token, scope: proof.recoveryScope,
    command: command => owner.command('notebookControl', { evidence: { accessKey: token }, expectedScope: proof.recoveryScope, command }) }); }
  finally { await owner.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
}

test('notebook control accepts only exact canonical private owner commands', () => {
  for (const c of [{ action: 'move', resourceId, input: input() }, { action: 'receipt', resourceId, requestId: randomUUID() },
    { action: 'capabilities', resourceId }, { action: 'issue', resourceId, input: grant() }, { action: 'revoke', resourceId, capabilityId: randomUUID() }]) {
    assert.equal(validHubNotebookControlCommand(c), true);
    for (const resource of ['hub:default', '["hub-notebook", 1]', JSON.stringify(['hub-notebook-layout', 1, 'default']),
      JSON.stringify(['owner', 'node', 'codex', 'session'])]) assert.equal(validHubNotebookControlCommand({ ...c, resourceId: resource }), false);
    assert.equal(validHubNotebookControlCommand({ ...c, userId: 'other' }), false);
  }
});

test('notebook control replies correlate request, resource, CAS, moved size and capability facets without retaining token', () => {
  const c = { action: 'move' as const, resourceId, input: input() }, e = hubNotebookControlExpectation(c);
  const good = { action: 'move', resourceId, requestId: c.input.requestId, result: { hotRevision: 2, coldRevision: 1, moved: 5 }, conflict: null };
  assert.equal(validHubNotebookControlReply(e, good), true);
  for (const patch of [{ requestId: randomUUID() }, { resourceId: JSON.stringify(['hub-notebook', 1, randomUUID()]) },
    { result: { ...good.result, moved: 6 } }, { result: { ...good.result, hotRevision: 3 } }, { conflict: 'PRIVATE secret' }])
    assert.equal(validHubNotebookControlReply(e, { ...good, ...patch }), false);
  const issue = { action: 'issue' as const, resourceId, input: grant() }, expected = hubNotebookControlExpectation(issue);
  const reply = { action: 'issue', resourceId, issued: { capability: { id: randomUUID(), resourceId,
    ...issue.input, createdAt: Date.now(), revokedAt: null }, token: 'aod_note_' + 'x'.repeat(43) } };
  assert.equal(validHubNotebookControlReply(expected, reply), true);
  assert.doesNotMatch(JSON.stringify(expected), /aod_note_|hello/);
  assert.equal(validHubNotebookControlReply(expected, { ...reply, issued: { ...reply.issued,
    capability: { ...reply.issued.capability, facets: ['cold:read'] } } }), false);
});

test('original move commits both revisions and receipt atomically; same UUID cannot change meaning', () => fixture(async f => {
  const move = input(), c = { action: 'move' as const, resourceId, input: move };
  const result = await f.command(c);
  assert.deepEqual(result, { action: 'move', resourceId, requestId: move.requestId, result: { hotRevision: 2, coldRevision: 1, moved: 5 }, conflict: null });
  assert.equal(f.store.notebooks.get('default', resourceId).text, ' world');
  assert.equal(f.store.notebooks.getArchive('default', resourceId).text, 'hello');
  assert.deepEqual(await f.command(c), result);
  assert.deepEqual(await f.command({ action: 'receipt', resourceId, requestId: move.requestId }),
    { action: 'receipt', resourceId, requestId: move.requestId, result: { hotRevision: 2, coldRevision: 1, moved: 5 } });
  assert.equal((await f.command({ ...c, input: { ...move, direction: 'restore' } }) as { conflict: string }).conflict, 'Request ID already used');
}));

test('original identity scope is checked in same savepoint as capability effect', () => fixture(async f => {
  const issued = await f.command({ action: 'issue', resourceId, input: grant() }) as { issued: { capability: { id: string }; token: string } };
  assert.ok(issued.issued); assert.ok(f.store.notebookCapabilities.authorized(issued.issued.token));
  assert.deepEqual(await f.command({ action: 'revoke', resourceId, capabilityId: issued.issued.capability.id }),
    { action: 'revoke', resourceId, capabilityId: issued.issued.capability.id, revoked: true });
  assert.equal(f.store.notebookCapabilities.authorized(issued.issued.token), undefined);
  assert.equal(await f.owner.command('notebookControl', { evidence: { accessKey: f.token }, expectedScope: '0'.repeat(64),
    command: { action: 'issue', resourceId, input: grant() } }), null);
}));

test('original move rechecks native binding acquired after route precheck', () => fixture(async f => {
  new WorkspaceNativeFileLocks((f.store as unknown as { db: DatabaseSync }).db)
    .claim('default', randomUUID(), [{ kind: 'notebook', id: resourceId }]);
  const c = { action: 'move' as const, resourceId, input: input() };
  const reply = await f.command(c) as { result: unknown; conflict: string };
  assert.equal(reply.result, null); assert.equal(reply.conflict, 'Linked notebook requires coordinated file projection');
  assert.equal(f.store.notebooks.get('default', resourceId).revision, 1);
  assert.equal(f.store.notebooks.moveReceipt('default', resourceId, c.input.requestId), undefined);
}));

test('accessor-bearing input is refused before command dispatch and never runs getter', () => fixture(async f => {
  let calls = 0;
  const command = { action: 'capabilities', get resourceId() { calls++; return resourceId; } };
  await assert.rejects(f.command(command as HubNotebookControlCommand)); assert.equal(calls, 0);
  const services = createHubAdministrativeServices(f.owner);
  try {
    await assert.rejects(services.notebookControl.issue(new Request('http://fixture.invalid', { headers: { authorization: `Bearer ${f.token}` } }),
      'default', resourceId, { get facets() { calls++; return ['hot:read' as const]; }, expiresAt: Date.now() + 600_000 }),
    (e: unknown) => (e as { status: number }).status === 400);
    assert.equal(calls, 0);
  } finally { await services.close(); }
}));
