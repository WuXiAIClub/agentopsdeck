import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceFileCardResource, type ChatMessage, type SessionSummary } from '@agentopsdeck/shared';
import {
  WATERMARK_COMPACTIONS_CRITICAL,
  WATERMARK_COMPACTIONS_MIN_MESSAGES,
  WATERMARK_COMPACTIONS_MIN_ROLLOUT_BYTES,
  WATERMARK_COMPACTIONS_WARNING,
  WATERMARK_MESSAGES_CRITICAL,
  WATERMARK_MESSAGES_WARNING,
  WATERMARK_ROLLOUT_CRITICAL_BYTES,
  WATERMARK_ROLLOUT_WARNING_BYTES,
  applyHandoffToCollapsedKeys,
  applyHandoffToSavedLayouts,
  applyHandoffToWorkspaceLayout,
  migratePersistedLayoutsForHandoff,
  pushMigratedLayoutsToCloud,
  buildSessionHandoffPrompt,
  buildSessionHandoffTitle,
  evaluateSessionWatermark,
  formatRolloutBytes,
  inheritSessionArtifacts,
  parseHubNotebookIdFromResource,
} from './session-handoff.js';
import { arrangeDock, floatWorkspacePane, type SessionWorkspace } from './workspace-layout.js';
import { currentLayoutKey, layoutSnapshot, osDesktopLayoutKey, parseCurrentLayout } from './current-layout.js';
import { parseSavedLayouts, restoreSavedLayout, savedLayoutKey, validWorkspace, type SavedLayout } from './saved-layouts.js';

test('evaluateSessionWatermark triggers warning and critical thresholds accurately', () => {
  const clean = evaluateSessionWatermark(
    { rolloutBytes: 50 * 1024 * 1024, messageCount: 1_200, lastTurnCompactions: 2, maxTurnCompactions: 4 },
    500,
  );
  assert.equal(clean.triggered, false);
  assert.equal(clean.severity, null);
  assert.deepEqual(clean.reasons, []);

  const modestSessionWithModerateCompactions = evaluateSessionWatermark(
    { rolloutBytes: Math.round(6.2 * 1024 * 1024), messageCount: 1_290, lastTurnCompactions: 16, maxTurnCompactions: 16 },
    1_290,
  );
  assert.equal(modestSessionWithModerateCompactions.triggered, false);
  assert.equal(modestSessionWithModerateCompactions.severity, null);

  const lightVolumeAboveWarningCompactions = evaluateSessionWatermark({
    rolloutBytes: 12 * 1024 * 1024,
    messageCount: 2_000,
    lastTurnCompactions: WATERMARK_COMPACTIONS_WARNING,
  });
  assert.equal(lightVolumeAboveWarningCompactions.triggered, false);

  const warningByRollout = evaluateSessionWatermark({
    rolloutBytes: WATERMARK_ROLLOUT_WARNING_BYTES,
    messageCount: 100,
    lastTurnCompactions: 1,
    maxTurnCompactions: 1,
  });
  assert.equal(warningByRollout.triggered, true);
  assert.equal(warningByRollout.severity, 'warning');
  assert.deepEqual(warningByRollout.reasons, ['rolloutBytes']);

  const warningByLoadedMessages = evaluateSessionWatermark(
    { rolloutBytes: 0, messageCount: 10 },
    WATERMARK_MESSAGES_WARNING,
  );
  assert.equal(warningByLoadedMessages.triggered, true);
  assert.equal(warningByLoadedMessages.severity, 'warning');
  assert.deepEqual(warningByLoadedMessages.reasons, ['messageCount']);

  const warningByCompaction = evaluateSessionWatermark({
    rolloutBytes: WATERMARK_COMPACTIONS_MIN_ROLLOUT_BYTES,
    messageCount: WATERMARK_COMPACTIONS_MIN_MESSAGES,
    lastTurnCompactions: WATERMARK_COMPACTIONS_WARNING,
    maxTurnCompactions: 3,
  });
  assert.equal(warningByCompaction.triggered, true);
  assert.equal(warningByCompaction.severity, 'warning');
  assert.deepEqual(warningByCompaction.reasons, ['turnCompactions']);

  const criticalByExtremeCompactionAlone = evaluateSessionWatermark({
    rolloutBytes: 10 * 1024 * 1024,
    messageCount: 800,
    maxTurnCompactions: WATERMARK_COMPACTIONS_CRITICAL,
  });
  assert.equal(criticalByExtremeCompactionAlone.triggered, true);
  assert.equal(criticalByExtremeCompactionAlone.severity, 'critical');
  assert.deepEqual(criticalByExtremeCompactionAlone.reasons, ['turnCompactions']);

  const criticalAll = evaluateSessionWatermark({
    rolloutBytes: WATERMARK_ROLLOUT_CRITICAL_BYTES,
    messageCount: WATERMARK_MESSAGES_CRITICAL,
    maxTurnCompactions: WATERMARK_COMPACTIONS_CRITICAL,
  });
  assert.equal(criticalAll.triggered, true);
  assert.equal(criticalAll.severity, 'critical');
  assert.deepEqual(criticalAll.reasons, ['rolloutBytes', 'messageCount', 'turnCompactions']);
});

test('formatRolloutBytes and buildSessionHandoffTitle format cleanly and increment handoff suffixes', () => {
  assert.equal(formatRolloutBytes(0), '0 MB');
  assert.equal(formatRolloutBytes(12.4 * 1024 * 1024), '12.4 MB');
  assert.equal(formatRolloutBytes(245.6 * 1024 * 1024), '246 MB');
  assert.equal(formatRolloutBytes(1.25 * 1024 * 1024 * 1024), '1.25 GB');

  assert.equal(buildSessionHandoffTitle('agentopsdeck v2.3.x', 'codex:1'), 'agentopsdeck v2.3.x · 续接');
  assert.equal(buildSessionHandoffTitle('agentopsdeck v2.3.x · 续接', 'codex:1'), 'agentopsdeck v2.3.x · 续接 #2');
  assert.equal(buildSessionHandoffTitle('agentopsdeck v2.3.x · 续接 #2', 'codex:1'), 'agentopsdeck v2.3.x · 续接 #3');
  assert.equal(buildSessionHandoffTitle('Project - Handoff #4', 'codex:1'), 'Project · 续接 #5');
});

test('buildSessionHandoffPrompt preserves chronological excerpts, context metadata, and ceiling bounds', () => {
  const sourceSession: SessionSummary = {
    sessionKey: 'parallel-codex:old-1',
    title: 'Core Refactor',
    status: 'idle',
    cwd: '/home/user/repo',
    model: 'gpt-5.4',
    rolloutBytes: 260 * 1024 * 1024,
    messageCount: 25_000,
    maxTurnCompactions: 18,
    codexGoal: {
      status: 'active',
      objective: 'Ship tail verification and handoff banner',
      updatedAt: 1_700_000_000_000,
    },
  } as SessionSummary & { cwd: string };

  const messages: ChatMessage[] = [
    { id: 'm1', sessionKey: 'parallel-codex:old-1', role: 'user', text: 'First objective: audit rollout reader', createdAt: 1 },
    { id: 'm2', sessionKey: 'parallel-codex:old-1', role: 'assistant', text: 'Completed rollout reader audit.', createdAt: 2 },
    { id: 'm3', sessionKey: 'parallel-codex:old-1', role: 'user', text: '/compact', createdAt: 3 },
    { id: 'm4', sessionKey: 'parallel-codex:old-1', role: 'user', text: 'Second objective: wire UI banner', createdAt: 4 },
    { id: 'm5', sessionKey: 'parallel-codex:old-1', role: 'assistant', text: 'Engine ready; UI wiring next.', createdAt: 5 },
  ];

  const watermark = evaluateSessionWatermark(sourceSession, messages.length);
  const prompt = buildSessionHandoffPrompt({
    sourceSession,
    messages,
    watermark,
    inherited: {
      sessionNotebookCopied: true,
      sessionNotebookPreview: '## Notes\nKeep bundle under 300 KB gzip.',
      guidanceCopied: true,
      guidancePreview: 'Never touch live SQLite.',
      migratedBoardIds: ['board-alpha'],
      migratedHubNotebookIds: ['default'],
      modelApplied: true,
    },
    maxChars: 12_000,
  });

  assert.match(prompt, /Core Refactor/);
  assert.ok(prompt.includes('`/home/user/repo`'));
  assert.match(prompt, /`gpt-5\.4` \(inherited\)/);
  assert.match(prompt, /`board-alpha`/);
  assert.match(prompt, /`default`/);
  assert.match(prompt, /Ship tail verification and handoff banner/);
  assert.match(prompt, /Never touch live SQLite\./);
  assert.match(prompt, /Keep bundle under 300 KB gzip\./);
  assert.ok(!prompt.includes('/compact'));
  assert.ok(prompt.indexOf('First objective') < prompt.indexOf('Second objective'));
  assert.ok(prompt.indexOf('Completed rollout reader audit.') < prompt.indexOf('Engine ready; UI wiring next.'));

  const tightPrompt = buildSessionHandoffPrompt({
    sourceSession,
    messages: Array.from({ length: 10 }, (_, idx) => ({
      id: `long-${idx}`,
      sessionKey: 'parallel-codex:old-1',
      role: idx % 2 === 0 ? 'user' : 'assistant',
      text: `Segment ${idx}: ${'x'.repeat(1_500)}`,
      createdAt: idx,
    })),
    watermark,
    inherited: {
      sessionNotebookCopied: false,
      guidanceCopied: false,
      migratedBoardIds: [],
      migratedHubNotebookIds: [],
      modelApplied: false,
    },
    maxChars: 3_000,
  });
  assert.ok(tightPrompt.length <= 2_450);
});

test('inheritSessionArtifacts copies notebook/guidance and rebinds boards & hub notebooks with fresh revisions', async () => {
  const calls: string[] = [];
  const defaultCardResource = workspaceFileCardResource('notebook', 'hub:default');
  const customCardResource = workspaceFileCardResource('notebook', 'hub:arch-notes');

  assert.equal(parseHubNotebookIdFromResource('["hub-notebook","u1","arch-notes"]'), 'arch-notes');

  const summary = await inheritSessionArtifacts('conn:old', 'conn:new', {
    isSharedSession: false,
    makeRequestId: () => 'req-fixed',
    applyModelSettings: async () => {
      calls.push('model');
      return true;
    },
    readSessionNotebook: async (key) => {
      calls.push(`readSessionNotebook:${key}`);
      return key === 'conn:old'
        ? { resourceId: 'res-old', text: 'Important session notes', revision: 4, updatedAt: 1 }
        : { resourceId: 'res-new', text: '', revision: 0, updatedAt: 1 };
    },
    saveSessionNotebook: async (key, value) => {
      calls.push(`saveSessionNotebook:${key}:${value.revision}:${value.text}`);
      return { ...value, revision: value.revision + 1, updatedAt: 2 };
    },
    readSessionGuidance: async (key) => {
      calls.push(`readGuidance:${key}`);
      return key === 'conn:old'
        ? ({
            guidance: {
              config: { revision: 2, text: 'Follow strict safety rules', hash: '0'.repeat(64), enabled: true },
              state: 'submitted',
            },
            contextVerification: 'unsupported',
          } as any)
        : ({
            guidance: {
              config: { revision: 0, text: '', hash: '0'.repeat(64), enabled: false },
              state: 'submitted',
            },
            contextVerification: 'unsupported',
          } as any);
    },
    saveSessionGuidance: async (key, value) => {
      calls.push(`saveGuidance:${key}:${value.revision}:${value.enabled}:${value.text}`);
      return {};
    },
    listWorkspaceBoards: async () => ({
      boards: [
        { resourceId: 'b1', title: 'Sprint', revision: 3, updatedAt: 1, taskCounts: { todo: 1, doing: 0, done: 0 } },
        { resourceId: 'b2', title: 'Other', revision: 1, updatedAt: 1, taskCounts: { todo: 0, doing: 0, done: 0 } },
      ] as any,
    }),
    readFileBoardBinding: async (boardId) => ({
      enabled: true,
      binding:
        boardId === 'b1'
          ? ({ bindingId: 'bind-b1', sessionId: 'conn:old', state: 'active' } as any)
          : ({ bindingId: 'bind-b2', sessionId: 'conn:other', state: 'active' } as any),
    }),
    revokeFileBoard: async (boardId, bindingId) => {
      calls.push(`revokeBoard:${boardId}:${bindingId}`);
      return {};
    },
    readWorkspaceBoard: async (boardId) => {
      calls.push(`readBoard:${boardId}`);
      return { revision: 9 };
    },
    bindFileBoard: async (boardId, input) => {
      calls.push(`bindBoard:${boardId}:${input.sessionId}:${input.revision}`);
      return {};
    },
    listHubNotebooks: async () => ({
      items: [{ resourceId: '["hub-notebook","u1","arch-notes"]', text: 'x', revision: 5, updatedAt: 1 }],
      nextCursor: null,
    }),
    readFileCardBinding: async (resource) => ({
      enabled: true,
      binding:
        resource === customCardResource
          ? ({ bindingId: 'bind-card-arch', sessionId: 'conn:old', state: 'active' } as any)
          : ({ bindingId: 'bind-card-def', sessionId: 'conn:other', state: 'active' } as any),
    }),
    revokeFileCard: async (resource, bindingId) => {
      calls.push(`revokeCard:${resource}:${bindingId}`);
      return {};
    },
    readFileCard: async (resource) => {
      calls.push(`readCard:${resource}`);
      return { revision: 12 };
    },
    bindFileCard: async (resource, input) => {
      calls.push(`bindCard:${resource}:${input.sessionId}:${input.revision}`);
      return {};
    },
  });

  assert.equal(summary.modelApplied, true);
  assert.equal(summary.sessionNotebookCopied, true);
  assert.equal(summary.guidanceCopied, true);
  assert.deepEqual(summary.migratedBoardIds, ['b1']);
  assert.deepEqual(summary.migratedHubNotebookIds, ['arch-notes']);
  assert.ok(!calls.some((c) => c.includes(defaultCardResource) && c.startsWith('revokeCard:')));
  assert.ok(calls.includes('revokeBoard:b1:bind-b1'));
  assert.ok(calls.includes('readBoard:b1'));
  assert.ok(calls.includes('bindBoard:b1:conn:new:9'));
  assert.ok(calls.includes(`revokeCard:${customCardResource}:bind-card-arch`));
  assert.ok(calls.includes(`bindCard:${customCardResource}:conn:new:12`));

  // Shared session guard skips owner-only guidance and file-binding mutations
  const sharedSummary = await inheritSessionArtifacts('shared:old', 'shared:new', {
    isSharedSession: true,
    readSessionNotebook: async () => ({ resourceId: 'r', text: 'Shared note', revision: 1, updatedAt: 1 }),
    saveSessionNotebook: async () => ({ resourceId: 'r2', text: 'Shared note', revision: 1, updatedAt: 2 }),
    readSessionGuidance: async () => {
      throw new Error('should not call owner guidance on shared session');
    },
  });
  assert.equal(sharedSummary.sessionNotebookCopied, true);
  assert.equal(sharedSummary.guidanceCopied, false);
});

test('applyHandoffToWorkspaceLayout preserves multi-session co-bindings, swaps file-browser target, and swaps session pane in-place', () => {
  const initial: SessionWorkspace = {
    version: 2,
    active: 'pane-session-old',
    panes: [
      {
        id: 'pane-session-old',
        sessionKey: 'conn:old',
        dockSize: { width: 0.6, height: 0.8 },
      },
      {
        id: 'pane-board-1',
        kind: 'taskboard',
        resourceId: 'default',
        fileLinks: ['conn:peer', 'conn:old'],
      },
      {
        id: 'pane-files-1',
        kind: 'file-browser',
        resourceId: '11111111-1111-4111-8111-111111111111',
        fileLinks: ['conn:old'],
      },
    ],
    dock: arrangeDock(['pane-session-old', 'pane-board-1', 'pane-files-1'], 'columns'),
    floating: [],
  };

  const next = applyHandoffToWorkspaceLayout(initial, 'conn:old', 'conn:new', true);
  assert.equal(next.active, 'pane-session-old');
  const swappedSessionPane = next.panes.find((p) => p.id === 'pane-session-old')!;
  assert.equal(swappedSessionPane.sessionKey, 'conn:new');
  assert.deepEqual(swappedSessionPane.dockSize, { width: 0.6, height: 0.8 });

  const boardPane = next.panes.find((p) => p.id === 'pane-board-1')!;
  assert.deepEqual(boardPane.fileLinks, ['conn:peer', 'conn:old', 'conn:new']);

  const filesPane = next.panes.find((p) => p.id === 'pane-files-1')!;
  assert.deepEqual(filesPane.fileLinks, ['conn:new']);
});

test('applyHandoffToWorkspaceLayout produces validWorkspace across docked, floating, and per-session notebook panes', () => {
  const panes = [
    { id: 'p-sess', sessionKey: 'conn:old', dockSize: { width: 0.5, height: 1 } },
    { id: 'p-note', kind: 'notebook' as const, target: 'session' as const, resourceId: 'conn:old' },
    { id: 'p-board', kind: 'taskboard' as const, resourceId: 'default', fileLinks: ['conn:old'] },
    { id: 'p-files', kind: 'file-browser' as const, resourceId: '22222222-2222-4222-8222-222222222222', fileLinks: ['conn:old'] },
  ];
  const baseWs: SessionWorkspace = {
    version: 2,
    panes,
    dock: arrangeDock(['p-sess', 'p-board', 'p-files'], 'columns'),
    floating: [{ id: 'p-note', x: 0.1, y: 0.1, width: 0.35, height: 0.4 }],
    active: 'p-sess',
  };
  assert.equal(validWorkspace(baseWs), true);

  const oldNoteCollapseKey = `\u0000notebook:${JSON.stringify(['session', 'conn:old'])}`;
  const newNoteCollapseKey = `\u0000notebook:${JSON.stringify(['session', 'conn:new'])}`;

  const migratedWs = applyHandoffToWorkspaceLayout(baseWs, 'conn:old', 'conn:new', true);
  assert.equal(validWorkspace(migratedWs), true);
  assert.equal(migratedWs.active, 'p-sess');
  assert.equal(migratedWs.panes.find((p) => p.id === 'p-sess')?.sessionKey, 'conn:new');
  const notePane = migratedWs.panes.find((p) => p.id === 'p-note');
  assert.equal(notePane?.kind === 'notebook' ? notePane.resourceId : null, 'conn:new');
  assert.deepEqual(migratedWs.panes.find((p) => p.id === 'p-board')?.fileLinks, ['conn:old', 'conn:new']);
  assert.deepEqual(migratedWs.panes.find((p) => p.id === 'p-files')?.fileLinks, ['conn:new']);

  const migratedCollapsed = applyHandoffToCollapsedKeys(
    new Set([oldNoteCollapseKey]),
    'conn:old',
    'conn:new',
    migratedWs,
  );
  assert.deepEqual([...migratedCollapsed], [newNoteCollapseKey]);
});

test('applyHandoffToSavedLayouts updates active and inactive saved layouts so clicking any Saved Layout preserves the new session', () => {
  const activeWs: SessionWorkspace = floatWorkspacePane(
    {
      version: 2,
      panes: [
        { id: 'p1', sessionKey: 'conn:old' },
        { id: 'p2', sessionKey: 'conn:peer' },
      ],
      dock: arrangeDock(['p1', 'p2'], 'columns'),
      floating: [],
      active: 'p1',
    },
    'p1',
  );
  const secondaryWs: SessionWorkspace = {
    version: 2,
    panes: [
      { id: 's1', sessionKey: 'conn:old' },
      { id: 's2', kind: 'taskboard', resourceId: '33333333-3333-4333-8333-333333333333', fileLinks: ['conn:old'] },
    ],
    dock: arrangeDock(['s1', 's2'], 'rows'),
    floating: [],
    active: 's1',
  };
  const untouchedWs: SessionWorkspace = {
    version: 2,
    panes: [{ id: 'u1', sessionKey: 'conn:other' }],
    dock: { kind: 'pane', id: 'u1' },
    floating: [],
    active: 'u1',
  };

  const layouts: SavedLayout[] = [
    { id: 'lay-active', name: 'Daily Split', workspace: activeWs, collapsedKeys: ['conn:old'] },
    { id: 'lay-secondary', name: 'Board Focus', workspace: secondaryWs, collapsedKeys: [] },
    { id: 'lay-untouched', name: 'Other Project', workspace: untouchedWs, collapsedKeys: [] },
  ];

  const { items, changedIds } = applyHandoffToSavedLayouts(layouts, 'conn:old', 'conn:new', true);
  assert.deepEqual(changedIds, ['lay-active', 'lay-secondary']);
  assert.equal(items[2], layouts[2]); // untouched reference preserved
  assert.deepEqual(items[0]!.collapsedKeys, []); // uncollapsed new continuation session

  // Clicking/restoring either saved layout afterwards keeps conn:new and never reverts to conn:old
  const available = new Set(['conn:old', 'conn:new', 'conn:peer', 'conn:other']);
  const restoredActive = restoreSavedLayout(items[0]!, available, untouchedWs);
  assert.ok(restoredActive.workspace);
  assert.equal(restoredActive.missing, 0);
  assert.ok(restoredActive.workspace!.panes.some((p) => p.sessionKey === 'conn:new'));
  assert.ok(!restoredActive.workspace!.panes.some((p) => p.sessionKey === 'conn:old'));

  const restoredSecondary = restoreSavedLayout(items[1]!, available, untouchedWs);
  assert.ok(restoredSecondary.workspace);
  assert.ok(restoredSecondary.workspace!.panes.some((p) => p.sessionKey === 'conn:new'));
  assert.deepEqual(
    restoredSecondary.workspace!.panes.find((p) => p.kind === 'taskboard')?.fileLinks,
    ['conn:old', 'conn:new'],
  );
});

test('migratePersistedLayoutsForHandoff and pushMigratedLayoutsToCloud migrate storage and sync unmounted layouts', async () => {
  const store = new Map<string, string>();
  const mockStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
  const scope = 'user-1';
  const ws: SessionWorkspace = {
    version: 2,
    panes: [{ id: 'p1', sessionKey: 'conn:old' }],
    dock: { kind: 'pane', id: 'p1' },
    floating: [],
    active: 'p1',
  };
  const savedItem: SavedLayout = { id: 'l1', name: 'Main', workspace: ws, collapsedKeys: [] };
  store.set(savedLayoutKey(scope)!, JSON.stringify([savedItem]));
  store.set(currentLayoutKey(scope)!, JSON.stringify(layoutSnapshot(ws, new Set())));
  store.set(osDesktopLayoutKey(scope)!, JSON.stringify(layoutSnapshot(ws, new Set())));
  store.set(`agentopsdeck:layout-sync-pending:${scope}:saved`, JSON.stringify({ revision: 4, content: JSON.stringify([savedItem]) }));

  const migrated = migratePersistedLayoutsForHandoff({
    scope,
    fromSessionKey: 'conn:old',
    toSessionKey: 'conn:new',
    replaceSourcePane: true,
    storage: mockStorage,
  });

  assert.deepEqual(migrated.savedChangedIds, ['l1']);
  assert.ok(migrated.savedSerialized);
  assert.ok(migrated.currentSerialized);
  assert.equal(migrated.osDesktopUpdated, true);

  const persistedSaved = parseSavedLayouts(store.get(savedLayoutKey(scope)!) ?? null);
  assert.equal(persistedSaved[0]?.workspace.panes[0]?.sessionKey, 'conn:new');
  const persistedCurrent = parseCurrentLayout(store.get(currentLayoutKey(scope)!) ?? null);
  assert.equal(persistedCurrent?.workspace.panes[0]?.sessionKey, 'conn:new');
  const persistedOs = parseCurrentLayout(store.get(osDesktopLayoutKey(scope)!) ?? null);
  assert.equal(persistedOs?.workspace.panes[0]?.sessionKey, 'conn:new');

  // Verify pending checkpoint was written so offline reload also retains unpushed change
  assert.ok(store.has(`agentopsdeck:layout-sync-pending:${scope}:saved`));
  assert.ok(store.has(`agentopsdeck:layout-sync-pending:${scope}:current`));

  // Unmounted cloud push writes updated layouts and clears pending checkpoints
  const remoteSavedExtra: SavedLayout = {
    id: 'l-remote-only',
    name: 'Laptop',
    workspace: ws,
    collapsedKeys: [],
  };
  const savedPuts: Array<{ kind: string; revision: number; content: string }> = [];
  await pushMigratedLayoutsToCloud({
    scope,
    isCurrentScope: () => true,
    savedSerialized: migrated.savedSerialized,
    currentSerialized: migrated.currentSerialized,
    loadLayout: async (kind) =>
      kind === 'saved'
        ? { revision: 7, content: JSON.stringify([savedItem, remoteSavedExtra]) }
        : { revision: 3, content: JSON.stringify(layoutSnapshot(ws, new Set())) },
    saveLayout: async (kind, val) => {
      savedPuts.push({ kind, revision: val.revision, content: val.content });
      return { revision: val.revision + 1, content: val.content };
    },
    fromSessionKey: 'conn:old',
    toSessionKey: 'conn:new',
    replaceSourcePane: true,
    storage: mockStorage,
  });

  assert.equal(savedPuts.length, 2);
  const savedPut = savedPuts.find((p) => p.kind === 'saved')!;
  assert.equal(savedPut.revision, 7);
  const mergedCloudItems = parseSavedLayouts(savedPut.content);
  assert.equal(mergedCloudItems.length, 2);
  assert.equal(mergedCloudItems[0]?.workspace.panes[0]?.sessionKey, 'conn:new');
  assert.equal(mergedCloudItems[1]?.workspace.panes[0]?.sessionKey, 'conn:new');
  assert.equal(store.has(`agentopsdeck:layout-sync-pending:${scope}:saved`), false);
  assert.equal(store.has(`agentopsdeck:layout-sync-pending:${scope}:current`), false);
});
