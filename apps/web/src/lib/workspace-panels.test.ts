import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyWorkspace, openDashboardPane, openResourcePane, previewResourceDrop, selectWorkspaceSession, isSessionPane, paneKey, validPane, presetWorkspace, closeWorkspacePane, closePreviewPanes, pruneWorkspaceSessions, floatWorkspacePane, insertWorkspacePane, restoreWorkspace, dockPaneIds } from './workspace-layout.js';
import { invalidatedSessionNodes, type SessionSourceState } from './session-snapshot.js';
import { validWorkspace, parseSavedLayouts, restoreSavedLayout, savedLayoutKey, legacySavedLayoutKey } from './saved-layouts.js';
import { currentLayoutKey, legacyCurrentLayoutKey, layoutSnapshot, parseCurrentLayout } from './current-layout.js';

const dashboard = { id: 'overview', kind: 'dashboard', resourceId: 'overview' } as const;
const session = { id: 'a', sessionKey: 'connector:session:a' };
const open = (layout = emptyWorkspace()) => openDashboardPane(layout, dashboard.id, 1800, 1000);
test('opening resources docks by default while preserving existing pane hosts and re-activating duplicates', () => {
  const resources = [dashboard,
    { id: 'browser', kind: 'browser', resourceId: 'c29fa753-5299-4d28-a9ea-f947ae83d0a0' },
    { id: 'terminal', kind: 'terminal', resourceId: 'catalog' },
    { id: 'note', kind: 'notebook', target: 'hub', resourceId: 'default' },
    { id: 'board', kind: 'taskboard', resourceId: 'default' },
    { id: 'status', kind: 'statuscard', resourceId: 'default' },
    { id: 'draw', kind: 'drawing', resourceId: 'default' },
    { id: 'drawio', kind: 'native-drawio', resourceId: 'default' },
    { id: 'media', kind: 'media', resourceId: 'library' },
    { id: 'website', kind: 'website', resourceId: 'catalog' },
    { id: 'research', kind: 'research', resourceId: 'search' },
    { id: 'metric', kind: 'metric-card', resourceId: 'catalog' },
  ] as const;
  for (const free of [false, true]) {
    const panes = [session, { id: 'b', sessionKey: 'connector:session:b' }].map((pane, i) => free
      ? { ...pane, dockFrame: { x: i * .5, y: .1, width: .4, height: .7 } } : pane);
    const original = presetWorkspace(panes, 'columns');
    const snapshot = JSON.stringify(original);
    let layout = original;
    for (const resource of resources) {
      layout = openResourcePane(layout, resource, 1800, 1000);
      assert.equal(layout.panes[0]?.id, original.panes[0]?.id);
      assert.equal(layout.panes[1]?.id, original.panes[1]?.id);
      if (!free) original.panes.forEach((pane, i) => assert.equal(layout.panes[i], pane));
      assert.ok(dockPaneIds(layout.dock).includes(resource.id), resource.kind);
      assert.equal(layout.floating.length, 0);
      assert.equal(layout.active, resource.id);
      assert.equal(validWorkspace(layout), true);
    }
    assert.equal(JSON.stringify(original), snapshot);
    const raised = openResourcePane(layout, { ...dashboard, id: 'unused' }, 1800, 1000);
    assert.equal(raised.panes, layout.panes);
    assert.equal(raised.dock, layout.dock, 're-opening docked resource preserves geometry and host');
    assert.equal(raised.active, dashboard.id);
  }
});
test('Antigravity account quota restores as one standalone pane without a session', () => {
  const quota = { id: 'quota', kind: 'antigravity-quota', resourceId: 'account' } as const;
  const layout = openResourcePane(open(), quota, 1800, 1000);
  assert.equal(validWorkspace(layout), true);
  assert.equal(isSessionPane(quota), false);
  assert.equal(validPane({ ...quota, sessionKey: session.sessionKey }), false);
  assert.equal(validPane({ ...quota, resourceId: 'another-account' }), false);
  const reactivated = openResourcePane({ ...layout, active: dashboard.id }, { ...quota, id: 'duplicate' }, 1800, 1000);
  assert.equal(reactivated.active, quota.id);
  assert.equal(reactivated.panes, layout.panes);
  assert.deepEqual(restoreWorkspace(JSON.parse(JSON.stringify(layout)), new Set()), layout);
});
test('Git repository status panes restore independently without session identities', () => {
  const first = { id: 'git-1', kind: 'git-repo-status', resourceId: '11111111-1111-4111-8111-111111111111' } as const;
  const second = { id: 'git-2', kind: 'git-repo-status', resourceId: '22222222-2222-4222-8222-222222222222' } as const;
  let layout = openResourcePane(open(), first, 1800, 1000);
  layout = openResourcePane(layout, second, 1800, 1000);
  assert.equal(validWorkspace(layout), true);
  assert.equal(isSessionPane(first), false);
  assert.equal(layout.panes.filter(pane => pane.kind === 'git-repo-status').length, 2);
  assert.equal(validPane({ ...first, sessionKey: session.sessionKey }), false);
  assert.equal(validPane({ ...first, resourceId: '../not-a-uuid' }), false);
  assert.deepEqual(restoreWorkspace(JSON.parse(JSON.stringify(layout)), new Set()), layout);
});
test('resources dock with a separate budget and never evict sessions at capacity', () => {
  let layout = presetWorkspace([session], 'single');
  for (let i = 0; i < 4; i++) layout = selectWorkspaceSession(layout, `s${i}`, undefined, `s${i}`, 1800, 1000);
  for (let i = 0; i < 16; i++) layout = openResourcePane(layout, { id: `note${i}`, kind: 'notebook', target: 'session', resourceId: `s${i}` }, 1800, 1000);
  assert.equal(layout.floating.length, 0);
  assert.equal(dockPaneIds(layout.dock).length, 21);
  assert.equal(validWorkspace(layout), true);
  assert.equal(open(layout), layout, 'full resource budget cannot evict an existing pane');
});
test('website references preserve geometry without URLs, credentials or session transport identities', () => {
  const website = { id: 'website', kind: 'website', resourceId: JSON.stringify(['local-dev', 'app']) } as const;
  const layout = openResourcePane(emptyWorkspace(), website, 1800, 1000);
  assert.equal(validPane(website), true); assert.equal(isSessionPane(website), false);
  assert.deepEqual(parseCurrentLayout(JSON.stringify(layoutSnapshot(floatWorkspacePane(layout, website.id), new Set())))?.workspace.panes, [website]);
  assert.equal(openResourcePane(layout, { ...website, id: 'duplicate' }, 1800, 1000).panes.length, 1);
  for (const resourceId of ['https://example.test/', '["../dev","app"]', '["local-dev","../app"]', '["dev", "app"]', '[]']) assert.equal(validPane({ ...website, resourceId }), false);
  assert.equal(validPane({ ...website, sessionKey: 'fake' }), false);
});
test('multiple boards and independent summary cards round-trip without session identities', () => {
  const id = 'c29fa753-5299-4d28-a9ea-f947ae83d0a0';
  const board = { id: 'board', kind: 'taskboard', resourceId: id } as const;
  const card = { id: 'card', kind: 'statuscard', resourceId: id } as const;
  let layout = openResourcePane(emptyWorkspace(), board, 1800, 1000);
  layout = openResourcePane(layout, card, 1800, 1000);
  assert.equal(layout.panes.length, 2);
  assert.notEqual(paneKey(board), paneKey(card));
  assert.deepEqual(layout.panes.filter(isSessionPane), []);
  assert.equal(openResourcePane(layout, { ...card, id: 'duplicate' }, 1800, 1000).panes.length, 2);
  assert.deepEqual(restoreWorkspace(layout, new Set()), layout);
  assert.deepEqual(parseCurrentLayout(JSON.stringify(layoutSnapshot(layout, new Set())))?.workspace, layout);
  for (const bad of [{ ...card, resourceId: '../default' }, { ...board, sessionKey: 'native' }, { ...card, kind: 'arbitrary' }]) assert.equal(validPane(bad), false);
});
test('taskboard keeps stable identity through floating, saved layouts and session navigation', () => {
  const board = { id: 'board', kind: 'taskboard', resourceId: 'default' } as const;
  assert.equal(validPane(board), true);
  assert.equal(validPane({ ...board, sessionKey: 'fake' }), false);
  assert.notEqual(paneKey(board), paneKey(dashboard));
  const layout = openResourcePane(presetWorkspace([session], 'single'), board, 1800, 1000);
  assert.deepEqual(layout.panes.filter(isSessionPane), [session]);
  const floating = floatWorkspacePane(layout, board.id);
  const restored = parseCurrentLayout(JSON.stringify(layoutSnapshot(floating, new Set())))!.workspace;
  assert.deepEqual(restored, floating);
  assert.equal(openResourcePane(restored, { ...board, id: 'duplicate' }, 1800, 1000).panes.length, 2);
  assert.deepEqual(closePreviewPanes(restored).panes, [session]);
});
test('global notebook drag is transactional, keeps resource identity and uses session geometry limits', () => {
  const note = { id: 'note', kind: 'notebook', target: 'hub', resourceId: 'default' } as const;
  const original = presetWorkspace([session], 'single'), snapshot = JSON.stringify(original);
  const preview = previewResourceDrop(original, note, 1790, 500, 1800, 1000);
  assert.equal(preview.blocked, false); assert.equal(preview.drop?.side, 'right');
  assert.equal(JSON.stringify(original), snapshot, 'preview cannot mutate the live layout');
  assert.equal(validWorkspace(preview.layout), true);
  assert.deepEqual(preview.layout.panes.filter(isSessionPane), [session]);
  const floating = floatWorkspacePane(preview.layout, note.id);
  const redock = previewResourceDrop(floating, { ...note, id: 'ignored' }, 10, 500, 1800, 1000);
  assert.equal(redock.blocked, false); assert.equal(redock.id, note.id);
  assert.equal(redock.layout.panes.length, 2); assert.equal(redock.layout.floating.length, 0);
  assert.deepEqual(parseCurrentLayout(JSON.stringify(layoutSnapshot(redock.layout, new Set())))?.workspace, redock.layout);
  for (const [x, y, w, h] of [[-1, 500, 1800, 1000], [1801, 500, 1800, 1000], [NaN, 0, 1800, 1000], [300, 100, 390, 320]]) {
    const invalid = previewResourceDrop(original, note, x!, y!, w!, h!);
    assert.equal(invalid.blocked, true); assert.equal(invalid.layout, original);
  }
  const malformed = previewResourceDrop(original, { ...note, resourceId: '../secret' }, 1790, 500, 1800, 1000);
  assert.equal(malformed.blocked, true); assert.equal(malformed.layout, original);
});
test('notebook drop uses an independent budget but cannot collide with a session host', () => {
  const note = { id: 'note', kind: 'notebook', target: 'hub', resourceId: 'default' } as const;
  const six = presetWorkspace(Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, sessionKey: `connector:s${i}` })), 'grid');
  assert.equal(previewResourceDrop(six, note, 2390, 600, 2400, 1600).blocked, false);
  const eight = openResourcePane(openResourcePane(six, dashboard, 2400, 1600), { ...note, target: 'session', resourceId: session.sessionKey }, 2400, 1600);
  const full = previewResourceDrop(eight, { ...note, id: 'ninth' }, 1200, 800, 2400, 1600);
  assert.equal(full.blocked, false); assert.equal(full.layout.panes.length, 9);
  assert.equal(previewResourceDrop(six, { ...note, id: 's0' }, 10, 500, 2400, 1600).blocked, true);
});
test('six sessions plus dashboard and notebook keep independent budgets and Preview exit preserves sessions', () => {
  const six = presetWorkspace(Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, sessionKey: `connector:s${i}` })), 'grid');
  const notebook = { id: 'note', kind: 'notebook', target: 'hub', resourceId: 'default' } as const;
  const eight = openResourcePane(open(six), notebook, 1800, 1000);
  assert.equal(validWorkspace(eight), true); assert.equal(dockPaneIds(eight.dock).length, 8);
  assert.equal(eight.floating.length, 0); assert.equal(eight.panes.length, 8);
  assert.equal(openResourcePane(eight, { ...notebook, id: 'ninth', target: 'session', resourceId: session.sessionKey }, 1800, 1000).panes.length, 9);
  const snapshot = layoutSnapshot(eight, new Set([paneKey(notebook)]));
  const closed = closePreviewPanes(eight);
  assert.deepEqual(closed.panes, six.panes); assert.deepEqual(dockPaneIds(closed.dock), dockPaneIds(six.dock)); assert.equal(closed.floating.length, 0);
  assert.equal(closePreviewPanes(closed), closed);
  const restored = restoreSavedLayout(snapshot, new Set(six.panes.map(pane => pane.sessionKey!)), closed).workspace!;
  assert.deepEqual(restored.panes.map(paneKey), eight.panes.map(paneKey));
  assert.deepEqual(restored.panes.filter(isSessionPane), six.panes, 'existing chat hosts survive restoring panels');
  assert.equal(validWorkspace(restored), true);
  assert.equal(snapshot.workspace.panes.length, 8, 'named snapshot is not mutated by Preview exit');
});
test('node denial, removal and authority replacement remove notebook-only hosts; unavailable is not revocation', () => {
  const source: SessionSourceState = { connectionId: 'connector', authority: 1, state: 'ready', hiddenCount: 0, archivedCount: 0, pinnedCount: 0 };
  const note = { id: 'note', kind: 'notebook', target: 'session', resourceId: session.sessionKey } as const;
  const hub = { id: 'hub', kind: 'notebook', target: 'hub', resourceId: 'default' } as const;
  const layout = floatWorkspacePane(presetWorkspace([note, dashboard, hub], 'left-stack'), note.id);
  for (const next of [[], [{ ...source, state: 'denied' as const }], [{ ...source, state: 'disabled' as const }], [{ ...source, authority: 2 }]]) {
    const revoked = pruneWorkspaceSessions(layout, new Set(), invalidatedSessionNodes([source], next));
    assert.deepEqual(revoked.panes, [dashboard, hub]); assert.equal(revoked.floating.length, 0); assert.equal(validWorkspace(revoked), true);
    assert.equal(revoked.active, dashboard.id);
  }
  assert.equal(pruneWorkspaceSessions(layout, new Set(), invalidatedSessionNodes([source], [{ ...source, state: 'unavailable' }])), layout);
  assert.equal(pruneWorkspaceSessions(layout, new Set(), invalidatedSessionNodes([source], undefined)), layout, 'legacy absence is not proof');
  const together = presetWorkspace([session, note, hub], 'left-stack');
  assert.deepEqual(pruneWorkspaceSessions(together, new Set([session.sessionKey]), new Set()).panes, [hub]);
});
test('notebook panes persist references only, reuse one host and do not subscribe as sessions', () => {
  const note = { id: 'note', kind: 'notebook', target: 'session', resourceId: session.sessionKey } as const;
  const hub = { id: 'hub-note', kind: 'notebook', target: 'hub', resourceId: 'default' } as const;
  const layout = openResourcePane(openResourcePane(presetWorkspace([session], 'single'), note, 1800, 1000), hub, 1800, 1000);
  assert.equal(layout.version, 2); assert.equal(validWorkspace(layout), true);
  assert.deepEqual(restoreWorkspace(layout, new Set([session.sessionKey])), layout);
  assert.equal(restoreWorkspace(layout, new Set()), undefined);
  assert.equal(openResourcePane(layout, { ...note, id: 'another' }, 1800, 1000).panes.length, 3);
  assert.deepEqual(layout.panes.filter(isSessionPane), [session]);
  assert.equal(selectWorkspaceSession(layout, 'new-session', session.sessionKey, 'unused', 1800, 1000).panes[1]?.id, note.id);
  const snapshot = layoutSnapshot(floatWorkspacePane(layout, note.id), new Set([paneKey(note)]));
  assert.deepEqual(parseCurrentLayout(JSON.stringify(snapshot)), snapshot);
  const restored = restoreSavedLayout(snapshot, new Set(), emptyWorkspace());
  assert.equal(restored.missing, 2); assert.deepEqual(restored.workspace?.panes.map(paneKey), [paneKey(hub)]);
  for (const invalid of [{ ...hub, resourceId: '../secret' }, { ...note, sessionKey: session.sessionKey }, { ...note, resourceId: paneKey(hub) }, { ...note, target: 'agent' }]) assert.equal(validPane(invalid), false);
});
test('typed panes preserve v1 sessions and restore mixed v2 layouts without requiring a dashboard session grant', () => {
  const old = presetWorkspace([session], 'single');
  assert.equal(old.version, 1);
  const mixed = open(old);
  assert.equal(mixed.version, 2);
  assert.equal(validWorkspace(mixed), true);
  assert.deepEqual(restoreWorkspace(mixed, new Set([session.sessionKey])), mixed);
  assert.equal(validWorkspace({ ...mixed, version: 1 }), false);
  assert.equal(restoreWorkspace({ ...mixed, version: 1 }, new Set([session.sessionKey])), undefined);
  assert.deepEqual(mixed.panes.filter(isSessionPane).map(p => p.sessionKey), [session.sessionKey]);
});
test('reject unknown resource kinds, spoofed dashboard/session identities and duplicates', () => {
  for (const pane of [null, {}, { ...dashboard, kind: 'iframe' }, { ...dashboard, resourceId: 'other' },
    { ...dashboard, sessionKey: session.sessionKey }, { ...session, sessionKey: paneKey(dashboard) }, { ...session, sessionKey: '' }]) assert.equal(validPane(pane), false);
  assert.equal(validPane(dashboard), true);
  const duplicate = presetWorkspace([session, dashboard], 'columns');
  duplicate.panes[0] = { ...dashboard, id: session.id };
  assert.equal(validWorkspace(duplicate), false);
  assert.equal(restoreWorkspace(duplicate, new Set()), undefined);
});
test('session navigation never replaces a resource pane or duplicates a mounted session', () => {
  const onlyDashboard = open();
  const mixed = selectWorkspaceSession(onlyDashboard, session.sessionKey, undefined, session.id, 1800, 1000);
  assert.deepEqual(mixed.panes, [dashboard, session]);
  assert.equal(mixed.active, session.id);
  const next = selectWorkspaceSession({ ...mixed, active: dashboard.id }, 'new-session', session.sessionKey, 'new-host', 1800, 1000);
  assert.deepEqual(next.panes, [dashboard, session, { id: 'new-host', sessionKey: 'new-session' }]);
  assert.ok(dockPaneIds(next.dock).includes('new-host'));
  assert.equal(next.floating.length, 0);
  assert.deepEqual(selectWorkspaceSession(next, paneKey(dashboard), undefined, 'bad', 1800, 1000), next);
  const existing = selectWorkspaceSession(floatWorkspacePane(mixed, session.id), session.sessionKey, undefined, 'unused', 1800, 1000);
  assert.equal(existing.panes.length, 2);
  assert.equal(existing.active, session.id);
});
test('dashboard is a singleton independent of the session budget and survives float/dock', () => {
  const six = presetWorkspace(Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, sessionKey: `s${i}` })), 'grid');
  const seven = open(six);
  assert.equal(seven.panes.length, 7);
  assert.ok(dockPaneIds(seven.dock).includes(dashboard.id));
  assert.equal(seven.floating.length, 0);
  assert.equal(open(seven).panes.length, 7);
  assert.equal(validWorkspace(seven), true);
  const eight = { ...seven, panes: [...seven.panes, { id: 'last', sessionKey: 'last' }], floating: [...seven.floating, { id: 'last', x: .1, y: .1, width: .4, height: .4 }] };
  assert.equal(validWorkspace(eight), true);
  assert.equal(open(eight).panes.length, 8);
  const allSessions = { ...eight, panes: eight.panes.map(pane => isSessionPane(pane) ? pane : { id: pane.id, sessionKey: 'replacement' }) };
  assert.equal(open(allSessions), allSessions);
  const floated = floatWorkspacePane(open(presetWorkspace([session], 'single')), dashboard.id);
  const docked = insertWorkspacePane(floated, dashboard.id, 1800, 1000, 'columns');
  assert.equal(docked.floating.length, 0);
  assert.ok(dockPaneIds(docked.dock).includes(dashboard.id));
  assert.equal(docked.panes.find(pane => pane.id === dashboard.id)?.kind, 'dashboard');
});
test('resource survives missing sessions; saved restore reuses its host and preserves collapsed state', () => {
  const workspace = floatWorkspacePane(open(presetWorkspace([session], 'single')), dashboard.id);
  const saved = layoutSnapshot(workspace, new Set([paneKey(dashboard)]));
  assert.deepEqual(parseCurrentLayout(JSON.stringify(saved)), saved);
  assert.equal(parseSavedLayouts(JSON.stringify([saved])).length, 1);
  const current = openDashboardPane(emptyWorkspace(), 'live-overview', 1800, 1000);
  const result = restoreSavedLayout(saved, new Set(), current);
  assert.equal(result.missing, 1);
  assert.deepEqual(result.workspace?.panes, [{ ...dashboard, id: 'live-overview' }]);
  assert.equal(result.workspace?.floating[0]?.id, 'live-overview');
  assert.equal(validWorkspace(result.workspace), true);
  assert.deepEqual(layoutSnapshot(result.workspace!, new Set(saved.collapsedKeys)).collapsedKeys, [paneKey(dashboard)]);
});
test('closing final dashboard preserves empty current snapshot; separate storage keys protect rollback', () => {
  const closed = closeWorkspacePane(open(), dashboard.id);
  assert.deepEqual(parseCurrentLayout(JSON.stringify(layoutSnapshot(closed, new Set())))?.workspace, emptyWorkspace());
  assert.notEqual(currentLayoutKey('user'), legacyCurrentLayoutKey('user'));
  assert.notEqual(savedLayoutKey('user'), legacySavedLayoutKey('user'));
  assert.equal(legacyCurrentLayoutKey(undefined), undefined);
  assert.equal(legacySavedLayoutKey(undefined), undefined);
});
