import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseWorkspaceFileCardResource } from '@agentopsdeck/shared';
import { fileCardPaneResource, syncFileCardPaneResource, readCachedFileCardConfiguration, writeCachedFileCardConfiguration, clearCachedFileCardConfigurations } from './workspace-file-card-pane.js';
import { readCachedSharedSnapshot, writeCachedSharedSnapshot, clearCachedSharedSnapshots } from './workspace-shared-content.js';
import { parseFileCardPending, parseFileCardDocument, readCachedReportState, writeCachedReportState, clearCachedReportStates } from './workspace-file-card-write.js';
import { emptyWorkspace, openResourcePane, restoreWorkspace, type Pane } from './workspace-layout.js';
import { validWorkspace } from './saved-layouts.js';

test('service card identity survives placement, resize and reload, but isolates panes and types', async () => {
  const pane: Pane = { id: 'stable-layout-id', kind: 'browser', resourceId: 'catalog' };
  const resource = await fileCardPaneResource(pane);
  assert.equal(await fileCardPaneResource({ ...pane, dockFrame: { x: .2, y: .2, width: .4, height: .4 } }), resource);
  assert.equal(await fileCardPaneResource(JSON.parse(JSON.stringify(pane))), resource);
  assert.notEqual(await fileCardPaneResource({ ...pane, id: 'another' }), resource);
  assert.notEqual(await fileCardPaneResource({ id: pane.id, kind: 'terminal', resourceId: 'catalog' }), resource);
  assert.equal(parseWorkspaceFileCardResource(resource)?.kind, 'browser');
  assert.equal(await fileCardPaneResource({ id: 'session', sessionKey: 'remote:codex:thread' }), undefined);
  assert.equal(await fileCardPaneResource({ id: 'picker', kind: 'metric-card', resourceId: 'catalog' }), undefined);
});
test('native note and report use resource identity rather than layout identity', async () => {
  const id = randomUUID();
  const a = await fileCardPaneResource({ id: 'pane-a', kind: 'report', resourceId: id });
  assert.equal(await fileCardPaneResource({ id: 'pane-b', kind: 'report', resourceId: id }), a);
  assert.notEqual(await fileCardPaneResource({ id: 'pane-a', kind: 'notebook', target: 'hub', resourceId: id }), a);
  assert.notEqual(await fileCardPaneResource({ id: 'note', kind: 'notebook', target: 'hub', resourceId: id }),
    await fileCardPaneResource({ id: 'note', kind: 'notebook', target: 'session', resourceId: id }));
});
test('report cards survive saved-layout validation and restore', () => {
  const pane: Pane = { id: 'report-pane', kind: 'report', resourceId: randomUUID() };
  const layout = openResourcePane(emptyWorkspace(), pane, 1400, 900);
  assert.equal(validWorkspace(layout), true);
  assert.ok(restoreWorkspace(layout, new Set())?.panes.some(p => p.kind === 'report' && p.resourceId === pane.resourceId));
});
test('file documents and durable intents reject schema drift, credentials and cross-kind replay', () => {
  const document = { kind: 'terminal', content: { title: 'Shell', connectionId: 'local', targetId: 'daily' }, revision: 1 };
  const input = { ...document, mutationId: randomUUID() };
  assert.deepEqual(parseFileCardDocument(document), document);
  assert.equal(parseFileCardDocument({ ...document, revision: -1 }), undefined);
  assert.equal(parseFileCardDocument({ ...document, updatedAt: 123 }), undefined);
  assert.equal(parseFileCardDocument({ ...document, content: { ...document.content, command: 'run' } }), undefined);
  assert.equal(parseFileCardDocument({ ...document, content: { ...document.content, token: 'not-a-secret' } }), undefined);
  const pending = { bindingId: randomUUID(), input };
  assert.deepEqual(parseFileCardPending(JSON.stringify(pending), 'terminal'), pending);
  assert.equal(parseFileCardPending(JSON.stringify(pending), 'browser'), undefined);
  assert.equal(parseFileCardPending(JSON.stringify({ ...pending, bindingId: '../escape' }), 'terminal'), undefined);
  assert.equal(parseFileCardPending('{partial', 'terminal'), undefined);
});

const configurationContents = {
  website: { title: 'Site', connectionId: 'connection', websiteId: 'site' },
  browser: { title: 'Browser', url: 'https://example.invalid/' },
  research: { title: 'Research', query: 'Query', sources: [{ title: 'Source', url: 'https://example.invalid/', excerpt: 'Excerpt' }] },
  terminal: { title: 'Terminal', connectionId: 'connection', targetId: 'target' },
  media: { title: 'Media', mediaId: 'media' },
  dashboard: { title: 'Dashboard', description: 'Description', items: [{ label: 'metric', value: '42' }] },
};
for (const [kind, content] of Object.entries(configurationContents)) test(`${kind}: configuration GET projection and pending frontend save remain compatible`, () => {
  const document = { kind, content, revision: 1 };
  assert.deepEqual(parseFileCardDocument(document), document);
  // GET must not leak the updatedAt field retained by the original PUT receipt.
  assert.equal(parseFileCardDocument({ ...document, updatedAt: 123 }), undefined);
  const pending = { bindingId: null, input: { kind, content, revision: 0, mutationId: randomUUID() } };
  assert.deepEqual(parseFileCardPending(JSON.stringify(pending), kind as keyof typeof configurationContents), pending);
});

test('Antigravity quota has no file card storage identity', async () => {
  const pane: Pane = { id: 'quota', kind: 'antigravity-quota', resourceId: 'account' };
  assert.deepEqual(syncFileCardPaneResource(pane), { resolved: true, resource: undefined });
  assert.equal(await fileCardPaneResource(pane), undefined);
});

test('syncFileCardPaneResource and card caches avoid layout-switch blanking while isolating scopes', async () => {
  clearCachedFileCardConfigurations();
  clearCachedSharedSnapshots();
  clearCachedReportStates();

  // Direct resource panes resolve synchronously without waiting for SHA-256 digest
  const taskboardSync = syncFileCardPaneResource({ id: 'pane-tb', kind: 'taskboard', resourceId: 'default' });
  assert.equal(taskboardSync.resolved, true);
  assert.equal(taskboardSync.resource, JSON.stringify(['taskboard', 'default']));

  // Service panes cache their SHA-256 digest after first resolution
  const dashboardPane: Pane = { id: 'pane-dash-cache', kind: 'dashboard', resourceId: 'overview' };
  const resolved = await fileCardPaneResource(dashboardPane);
  assert.deepEqual(syncFileCardPaneResource(dashboardPane), { resolved: true, resource: resolved });

  const configDoc = { kind: 'dashboard' as const, content: { title: 'Ops', description: '', items: [] }, revision: 2 };
  writeCachedFileCardConfiguration('scope-a', resolved, configDoc);
  assert.deepEqual(readCachedFileCardConfiguration('scope-a', resolved), configDoc);
  assert.equal(readCachedFileCardConfiguration('scope-b', resolved), undefined);

  const snapshot = { enabled: true, head: null, native: null, bindings: [] };
  writeCachedSharedSnapshot('scope-a', 'taskboard:default', snapshot);
  assert.deepEqual(readCachedSharedSnapshot('scope-a', 'taskboard:default'), snapshot);
  assert.equal(readCachedSharedSnapshot('scope-b', 'taskboard:default'), undefined);

  const reportId = randomUUID();
  const reportState = {
    document: { kind: 'report' as const, content: { title: 'Weekly', text: '# Done' }, revision: 5 },
    bindingId: null,
  };
  writeCachedReportState('scope-a', reportId, reportState);
  assert.deepEqual(readCachedReportState('scope-a', reportId), reportState);
  assert.equal(readCachedReportState('scope-b', reportId), undefined);

  clearCachedFileCardConfigurations();
  clearCachedSharedSnapshots();
  clearCachedReportStates();
});
