import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { DEFAULT_HUB_NOTEBOOK_LAYOUT, NOTEBOOK_MAX_CHARS } from '@agentopsdeck/shared';
import { HubStore } from './hub-store.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { WorkspaceNativeFileLocks } from './workspace-native-file-locks.js';
import { validHubNotebookCommand, validHubNotebookReply, hubNotebookReplyExpectation, type HubNotebookCommand } from './member-notebook-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const hot = JSON.stringify(['hub-notebook', 1]);
const layout = JSON.stringify(['hub-notebook-layout', 1, 'default']);
const styledText = '<span data-agentopsdeck-note="v1">Private formatted text</span>';
const save = (resourceId = hot, text = 'plain', area: 'hot' | 'cold' | 'layout' = 'hot', revision = 0, styled = false) =>
  ({ action: 'savePrivate' as const, document: { resourceId, text, revision }, area, styled });
async function fixture(work: (f: { store: HubStore; locks: WorkspaceNativeFileLocks; command: (command: HubNotebookCommand) => Promise<unknown> }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'private-notebook-command-'));
  const store = new HubStore(join(root, 'hub.sqlite'), 'isolated-notebook-vault');
  const owner = new OriginalHubAdministrativeCommands(store, new PerformanceDiagnostics(() => {}));
  const key = store.identities.issueKey('default');
  const snapshot = await owner.command('memberSnapshot', { accessKey: key.token }); assert.ok(snapshot);
  const proof = { evidence: { accessKey: key.token }, expectedScope: snapshot.recoveryScope };
  const locks = new WorkspaceNativeFileLocks((store as unknown as { db: DatabaseSync }).db);
  try { await work({ store, locks, command: command => owner.command('personalNotebook', { ...proof, command }) }); }
  finally { await owner.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
}

test('private notebook production DTO rejects session resources, aliases, bad layout, extra fields and excessive hot text', () => {
  for (const resource of [hot, JSON.stringify(['hub-notebook', 1, randomUUID()])]) assert.equal(validHubNotebookCommand(save(resource)), true);
  for (const resource of ['hub:default', JSON.stringify(['owner', 'node', 'codex', 'session']), '["hub-notebook", 1]',
    JSON.stringify(['hub-notebook', 1, 'default']), layout, JSON.stringify(['hub-notebook', 1, 'NOT-UUID'])])
    assert.equal(validHubNotebookCommand(save(resource)), false, resource);
  assert.equal(validHubNotebookCommand(save(layout, JSON.stringify(DEFAULT_HUB_NOTEBOOK_LAYOUT), 'layout')), true);
  for (const value of [save(layout, '{}', 'layout'), save(hot, 'x'.repeat(NOTEBOOK_MAX_CHARS + 1)),
    { ...save(), styled: 'true' }, { ...save(), bindingId: randomUUID() },
    { ...save(), document: { ...save().document, userId: 'other' } }]) assert.equal(validHubNotebookCommand(value), false);
});
for (const area of ['hot', 'cold'] as const) test(`private ${area} format fence reads current original state at the effect, not stale route snapshot`, () => fixture(async f => {
  const get = () => area === 'cold' ? f.store.notebooks.getArchive('default', hot) : f.store.notebooks.get('default', hot);
  const write = (text: string, revision: number) => area === 'cold'
    ? f.store.notebooks.saveArchive('default', { resourceId: hot, text, revision }) : f.store.notebooks.save('default', { resourceId: hot, text, revision });
  write('original', 0); const routeSnapshot = get();
  write(styledText, 1); // Concurrent editor wins after the route precheck.
  assert.deepEqual(await f.command(save(hot, 'flattened', area, routeSnapshot.revision)), { action: 'savePrivate', status: 'format', document: null });
  assert.equal(get().text, styledText); assert.equal(get().revision, 2);
  assert.deepEqual(await f.command(save(hot, 'flattened', area, 2)), { action: 'savePrivate', status: 'format', document: null });
  assert.deepEqual(await f.command(save(hot, styledText, area, 2)), { action: 'savePrivate', status: 'format', document: null });
  const updated = await f.command(save(hot, 'Explicit styled-aware edit', area, 2, true));
  assert.equal((updated as { status: string }).status, 'saved'); assert.equal(get().revision, 3);
  assert.deepEqual(await f.command(save(hot, 'stale', area, 2, true)), { action: 'savePrivate', status: 'conflict', document: null });
}));
for (const area of ['hot', 'cold', 'layout'] as const) test(`private ${area} save rechecks native lock claimed after coordinator precheck`, () => fixture(async f => {
  const resource = area === 'layout' ? layout : hot, text = area === 'layout' ? JSON.stringify(DEFAULT_HUB_NOTEBOOK_LAYOUT) : 'private';
  assert.equal(f.locks.claim('default', randomUUID(), [{ kind: area === 'cold' ? 'notebook-archive' : 'notebook', id: resource }]), true);
  assert.deepEqual(await f.command(save(resource, text, area)), { action: 'savePrivate', status: 'conflict', document: null });
  const value = area === 'cold' ? f.store.notebooks.getArchive('default', resource) : f.store.notebooks.get('default', resource);
  assert.equal(value.revision, 0); assert.equal(value.text, '');
}));
test('production private port refuses older candidate get/save/session domains without changing state', () => fixture(async f => {
  for (const command of [{ action: 'get', resourceId: hot }, { action: 'save', document: save().document },
    save(JSON.stringify(['owner', 'node', 'codex', 'session']))] as HubNotebookCommand[])
    await assert.rejects(f.command(command));
  assert.equal(f.store.notebooks.get('default', hot).revision, 0);
}));
test('private notebook reply must retain action, resource, committed revision and exact text digest', () => {
  const command = save(), expectation = hubNotebookReplyExpectation(command);
  const reply = { action: 'savePrivate', status: 'saved', document: { ...command.document, revision: 1, updatedAt: 1 } };
  assert.equal(validHubNotebookReply(expectation, reply), true);
  for (const value of [{ ...reply, action: 'save' }, { ...reply, status: 'format' }, { ...reply, document: null },
    ...[{ text: 'wrong' }, { resourceId: layout }, { revision: 2 }].map(patch => ({ ...reply, document: { ...reply.document, ...patch } }))])
    assert.equal(validHubNotebookReply(expectation, value), false);
});
