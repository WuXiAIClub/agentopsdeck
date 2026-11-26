import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import type { SessionSummary } from '@agentopsdeck/shared';
import {
  buildDesktopIcons,
  computeDefaultFenceGeometries,
  computeMarqueeSelection,
  groupDesktopIconsIntoFences,
  readDesktopFenceRects,
  writeDesktopFenceRects,
  readDesktopFiles,
  writeDesktopFiles,
  readWorkspaceUiMode,
  writeWorkspaceUiMode,
  isDesktopUrlRoute,
  bootstrapDesktopImmersiveDataset,
  isMobileViewport,
  readDesktopRecycleBin,
  writeDesktopRecycleBin,
  readDesktopBindings,
  writeDesktopBindings,
  readDesktopPreferences,
  writeDesktopPreferences,
  computeCascadeWindowGeometry,
  computeCompanionWindowGeometry,
  computeSmartTileGeometries,
  computeSnapWindowGeometry,
  detectWindowSnapZone,
  promoteWindowZOrder,
  evaluateWindowContentMount,
  resizeDesktopWindowGeometry,
  formatHudKernelTelemetry,
  readDesktopDeletedUsers,
  writeDesktopDeletedUsers,
  sortDesktopIcons,
  resolveDesktopLineageLinks,
  computeTaskbarMetrics,
  detectNewlyCompletedSessions,
  computeDesktopPointTextStyle,
  resolveNonOverlappingIconLayout,
  organizeDesktopIconsGrid,
  sampleDesktopBackgroundRgbAtPoint,
  readDesktopNotifications,
  writeDesktopNotifications,
  readDesktopPinnedSessions,
  writeDesktopPinnedSessions,
  readDesktopWallpaper,
  writeDesktopWallpaper,
  readDesktopWallpaperConfig,
  writeDesktopWallpaperConfig,
  readWorkspaceColorMode,
  writeWorkspaceColorMode,
  toggleWorkspaceColorMode,
} from './desktop-os-mode.js';

test('buildDesktopIcons combines system desktop apps and live sessions with search filtering', () => {
  const sessions = [
    { sessionKey: 's1', title: 'Argon Backend Refactor', status: 'running', hasActiveRun: true, agentId: 'codex' },
    { sessionKey: 's2', title: 'UI Design Review', status: 'idle', hasActiveRun: false, agentId: 'claude' },
  ] as unknown as SessionSummary[];

  const icons = buildDesktopIcons({
    sessions,
    notebooks: [{ id: 'nb-1', title: 'Sprint Notes' }],
    completedSessionKeys: new Set(['s2']),
  });
  // 17 system apps (no action:new-notebook or action:new-taskboard desktop icons) + 2 sessions = 19 icons
  assert.equal(icons.length, 19);
  assert.ok(icons.some((i) => i.id === 'app:git-repo-status' && i.kind === 'git-repo-status'));
  assert.ok(icons.some((i) => i.id === 'app:wechat-messenger' && i.kind === 'wechat-messenger'));
  assert.ok(icons.some((i) => i.id === 'app:docker' && i.kind === 'docker'));
  assert.ok(icons.some((i) => i.id === 'app:subagents' && i.kind === 'subagents'));
  assert.ok(icons.some((i) => i.id === 'app:system-settings' && i.kind === 'system-settings'));
  assert.ok(icons.some((i) => i.id === 'app:statuscard'));
  assert.ok(icons.some((i) => i.id === 'app:session-explorer' && i.variant === 'session-explorer'));
  assert.equal(icons.some((i) => i.id === 'action:new-notebook'), false);
  assert.equal(icons.some((i) => i.id === 'action:new-taskboard'), false);
  assert.ok(icons.some((i) => i.id === 'app:git-tree'));
  assert.ok(icons.some((i) => i.id === 'app:browser'));
  const s1 = icons.find((i) => i.id === 'session:s1');
  assert.equal(s1?.running, true);
  const s2 = icons.find((i) => i.id === 'session:s2');
  assert.equal(s2?.unread, true);

  const filtered = buildDesktopIcons({
    sessions,
    notebooks: [],
    searchQuery: 'argon',
  });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.id, 'session:s1');
});

test('Antigravity quota has a localized standalone tools shortcut without any task boards', () => {
  const icons = buildDesktopIcons({ sessions: [], notebooks: [], taskboards: [], labels: { antigravityQuota: 'Antigravity 账号额度' } });
  assert.deepEqual(icons.find(icon => icon.id === 'app:antigravity-quota'), {
    id: 'app:antigravity-quota', kind: 'antigravity-quota', title: 'Antigravity 账号额度', fenceId: 'tools-files',
  });
});

test('Git repository status has a localized standalone tools shortcut', () => {
  const icons = buildDesktopIcons({ sessions: [], notebooks: [], taskboards: [], labels: { gitRepoStatus: 'Git 仓库状态' } });
  assert.deepEqual(icons.find(icon => icon.id === 'app:git-repo-status'), {
    id: 'app:git-repo-status', kind: 'git-repo-status', title: 'Git 仓库状态', fenceId: 'tools-files',
  });
});

test('buildDesktopIcons renders N notebook icons + 1 new-notebook icon and M taskboard icons + 1 new-taskboard icon', () => {
  const notebooks = [
    { id: 'nb-1', title: 'Note 1' },
    { id: 'nb-2', title: 'Note 2' },
    { id: 'nb-3', title: 'Note 3' },
    { id: 'nb-4', title: 'Note 4' },
    { id: 'nb-5', title: 'Note 5' },
  ];
  const taskboards = [
    { resourceId: 'default', title: 'Main Board' },
    { resourceId: 'tb-2', title: 'Release Board' },
    { resourceId: 'tb-3', title: 'Bug Triage' },
  ];
  const icons = buildDesktopIcons({
    sessions: [],
    notebooks,
    taskboards,
  });

  const notebookIcons = icons.filter((i) => i.kind === 'notebook');
  // 5 notebooks (new-notebook creation lives in desktop right-click menu)
  assert.equal(notebookIcons.length, 5);
  assert.equal(notebookIcons.some((i) => i.id === 'action:new-notebook'), false);

  const taskboardIcons = icons.filter((i) => i.kind === 'taskboard');
  // 3 taskboards (new-taskboard creation lives in desktop right-click menu)
  assert.equal(taskboardIcons.length, 3);
  assert.equal(taskboardIcons.some((i) => i.id === 'action:new-taskboard'), false);
});

test('computeDefaultFenceGeometries computes non-overlapping fence regions with z-index', () => {
  const rects = computeDefaultFenceGeometries(1600, 900);
  assert.ok(rects.sessions.width >= 250);
  assert.ok(rects.knowledge.x > rects.sessions.x + rects.sessions.width);
  assert.ok(rects['tools-files'].x > rects.knowledge.x + rects.knowledge.width);
  assert.equal(rects.sessions.zIndex, 1);
  assert.equal(rects.knowledge.zIndex, 2);
  assert.equal(rects['tools-files'].zIndex, 3);
});

test('computeCascadeWindowGeometry keeps windows inside desktop bounds', () => {
  const g0 = computeCascadeWindowGeometry(0, 1440, 900);
  const g1 = computeCascadeWindowGeometry(1, 1440, 900);
  assert.ok(g1.x > g0.x);
  assert.ok(g1.y > g0.y);
  assert.ok(g1.x + g1.width <= 1440);
});

test('computeSnapWindowGeometry supports 7 snap zones and preserves restoreRect', () => {
  const orig = { x: 220, y: 80, width: 640, height: 480 };
  const left = computeSnapWindowGeometry('left', 1600, 900, orig);
  const right = computeSnapWindowGeometry('right', 1600, 900, orig);
  const topLeft = computeSnapWindowGeometry('top-left', 1600, 900, orig);
  const bottomRight = computeSnapWindowGeometry('bottom-right', 1600, 900, orig);
  const max = computeSnapWindowGeometry('maximize', 1600, 900, orig);

  assert.ok(left.x < right.x);
  assert.equal(left.width, right.width);
  assert.deepEqual(left.restoreRect, orig);
  assert.equal(left.snapped, 'left');

  assert.ok(topLeft.y < bottomRight.y);
  assert.ok(topLeft.x < bottomRight.x);
  assert.equal(topLeft.snapped, 'top-left');
  assert.equal(bottomRight.snapped, 'bottom-right');

  assert.equal(max.maximized, true);
  assert.ok(max.width > left.width);
});

test('detectWindowSnapZone detects edges, corners, and top maximize edge', () => {
  assert.equal(detectWindowSnapZone(8, 12, 1600, 900), 'top-left');
  assert.equal(detectWindowSnapZone(1595, 12, 1600, 900), 'top-right');
  assert.equal(detectWindowSnapZone(8, 860, 1600, 900), 'bottom-left');
  assert.equal(detectWindowSnapZone(1595, 860, 1600, 900), 'bottom-right');
  assert.equal(detectWindowSnapZone(8, 450, 1600, 900), 'left');
  assert.equal(detectWindowSnapZone(1595, 450, 1600, 900), 'right');
  assert.equal(detectWindowSnapZone(800, 10, 1600, 900), 'maximize');
  assert.equal(detectWindowSnapZone(800, 450, 1600, 900), undefined);
});

test('resizeDesktopWindowGeometry resizes across all 8 directions while enforcing bounds', () => {
  const start = { x: 300, y: 120, width: 600, height: 420 };
  const se = resizeDesktopWindowGeometry(start, 'se', 100, 80, 1600, 900);
  assert.equal(se.width, 700);
  assert.equal(se.height, 500);

  const nw = resizeDesktopWindowGeometry(start, 'nw', -50, -30, 1600, 900);
  assert.equal(nw.x, 250);
  assert.equal(nw.y, 90);
  assert.equal(nw.width, 650);
  assert.equal(nw.height, 450);

  const clampedSmall = resizeDesktopWindowGeometry(start, 'w', 500, 0, 1600, 900);
  assert.equal(clampedSmall.width, 340);

  // Custom minSize for floating HUD / Fences across all 4 borders (n, s, e, w)
  const hudStart = { x: 900, y: 400, width: 326, height: 312 };
  const hudNorth = resizeDesktopWindowGeometry(hudStart, 'n', 0, -40, 1600, 900, { minW: 250, minH: 170 });
  assert.equal(hudNorth.y, 360);
  assert.equal(hudNorth.height, 352);
  const hudSouthClamp = resizeDesktopWindowGeometry(hudStart, 's', 0, -250, 1600, 900, { minW: 250, minH: 170 });
  assert.equal(hudSouthClamp.height, 170);
  const hudWestClamp = resizeDesktopWindowGeometry(hudStart, 'w', 200, 0, 1600, 900, { minW: 250, minH: 170 });
  assert.equal(hudWestClamp.width, 250);
  const hudEast = resizeDesktopWindowGeometry(hudStart, 'e', 74, 0, 1600, 900, { minW: 250, minH: 170 });
  assert.equal(hudEast.width, 400);
});

test('sortDesktopIcons and promoteWindowZOrder maintain deterministic ordering', () => {
  const sessions = [
    { sessionKey: 's1', title: 'Zeta Task', status: 'idle', hasActiveRun: false },
    { sessionKey: 's2', title: 'Alpha Runner', status: 'running', hasActiveRun: true },
  ] as unknown as SessionSummary[];
  const byName = buildDesktopIcons({ sessions, notebooks: [], sortBy: 'name' });
  assert.equal(byName[0]?.title, 'Alpha Runner');

  const byStatus = sortDesktopIcons(byName, 'status');
  assert.equal(byStatus[0]?.running, true);

  assert.deepEqual(promoteWindowZOrder(['w1', 'w2', 'w3'], 'w1'), ['w2', 'w3', 'w1']);
});

test('promoteWindowZOrder preserves array reference when window is already top-most', () => {
  const stack = ['w1', 'w2', 'w3'];
  const same = promoteWindowZOrder(stack, 'w3');
  assert.equal(same, stack);

  const promoted = promoteWindowZOrder(stack, 'w1');
  assert.notEqual(promoted, stack);
  assert.deepEqual(promoted, ['w2', 'w3', 'w1']);
});

test('evaluateWindowContentMount defers initial minimized windows and preserves already-mounted windows for instant restore', () => {
  const coldMinimized = evaluateWindowContentMount({
    isMinimized: true,
    hasMountedOnce: false,
    isActive: false,
    running: false,
  });
  assert.equal(coldMinimized.shouldMountContent, false);
  assert.equal(coldMinimized.isHiddenMinimized, true);
  assert.equal(coldMinimized.shouldSuspendBackgroundActivity, true);

  const firstOpen = evaluateWindowContentMount({
    isMinimized: false,
    hasMountedOnce: false,
    isActive: true,
    running: false,
  });
  assert.equal(firstOpen.shouldMountContent, true);
  assert.equal(firstOpen.isHiddenMinimized, false);
  assert.equal(firstOpen.shouldSuspendBackgroundActivity, false);

  const warmMinimized = evaluateWindowContentMount({
    isMinimized: true,
    hasMountedOnce: true,
    isActive: false,
    running: true,
  });
  assert.equal(warmMinimized.shouldMountContent, true);
  assert.equal(warmMinimized.isHiddenMinimized, true);
  assert.equal(warmMinimized.shouldSuspendBackgroundActivity, false);
});

test('computeSmartTileGeometries arranges 1, 2, 3, and 4+ windows without overlapping desktop icon column', () => {
  const single = computeSmartTileGeometries(['w1'], 1600, 900, true);
  assert.equal(single.w1?.x, 112);
  assert.ok((single.w1?.width ?? 0) > 1200);

  const two = computeSmartTileGeometries(['w1', 'w2'], 1600, 900, true);
  assert.ok((two.w1?.x ?? 0) >= 112);
  assert.ok((two.w2?.x ?? 0) >= (two.w1?.x ?? 0) + (two.w1?.width ?? 0));

  const three = computeSmartTileGeometries(['w1', 'w2', 'w3'], 1600, 900, false);
  assert.equal(three.w1?.x, 14);
  assert.equal(three.w2?.x, three.w3?.x);
  assert.ok((three.w3?.y ?? 0) > (three.w2?.y ?? 0));

  const four = computeSmartTileGeometries(['w1', 'w2', 'w3', 'w4'], 1600, 900, true);
  assert.equal(Object.keys(four).length, 4);
  assert.equal(four.w1?.x, four.w3?.x);
  assert.equal(four.w2?.x, four.w4?.x);
});

test('includes desktop files with attachments in buildDesktopIcons', () => {
  const icons = buildDesktopIcons({
    sessions: [],
    notebooks: [{ id: 'default', title: 'Notes' }],
    desktopFiles: [
      {
        id: 'df-1',
        name: 'todo.md',
        content: '# Todo',
        fileType: 'mixed',
        attachments: [
          {
            id: 'att-1',
            name: 'screenshot.png',
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,AAAA',
            size: 128,
          },
        ],
        updatedAt: 1000,
      },
    ],
  });
  const fileIcon = icons.find((i) => i.id === 'file:df-1');
  assert.ok(fileIcon);
  assert.equal(fileIcon.kind, 'desktop-file');
  assert.equal(fileIcon.title, 'todo.md');
});

test('computes rubber-band marquee intersection for multi-select', () => {
  const items = [
    { id: 'app:file-browser', x: 14, y: 52, width: 84, height: 84 },
    { id: 'app:notebook', x: 14, y: 146, width: 84, height: 84 },
    { id: 'session:s1', x: 112, y: 52, width: 84, height: 84 },
  ];
  const result = computeMarqueeSelection(
    { x: 10, y: 48 },
    { x: 105, y: 240 },
    items,
  );
  assert.deepEqual(result.selectedIds, ['app:file-browser', 'app:notebook']);
  assert.equal(result.rect.left, 10);
  assert.equal(result.rect.top, 48);
});

test('groupDesktopIconsIntoFences partitions sessions, notebooks/boards, and tools/files with variants', () => {
  const sessions = [
    { sessionKey: 's1', title: 'Argon Agent', status: 'running', hasActiveRun: true },
  ] as unknown as SessionSummary[];
  const icons = buildDesktopIcons({
    sessions,
    notebooks: [
      { id: 'nb-default', title: 'Main Meeting Notes' },
      { id: 'nb-2', title: 'Architecture Spec' },
    ],
    desktopFiles: [{ id: 'df-1', name: 'readme.md', content: 'hi', updatedAt: 100 }],
    completedSessionKeys: new Set(['s1']),
  });

  const fences = groupDesktopIconsIntoFences(icons);
  assert.equal(fences.length, 3);
  const sessionFence = fences.find((f) => f.id === 'sessions');
  const knowledgeFence = fences.find((f) => f.id === 'knowledge');
  const toolsFence = fences.find((f) => f.id === 'tools-files');

  assert.equal(sessionFence?.items.length, 2);
  assert.ok(sessionFence?.items.some((i) => i.id === 'app:wechat-messenger' && i.kind === 'wechat-messenger'));
  assert.ok(sessionFence?.items.some((i) => i.id === 'session:s1' && i.unread === true));
  assert.ok(knowledgeFence?.items.some((i) => i.id === 'app:notebook' && i.variant === 'meeting-note'));
  assert.ok(knowledgeFence?.items.some((i) => i.id === 'notebook:nb-2' && i.variant === 'session-note'));
  assert.equal(knowledgeFence?.items.some((i) => i.id === 'action:new-notebook'), false);
  assert.ok(knowledgeFence?.items.some((i) => i.id === 'app:taskboard' && i.variant === 'kanban-board'));
  assert.equal(knowledgeFence?.items.some((i) => i.id === 'action:new-taskboard'), false);
  assert.ok(knowledgeFence?.items.some((i) => i.id === 'app:statuscard' && i.variant === 'status-card'));
  assert.ok(toolsFence?.items.some((i) => i.id === 'app:session-explorer' && i.variant === 'session-explorer'));
  assert.ok(toolsFence?.items.some((i) => i.id === 'file:df-1'));
});

// Suppress unused import warnings in strict checks
void readDesktopFenceRects;
void writeDesktopFenceRects;
void readDesktopFiles;
void writeDesktopFiles;

test('computeDefaultFenceGeometries starts near the top edge (topY = 12) since top bar is merged into taskbar', () => {
  const rects = computeDefaultFenceGeometries(1600, 900);
  assert.equal(rects.sessions.y, 12);
  assert.equal(rects.knowledge.y, 12);
  assert.equal(rects['tools-files'].y, 12);
});

test('readWorkspaceUiMode forces classic mode on mobile viewports (< 768px)', () => {
  assert.equal(isMobileViewport(390), true);
  assert.equal(isMobileViewport(1440), false);
  assert.equal(readWorkspaceUiMode("test-mobile-scope", 390), "classic");
});

test('buildDesktopIcons includes Recycle Bin when recycleBinCount is provided and filters out recycledIconIds', () => {
  const icons = buildDesktopIcons({
    sessions: [
      { sessionKey: "s1", title: "Session 1", status: "idle", hasActiveRun: false },
      { sessionKey: "s2", title: "Session 2", status: "idle", hasActiveRun: false },
    ] as unknown as SessionSummary[],
    notebooks: [{ id: "nb-1", title: "Note 1" }],
    recycleBinCount: 1,
    recycledIconIds: new Set(["session:s2"]),
  });
  const bin = icons.find((i) => i.id === "app:recycle-bin");
  assert.ok(bin);
  assert.equal(bin.kind, "recycle-bin");
  assert.equal(bin.badge, "1");
  assert.ok(icons.some((i) => i.id === "session:s1"));
  assert.ok(!icons.some((i) => i.id === "session:s2"));
});


test('Recycle Bin, Desktop Bindings, and Desktop Preferences persist round-trip across reloads', () => {
  const store = new Map<string, string>();
  const prevStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    },
  });
  try {
    const scope = 'test-joint-audit';
    writeDesktopRecycleBin(scope, [
      {
        id: 'file:df-1',
        title: 'draft.md',
        kind: 'desktop-file',
        resourceId: 'df-1',
        deletedAt: 1700000000000,
        fileSnapshot: { id: 'df-1', name: 'draft.md', content: 'hello', updatedAt: 1700000000000 },
      },
    ]);
    const recycled = readDesktopRecycleBin(scope);
    assert.equal(recycled.length, 1);
    assert.equal(recycled[0]?.id, 'file:df-1');
    assert.equal(recycled[0]?.originalIconId, 'file:df-1');
    assert.equal(recycled[0]?.fileSnapshot?.name, 'draft.md');
    assert.equal(recycled[0]?.fileEntry?.name, 'draft.md');

    writeDesktopBindings(scope, [
      {
        id: 'bind-1',
        fromId: 'session:s1',
        toId: 'notebook:nb-1',
        sourceId: 'session:s1',
        targetId: 'notebook:nb-1',
        createdAt: 1700000000000,
      },
    ]);
    const bindings = readDesktopBindings(scope);
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0]?.fromId, 'session:s1');
    assert.equal(bindings[0]?.toId, 'notebook:nb-1');
    assert.equal(bindings[0]?.sourceId, 'session:s1');
    assert.equal(bindings[0]?.targetId, 'notebook:nb-1');

    writeDesktopPreferences(scope, {
      iconSize: 'md',
      sortBy: 'kind',
      showDesktopIcons: true,
      fencesEnabled: true,
      taskbarHeight: 72,
      freeDesktopIconIds: ['session:s1', 'file:df-1'],
    });
    const prefs = readDesktopPreferences(scope);
    assert.equal(prefs.taskbarHeight, 72);
    assert.deepEqual(prefs.freeDesktopIconIds, ['session:s1', 'file:df-1']);
    assert.equal(prefs.showLineageLines, true);

    writeDesktopPreferences(scope, {
      ...prefs,
      showLineageLines: false,
    });
    const hiddenPrefs = readDesktopPreferences(scope);
    assert.equal(hiddenPrefs.showLineageLines, false);
  } finally {
    if (prevStorage === undefined) {
      delete (globalThis as Record<string, unknown>).localStorage;
    } else {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: prevStorage });
    }
  }
});

test('resolveDesktopLineageLinks unifies notebook bindings, taskboard bindings, pane links, moderator links, and manual desktop bindings', () => {
  const edges = resolveDesktopLineageLinks({
    notebooks: [
      { id: 'nb-primary', title: 'Primary Notes' },
      { id: 'nb-alpha', title: 'Alpha Notes' },
    ],
    taskboards: [
      { resourceId: 'default', title: 'Task Board' },
      { resourceId: 'tb-sprint', title: 'Sprint Board' },
    ],
    notebookBindings: {
      'nb-alpha': ['s-main', 's-helper'],
    },
    taskboardBindings: {
      'tb-sprint': ['s-main'],
    },
    paneLinks: [
      {
        fromIconId: 'notebook:nb-alpha',
        toIconId: 'taskboard:tb-sprint',
        label: 'Co-bound Card',
        kind: 'co-bound',
      },
      {
        fromIconId: 'app:file-explorer',
        toIconId: 'session:s-helper',
        label: 'File Explorer Link',
        kind: 'file-link',
      },
    ],
    moderatorConfig: {
      moderatorSessionKey: 's-mod',
      notebookId: 'nb-alpha',
      taskboardId: 'tb-sprint',
      scoutSessionKey: 's-scout',
    },
    desktopBindings: [
      // Duplicate of existing notebook binding s-main <-> nb-alpha should be deduplicated
      { id: 'dup-1', fromId: 'session:s-main', toId: 'notebook:nb-alpha', createdAt: 100 },
      // Distinct manual desktop link
      { id: 'man-1', fromId: 'session:s-helper', toId: 'file:df-notes', label: 'Manual Reference', createdAt: 200 },
    ],
  });

  // Check notebook bindings
  assert.ok(edges.some((e) => e.kind === 'notebook-binding' && e.fromIconId === 'notebook:nb-alpha' && e.toIconId === 'session:s-main'));
  assert.ok(edges.some((e) => e.kind === 'notebook-binding' && e.fromIconId === 'notebook:nb-alpha' && e.toIconId === 'session:s-helper'));

  // Check taskboard binding
  assert.ok(edges.some((e) => e.kind === 'taskboard-binding' && e.fromIconId === 'taskboard:tb-sprint' && e.toIconId === 'session:s-main'));

  // Check pane links (co-bound card + explorer)
  assert.ok(edges.some((e) => e.kind === 'co-bound' && e.fromIconId === 'notebook:nb-alpha' && e.toIconId === 'taskboard:tb-sprint'));
  assert.ok(edges.some((e) => e.kind === 'file-link' && e.fromIconId === 'app:file-explorer' && e.toIconId === 'session:s-helper'));

  // Check moderator orchestration links
  assert.ok(edges.some((e) => e.kind === 'moderator' && e.fromIconId === 'session:s-mod' && e.toIconId === 'notebook:nb-alpha'));
  assert.ok(edges.some((e) => e.kind === 'moderator' && e.fromIconId === 'session:s-mod' && e.toIconId === 'taskboard:tb-sprint'));
  assert.ok(edges.some((e) => e.kind === 'moderator' && e.fromIconId === 'session:s-mod' && e.toIconId === 'session:s-scout'));

  // Check manual desktop link & deduplication
  const sMainNbAlpha = edges.filter(
    (e) =>
      (e.fromIconId === 'session:s-main' && e.toIconId === 'notebook:nb-alpha') ||
      (e.fromIconId === 'notebook:nb-alpha' && e.toIconId === 'session:s-main'),
  );
  assert.equal(sMainNbAlpha.length, 1);
  assert.equal(sMainNbAlpha[0]?.kind, 'notebook-binding');
  assert.equal(sMainNbAlpha[0]?.removableManualId, 'dup-1');

  const manualEdge = edges.find((e) => e.removableManualId === 'man-1');
  assert.ok(manualEdge);
  assert.equal(manualEdge?.kind, 'manual');
});

test('Desktop OS mode supports dedicated #/desktop URL route and zero-flash startup boot fallback', () => {
  const store = new Map<string, string>();
  const prevStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      get length() { return store.size; },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    },
  });
  try {
    assert.equal(isDesktopUrlRoute('#/desktop'), true);
    assert.equal(isDesktopUrlRoute('#/os-desktop'), true);
    assert.equal(isDesktopUrlRoute('#/tab/sessions', '?ui=desktop'), true);
    assert.equal(isDesktopUrlRoute('#/tab/sessions'), false);

    // URL route activates os-desktop on desktop viewports, but mobile (< 768px) stays classic
    assert.equal(readWorkspaceUiMode('scope-url', 1440, '#/desktop'), 'os-desktop');
    assert.equal(readWorkspaceUiMode('scope-url', 390, '#/desktop'), 'classic');

    // Persisting mode writes both scoped key and last-mode boot fallback key
    writeWorkspaceUiMode('scope-boot', 'os-desktop', 1440);
    assert.equal(readWorkspaceUiMode(undefined, 1440, '#/tab/sessions'), 'os-desktop');
    assert.equal(readWorkspaceUiMode('scope-boot', 1440, '#/tab/sessions'), 'os-desktop');
    assert.equal(bootstrapDesktopImmersiveDataset('scope-boot', 1440), 'os-desktop');

    writeWorkspaceUiMode('scope-boot', 'classic', 1440);
    assert.equal(readWorkspaceUiMode('scope-boot', 1440, '#/tab/sessions'), 'classic');
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: prevStorage,
    });
  }
});

test('computeTaskbarMetrics scales icons, buttons, and pills proportionally with taskbar height', () => {
  const defaultMetrics = computeTaskbarMetrics(48);
  assert.equal(defaultMetrics.taskbarHeight, 48);
  assert.equal(defaultMetrics.scale, 1);
  assert.equal(defaultMetrics.iconSize, 14);
  assert.equal(defaultMetrics.startIconSize, 15);
  assert.equal(defaultMetrics.buttonHeight, 34);

  const compactMetrics = computeTaskbarMetrics(38);
  assert.equal(compactMetrics.taskbarHeight, 38);
  assert.ok(compactMetrics.iconSize <= defaultMetrics.iconSize);
  assert.ok(compactMetrics.buttonHeight < defaultMetrics.buttonHeight);

  const expandedMetrics = computeTaskbarMetrics(88);
  assert.equal(expandedMetrics.taskbarHeight, 88);
  assert.ok(expandedMetrics.scale > 1.7);
  assert.ok(expandedMetrics.iconSize >= 24);
  assert.ok(expandedMetrics.startIconSize >= 26);
  assert.ok(expandedMetrics.buttonHeight >= 70);
  assert.ok(expandedMetrics.fontSizePx > defaultMetrics.fontSizePx);
  assert.ok(expandedMetrics.pillMaxWidthPx > defaultMetrics.pillMaxWidthPx);
});

test('detectNewlyCompletedSessions identifies sessions transitioning from running to completed or added to completedSessionKeys', () => {
  const sessions = [
    { sessionKey: 'agent:codex:alpha', title: 'Alpha Task', status: 'idle' },
    { sessionKey: 'agent:codex:beta', title: 'Beta Stream', status: 'idle' },
    { sessionKey: 'agent:codex:gamma', title: 'Gamma Running', status: 'running' },
  ] as unknown as SessionSummary[];

  const newlyDone = detectNewlyCompletedSessions({
    sessions,
    prevRunningKeys: new Set(['agent:codex:alpha', 'agent:codex:gamma']),
    prevCompletedKeys: new Set(),
    nextCompletedKeys: new Set(['agent:codex:beta']),
  });

  const keys = newlyDone.map((s) => s.sessionKey);
  assert.deepEqual(keys.sort(), ['agent:codex:alpha', 'agent:codex:beta']);

  // Second tick when completedSessionKeys catches up for alpha must not re-emit alpha
  const secondTick = detectNewlyCompletedSessions({
    sessions,
    prevRunningKeys: new Set(['agent:codex:gamma']),
    prevCompletedKeys: new Set(['agent:codex:alpha', 'agent:codex:beta']),
    nextCompletedKeys: new Set(['agent:codex:alpha', 'agent:codex:beta']),
  });
  assert.deepEqual(secondTick, []);

  // Session with status !== 'running' but hasActiveRun === true is still running and must not trigger early completion
  const stillActiveRun = detectNewlyCompletedSessions({
    sessions: [
      { sessionKey: 'agent:codex:delta', title: 'Delta Task', status: 'idle', hasActiveRun: true },
    ] as unknown as SessionSummary[],
    prevRunningKeys: new Set(['agent:codex:delta']),
    prevCompletedKeys: new Set(),
    nextCompletedKeys: new Set(),
  });
  assert.deepEqual(stillActiveRun, []);
});

test('readDesktopNotifications and writeDesktopNotifications persist notification center history', () => {
  const store = new Map<string, string>();
  const prevStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      get length() { return store.size; },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    },
  });
  try {
    assert.deepEqual(readDesktopNotifications('scope-notif'), []);
    writeDesktopNotifications('scope-notif', [
      {
        id: 'notif-1',
        kind: 'session-completed',
        title: 'Session completed',
        body: 'Alpha Task finished execution',
        sessionKey: 'agent:codex:alpha',
        createdAt: 1793000000000,
        read: false,
      },
    ]);
    const loaded = readDesktopNotifications('scope-notif');
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.id, 'notif-1');
    assert.equal(loaded[0]?.sessionKey, 'agent:codex:alpha');
    assert.equal(loaded[0]?.read, false);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: prevStorage,
    });
  }
});

test('OS desktop boot overlay uses a dedicated smooth fade-out phase and non-blank Suspense handoff to prevent flicker', async () => {
  const { readFileSync } = await import('node:fs');
  const wod = readFileSync(new URL('src/components/WorkspaceOsDesktop.tsx', `file://${process.cwd()}/`), 'utf8');
  const swv = readFileSync(new URL('src/components/SessionWorkspaceView.tsx', `file://${process.cwd()}/`), 'utf8');
  const main = readFileSync(new URL('src/main.tsx', `file://${process.cwd()}/`), 'utf8');
  const css = readFileSync(new URL('src/styles.css', `file://${process.cwd()}/`), 'utf8');

  assert.match(wod, /'boot-fading'/);
  assert.match(wod, /is-fading-out/);
  assert.match(wod, /skipBootToSmoothFade/);
  assert.match(wod, /data-power-stage=\{powerPhase\}/);
  assert.match(swv, /os-power-overlay is-booting/);
  assert.match(main, /OsPowerBootFallback/);
  assert.match(css, /\.os-power-overlay\.is-fading-out/);
  assert.match(css, /\.os-desktop-shell\.power-stage-boot-fading/);
});

test('readWorkspaceColorMode, writeWorkspaceColorMode, and toggleWorkspaceColorMode persist Dark/Light mode across Classic & Desktop UI', () => {
  const store = new Map<string, string>();
  const prevStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      get length() { return store.size; },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    },
  });
  try {
    assert.equal(readWorkspaceColorMode(), 'light');
    writeWorkspaceColorMode('dark');
    assert.equal(readWorkspaceColorMode(), 'dark');
    const next = toggleWorkspaceColorMode();
    assert.equal(next, 'light');
    assert.equal(readWorkspaceColorMode(), 'light');
    assert.equal(toggleWorkspaceColorMode('light'), 'dark');
    assert.equal(readWorkspaceColorMode(), 'dark');
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: prevStorage,
    });
  }
});

test('buildDesktopIcons includes Chat Studio split conversation app shortcut and Docker card uses theme variables', async () => {
  const icons = buildDesktopIcons({
    sessions: [
      {
        sessionKey: 'agent:codex:alpha',
        title: 'Alpha Task',
        status: 'running',
        hasActiveRun: true,
      } as SessionSummary,
    ],
    notebooks: [],
    labels: {
      wechatMessenger: '对话工作台',
    },
  });
  const wechatIcon = icons.find((ic) => ic.id === 'app:wechat-messenger');
  assert.ok(wechatIcon, 'Expected app:wechat-messenger icon in desktop icons');
  assert.equal(wechatIcon?.kind, 'wechat-messenger');
  assert.equal(wechatIcon?.title, '对话工作台');

  const { readFileSync } = await import('node:fs');
  const dockerCard = readFileSync(new URL('src/components/WorkspaceDocker.tsx', `file://${process.cwd()}/`), 'utf8');
  const wod = readFileSync(new URL('src/components/WorkspaceOsDesktop.tsx', `file://${process.cwd()}/`), 'utf8');
  const swv = readFileSync(new URL('src/components/SessionWorkspaceView.tsx', `file://${process.cwd()}/`), 'utf8');
  const css = readFileSync(new URL('src/styles.css', `file://${process.cwd()}/`), 'utf8');

  assert.match(dockerCard, /var\(--docker-text\)/);
  assert.match(dockerCard, /var\(--docker-bg\)/);
  assert.match(wod, /os-desktop-wechat-window/);
  assert.match(wod, /os-wechat-session-list/);
  assert.match(wod, /os-wechat-chat-stage/);
  assert.match(swv, /workspace-theme-toggle/);
  assert.match(css, /html\[data-color-mode="dark"\]/);
  assert.match(css, /\.os-desktop-shell\.color-mode-light/);
  assert.match(css, /\.os-wechat-window/);
});

test('Light mode styles cover HUD widget, start menu, taskbar buttons, file browser toolbar, and Chat Studio flex layout', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('src/styles.css', `file://${process.cwd()}/`), 'utf8');
  const wod = readFileSync(new URL('src/components/WorkspaceOsDesktop.tsx', `file://${process.cwd()}/`), 'utf8');

  assert.match(css, /\.os-desktop-shell\.color-mode-light\s+\.os-desktop-hud-widget/);
  assert.match(css, /\.os-desktop-shell\.color-mode-light\s+\.os-desktop-start-menu/);
  assert.match(css, /\.os-desktop-shell\.color-mode-light\s+\.os-taskbar-quick-btn/);
  assert.match(css, /\.os-desktop-shell\.color-mode-light\s+\.os-window-subtoolbar\[data-unified-window-bar="true"\]\s+:is\(\.workspace-files-sources/);
  assert.match(css, /\.os-wechat-window-content\s*>\s*\.os-desktop-pane-content/);
  assert.match(wod, /os-window-move-screen-/);
  assert.match(wod, /transfer-window/);
});

test('Light mode styles cover desktop right-click context menu buttons, pills, shortcut icon plates, and fences', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('src/styles.css', `file://${process.cwd()}/`), 'utf8');

  assert.match(css, /\.os-desktop-shell\.color-mode-light\s+\.os-context-refresh-btn/);
  assert.match(css, /\.os-desktop-shell\.color-mode-light\s+\.os-context-quick-grid\s+button/);
  assert.match(css, /\.os-desktop-shell\.color-mode-light\s+\.os-context-pill-bar/);
  assert.match(css, /\.os-desktop-shell\.color-mode-light\s+\.os-desktop-shortcut\.variant-new-action/);
  assert.match(css, /\.os-desktop-shell\.color-mode-light\s+\.os-desktop-shortcut-icon\.variant-new-action/);
  assert.match(css, /\.os-desktop-shell\.color-mode-light\s+\.os-desktop-shortcut-icon\.kind-desktop-file/);
  assert.match(css, /\.os-desktop-shell\.color-mode-light\s+\.os-desktop-fence-header/);
});

test("Chat Studio switches sessions in-place via renderSessionContent without popping out standalone windows and uses light rail/avatar styles in Light Mode", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("src/styles.css", `file://${process.cwd()}/`), "utf8");
  const wod = readFileSync(new URL("src/components/WorkspaceOsDesktop.tsx", `file://${process.cwd()}/`), "utf8");
  const swv = readFileSync(new URL("src/components/SessionWorkspaceView.tsx", `file://${process.cwd()}/`), "utf8");

  assert.match(wod, /renderSessionContent\?:/);
  assert.match(wod, /activeSession && renderSessionContent \?/);
  assert.match(wod, /popOutWechatSessionToWindow/);
  assert.match(swv, /renderSessionContent=\{sess =>/);
  assert.match(css, /\.os-desktop-shell\.color-mode-light\s+\.os-wechat-rail/);
  assert.match(css, /\.os-desktop-shell\.color-mode-light\s+\.os-wechat-item-avatar/);
  assert.match(css, /-webkit-font-smoothing:\s*antialiased/);
  assert.doesNotMatch(css, /\.os-desktop-window-layer\s*\{\s*z-index:\s*120/);
  assert.match(css, /\.os-desktop-window-layer\s*\{\s*z-index:\s*auto/);
});


test('buildDesktopIcons and resolveDesktopLineageLinks include all notebooks even when classic popover hidden is true', () => {
  const notebooks = [
    { id: 'default', title: 'TODO', hidden: true },
    { id: 'nb-2', title: 'AgentOpsDeck 优化', hidden: true },
    { id: 'nb-3', title: 'InfoRiver', hidden: true },
    { id: '9b98371e-f782-46c0-a4c2-ef012077fc12', title: '', hidden: true },
  ];
  const icons = buildDesktopIcons({
    sessions: [],
    notebooks,
    taskboards: [],
  });
  const nbIcons = icons.filter((ic) => ic.kind === 'notebook' && ic.variant !== 'new-action');
  assert.equal(nbIcons.length, 4);
  assert.equal(nbIcons[0]?.id, 'app:notebook');
  assert.equal(nbIcons[0]?.title, 'TODO');
  assert.equal(nbIcons[1]?.id, 'notebook:nb-2');
  assert.equal(nbIcons[1]?.title, 'AgentOpsDeck 优化');
  assert.equal(nbIcons[2]?.id, 'notebook:nb-3');
  assert.equal(nbIcons[3]?.id, 'notebook:9b98371e-f782-46c0-a4c2-ef012077fc12');
  assert.match(nbIcons[3]?.title ?? '', /#4 \(9b9837\)/);

  const edges = resolveDesktopLineageLinks({
    notebooks,
    notebookBindings: {
      'nb-2': ['sess-1'],
    },
  });
  assert.equal(edges.length, 1);
  assert.equal(edges[0]?.fromIconId, 'notebook:nb-2');
  assert.equal(edges[0]?.toIconId, 'session:sess-1');
});

test('computeDesktopPointTextStyle calculates position-aware contrast and distinct colors across dark, light, and split-gradient backgrounds', () => {
  // 1. Dark wallpaper at top-left vs bottom-right
  const sunsetTopLeft = computeDesktopPointTextStyle({
    x: 200,
    y: 140,
    surfaceWidth: 1440,
    surfaceHeight: 900,
    wallpaper: 'sunset',
    colorMode: 'dark',
    surfaceContext: 'desktop',
  });
  const sunsetBottomRight = computeDesktopPointTextStyle({
    x: 1300,
    y: 800,
    surfaceWidth: 1440,
    surfaceHeight: 900,
    wallpaper: 'sunset',
    colorMode: 'dark',
    surfaceContext: 'desktop',
  });
  assert.equal(sunsetTopLeft.tone, 'dark-bg');
  assert.equal(sunsetBottomRight.tone, 'dark-bg');
  assert.equal(sunsetTopLeft.textColor, '#ffffff');
  assert.equal(sunsetTopLeft.textShadow, 'none');
  assert.ok(sunsetTopLeft.contrastRatio >= 4.5);

  // 2. Light mode desktop produces dark ink text with high contrast
  const lightModePt = computeDesktopPointTextStyle({
    x: 300,
    y: 250,
    surfaceWidth: 1440,
    surfaceHeight: 900,
    wallpaper: 'aurora',
    colorMode: 'light',
    surfaceContext: 'desktop',
  });
  assert.equal(lightModePt.tone, 'light-bg');
  assert.ok(lightModePt.contrastRatio >= 7);

  // 3. Custom gradient or image where left side is bright white (#ffffff) and right side is dark navy (#020617)
  const splitConfig = {
    theme: 'custom' as const,
    customGradient: 'linear-gradient(135deg, #ffffff 0%, #020617 100%)',
    dimOpacity: 0,
  };
  const brightCorner = computeDesktopPointTextStyle({
    x: 40,
    y: 40,
    surfaceWidth: 1440,
    surfaceHeight: 900,
    wallpaper: 'custom',
    wallpaperConfig: splitConfig,
    colorMode: 'dark',
    surfaceContext: 'desktop',
  });
  const darkCorner = computeDesktopPointTextStyle({
    x: 1400,
    y: 860,
    surfaceWidth: 1440,
    surfaceHeight: 900,
    wallpaper: 'custom',
    wallpaperConfig: splitConfig,
    colorMode: 'dark',
    surfaceContext: 'desktop',
  });
  assert.equal(brightCorner.tone, 'light-bg');
  assert.equal(darkCorner.tone, 'dark-bg');
  assert.notEqual(brightCorner.textColor, darkCorner.textColor);
});

test('computeDesktopPointTextStyle never adds a background pill and adapts purely via font color', () => {
  const midToneConfig = {
    theme: 'custom' as const,
    customGradient: 'linear-gradient(135deg, #64748b 0%, #94a3b8 100%)',
    dimOpacity: 0,
  };
  const pt = computeDesktopPointTextStyle({
    x: 400,
    y: 400,
    surfaceWidth: 1440,
    surfaceHeight: 900,
    wallpaper: 'custom',
    wallpaperConfig: midToneConfig,
    colorMode: 'dark',
    surfaceContext: 'desktop',
  });
  assert.equal(pt.pillBg, 'transparent');
  assert.equal(pt.textShadow, 'none');
  assert.ok(pt.textColor === '#ffffff' || pt.textColor === '#0f172a');
});

test('readDesktopPinnedSessions and writeDesktopPinnedSessions persist Chat Studio pinned sessions', () => {
  const store = new Map<string, string>();
  const prevStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      get length() { return store.size; },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    },
  });
  try {
    assert.deepEqual(readDesktopPinnedSessions('scope-pin'), []);
    writeDesktopPinnedSessions('scope-pin', ['sess-a', 'sess-b', 'sess-a']);
    assert.deepEqual(readDesktopPinnedSessions('scope-pin'), ['sess-a', 'sess-b']);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: prevStorage,
    });
  }
});

test('resolveNonOverlappingIconLayout prevents overlap between custom dragged icons and auto grid icons', () => {
  const icons = [
    { id: 'icon-1' },
    { id: 'icon-2' },
    { id: 'icon-3' },
    { id: 'icon-4' },
    { id: 'icon-5' },
  ];
  // Drag icon-3 and icon-4 right onto the first grid cell (12, 10) where icon-1 would normally sit
  const layout = resolveNonOverlappingIconLayout({
    icons,
    iconPositions: {
      'icon-3': { x: 12, y: 10 },
      'icon-4': { x: 14, y: 12 },
    },
    surfaceWidth: 1280,
    surfaceHeight: 720,
    taskbarHeight: 48,
  });

  const slots = Object.values(layout);
  assert.equal(slots.length, 5);
  for (let i = 0; i < slots.length; i += 1) {
    for (let j = i + 1; j < slots.length; j += 1) {
      const a = slots[i]!;
      const b = slots[j]!;
      const overlaps = Math.abs(a.x - b.x) < 76 && Math.abs(a.y - b.y) < 78;
      assert.equal(overlaps, false, `Expected ${a.id} (${a.x},${a.y}) and ${b.id} (${b.x},${b.y}) not to overlap`);
    }
  }
});

test('organizeDesktopIconsGrid snaps scattered desktop icons into neat non-overlapping grid columns', () => {
  const icons = Array.from({ length: 10 }, (_, i) => ({ id: `icon-${i + 1}` }));
  const organized = organizeDesktopIconsGrid({
    icons,
    surfaceWidth: 1280,
    surfaceHeight: 720,
    taskbarHeight: 48,
  });

  assert.equal(Object.keys(organized).length, 10);
  assert.deepEqual(organized['icon-1'], { x: 12, y: 10 });
  assert.deepEqual(organized['icon-2'], { x: 12, y: 112 });
  // Second column starts after rowsPerCol (6 rows fit in 720 - 48 - 26 = 646px at 102px/row)
  assert.deepEqual(organized['icon-7'], { x: 110, y: 10 });
});

test('formatHudKernelTelemetry reports real Linux cgroup v2 memory.current even when memory.max is unlimited (null)', () => {
  const emptyTelemetry = formatHudKernelTelemetry(null);
  assert.equal(emptyTelemetry.hasRealSample, false);
  assert.equal(emptyTelemetry.cpuText, 'Sampling...');
  assert.equal(emptyTelemetry.memText, 'Sampling...');
  assert.equal(emptyTelemetry.diskText, 'Sampling...');

  const cgroupSample = formatHudKernelTelemetry({
    scope: 'cgroup',
    cpu: { percent: 18.4, cores: 8 },
    memory: { usedBytes: 2_254_857_830, totalBytes: null },
    volumes: [],
  });
  assert.equal(cgroupSample.hasRealSample, true);
  assert.equal(cgroupSample.scopeLabel, 'cgroup');
  assert.equal(cgroupSample.cpuPct, 18.4);
  assert.equal(cgroupSample.cpuText, '18.4% (8C)');
  assert.equal(cgroupSample.memText, '2.1G (Cgroup RSS)');
  assert.ok(cgroupSample.memBarWidth >= 10 && cgroupSample.memBarWidth <= 30);
  assert.equal(cgroupSample.diskText, 'Unconfigured');
});

test('readDesktopDeletedUsers and writeDesktopDeletedUsers normalize and deduplicate deleted Hub and Connector users', () => {
  assert.deepEqual(readDesktopDeletedUsers('scope-a'), { hubUserIds: [], connectorUserKeys: [] });
  const saved = writeDesktopDeletedUsers('scope-a', {
    hubUserIds: ['alice', 'bob', 'alice', ''],
    connectorUserKeys: ['conn-1::alice', 'conn-1::alice'],
  });
  assert.deepEqual(saved, {
    hubUserIds: ['alice', 'bob'],
    connectorUserKeys: ['conn-1::alice'],
  });
});

test("light mode wallpaper switching, private/incognito storage fallback, and desktop create-session dialog styling", () => {
  // 1. Private/incognito window where storageScope is undefined still persists wallpaper in-memory
  writeDesktopWallpaper(undefined, "sunset");
  assert.equal(readDesktopWallpaper(undefined), "sunset");

  writeDesktopWallpaperConfig(undefined, {
    theme: "oceanic",
    customImageUrl: "https://example.com/bg.png",
    fit: "cover",
  });
  const cfg = readDesktopWallpaperConfig(undefined);
  assert.equal(cfg.theme, "oceanic");
  assert.equal(cfg.customImageUrl, "https://example.com/bg.png");

  // 2. Light mode wallpaper luminance sampling respects selected built-in dark wallpapers (e.g. midnight vs aurora)
  const auroraLightStyle = computeDesktopPointTextStyle({
    x: 120,
    y: 120,
    surfaceWidth: 1280,
    surfaceHeight: 720,
    wallpaper: "aurora",
    colorMode: "light",
  });
  const midnightLightStyle = computeDesktopPointTextStyle({
    x: 120,
    y: 120,
    surfaceWidth: 1280,
    surfaceHeight: 720,
    wallpaper: "midnight",
    colorMode: "light",
  });
  assert.equal(auroraLightStyle.tone, "light-bg");
  assert.equal(auroraLightStyle.textColor, "#0f172a");
  assert.equal(midnightLightStyle.tone, "dark-bg");
  assert.equal(midnightLightStyle.textColor, "#ffffff");

  // 3. CSS & NewSessionDialog desktop OS styling rules
  const cssSource = fs.readFileSync(new URL("../../../src/styles.css", import.meta.url), "utf8");
  assert.ok(cssSource.includes(".os-desktop-shell.color-mode-light.wallpaper-aurora"));
  assert.ok(cssSource.includes(".os-desktop-shell.color-mode-light.wallpaper-midnight"));
  assert.ok(cssSource.includes(".os-new-session-modal-window"));
  assert.ok(cssSource.includes(".os-new-session-agent-pill"));

  const mainSource = fs.readFileSync(new URL("../../../src/main.tsx", import.meta.url), "utf8");
  assert.ok(mainSource.includes("os-new-session-modal-window"));
  assert.ok(mainSource.includes("os-new-session-agent-pills"));
});

test("computeCompanionWindowGeometry places compact floating companion near the right desktop edge", () => {
  const geo = computeCompanionWindowGeometry(1440, 900);
  assert.ok(geo.width >= 340 && geo.width <= 480);
  assert.ok(geo.height >= 380 && geo.height <= 680);
  assert.equal(geo.x, 1440 - geo.width - 24);
  assert.ok(geo.y >= 44);
});
