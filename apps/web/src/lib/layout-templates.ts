import { DEFAULT_HUB_NOTEBOOK_LAYOUT, workspaceFileCardResource } from '@agentopsdeck/shared';
import { isSessionPane, paneKey, type Dock, type Pane, type SessionWorkspace } from './workspace-layout.js';
import {
  buildModeratorGuidancePrimer,
  loadModeratorOrchestrationConfig,
  saveModeratorOrchestrationConfig,
} from './moderator-orchestrator.js';

export type WorkspaceTemplateId = 'moderator-mode' | 'collab-pair' | 'research-triage';

export type WorkspaceTemplateDescriptor = {
  id: WorkspaceTemplateId;
  name: string;
  description: string;
};

export const WORKSPACE_TEMPLATES: readonly WorkspaceTemplateDescriptor[] = [
  {
    id: 'moderator-mode',
    name: 'Moderator Mode',
    description: 'Live STT control center in the middle, Moderator + Scout sessions on the left, and linked Meeting Notebook + Action Taskboard on the right.',
  },
  {
    id: 'collab-pair',
    name: 'Dual Session + Shared Notes & Taskboard',
    description: 'Two side-by-side agent sessions bound to a shared notebook and taskboard.',
  },
  {
    id: 'research-triage',
    name: 'Research & Triage Deck',
    description: 'Primary session with Search & Sources, Issue Sources, and Taskboard.',
  },
] as const;

export type BuildTemplateOptions = {
  primarySessionKey?: string | undefined;
  secondarySessionKey?: string | undefined;
  notebookTarget?: 'session' | 'hub' | undefined;
  notebookResourceId?: string | undefined;
  taskboardResourceId?: string | undefined;
  idFactory?: ((prefix: string) => string) | undefined;
};

function defaultIdFactory(prefix: string): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `pane:${prefix}-${random}`;
}

export function buildWorkspaceFromTemplate(
  templateId: WorkspaceTemplateId,
  options: BuildTemplateOptions = {},
): SessionWorkspace {
  const makeId = options.idFactory ?? defaultIdFactory;
  const primarySessionKey = options.primarySessionKey?.trim() || undefined;
  const secondarySessionKey = options.secondarySessionKey?.trim() && options.secondarySessionKey !== primarySessionKey
    ? options.secondarySessionKey.trim()
    : undefined;
  const taskboardResourceId = options.taskboardResourceId || 'default';

  if (templateId === 'moderator-mode') {
    const moderatorPaneId = makeId('moderator');
    const notePaneId = makeId('note');
    const boardPaneId = makeId('board');
    const primaryPaneId = primarySessionKey ? makeId('mod-session') : undefined;
    const secondaryPaneId = secondarySessionKey ? makeId('scout-session') : undefined;

    const notebookTarget: 'session' | 'hub' = options.notebookTarget
      ?? (options.notebookResourceId ? 'hub' : primarySessionKey ? 'session' : 'hub');
    const notebookResourceId = options.notebookResourceId
      ?? (notebookTarget === 'session' && primarySessionKey ? primarySessionKey : 'default');

    const moderatorKey = paneKey({ id: moderatorPaneId, kind: 'moderator', resourceId: 'control' });
    const noteKey = paneKey({ id: notePaneId, kind: 'notebook', target: notebookTarget, resourceId: notebookResourceId });
    const boardKey = paneKey({ id: boardPaneId, kind: 'taskboard', resourceId: taskboardResourceId });

    const panes: Pane[] = [];
    if (primaryPaneId && primarySessionKey) {
      panes.push({
        id: primaryPaneId,
        sessionKey: primarySessionKey,
        fileLinks: [moderatorKey, noteKey, boardKey, ...(secondarySessionKey ? [secondarySessionKey] : [])],
      });
    }
    if (secondaryPaneId && secondarySessionKey) {
      panes.push({
        id: secondaryPaneId,
        sessionKey: secondarySessionKey,
        fileLinks: primarySessionKey ? [primarySessionKey] : [moderatorKey],
      });
    }
    panes.push({
      id: moderatorPaneId,
      kind: 'moderator',
      resourceId: 'control',
      fileLinks: primarySessionKey ? [primarySessionKey] : [noteKey, boardKey],
    });
    panes.push({
      id: notePaneId,
      kind: 'notebook',
      target: notebookTarget,
      resourceId: notebookResourceId,
      fileLinks: primarySessionKey ? [primarySessionKey] : [moderatorKey],
    });
    panes.push({
      id: boardPaneId,
      kind: 'taskboard',
      resourceId: taskboardResourceId,
      fileLinks: primarySessionKey ? [primarySessionKey] : [moderatorKey],
    });

    const leftDock: Dock = primaryPaneId && secondaryPaneId
      ? {
          kind: 'split',
          axis: 'vertical',
          ratio: 0.58,
          first: { kind: 'pane', id: primaryPaneId },
          second: { kind: 'pane', id: secondaryPaneId },
        }
      : primaryPaneId
        ? { kind: 'pane', id: primaryPaneId }
        : { kind: 'pane', id: moderatorPaneId };

    const rightDock: Dock = {
      kind: 'split',
      axis: 'vertical',
      ratio: 0.54,
      first: { kind: 'pane', id: notePaneId },
      second: { kind: 'pane', id: boardPaneId },
    };

    const centerAndRight: Dock = primaryPaneId
      ? {
          kind: 'split',
          axis: 'horizontal',
          ratio: 0.48,
          first: { kind: 'pane', id: moderatorPaneId },
          second: rightDock,
        }
      : rightDock;

    return {
      version: 2,
      panes,
      dock: {
        kind: 'split',
        axis: 'horizontal',
        ratio: primaryPaneId ? 0.36 : 0.48,
        first: leftDock,
        second: centerAndRight,
      },
      floating: [],
      active: moderatorPaneId,
    };
  }

  if (templateId === 'collab-pair') {
    const notePaneId = makeId('note');
    const boardPaneId = makeId('board');
    const primaryPaneId = primarySessionKey ? makeId('session-a') : undefined;
    const secondaryPaneId = secondarySessionKey ? makeId('session-b') : undefined;
    const notebookTarget: 'session' | 'hub' = options.notebookTarget
      ?? (options.notebookResourceId ? 'hub' : primarySessionKey ? 'session' : 'hub');
    const notebookResourceId = options.notebookResourceId
      ?? (notebookTarget === 'session' && primarySessionKey ? primarySessionKey : 'default');

    const noteKey = paneKey({ id: notePaneId, kind: 'notebook', target: notebookTarget, resourceId: notebookResourceId });
    const boardKey = paneKey({ id: boardPaneId, kind: 'taskboard', resourceId: taskboardResourceId });

    const panes: Pane[] = [];
    if (primaryPaneId && primarySessionKey) {
      panes.push({
        id: primaryPaneId,
        sessionKey: primarySessionKey,
        fileLinks: [noteKey, boardKey, ...(secondarySessionKey ? [secondarySessionKey] : [])],
      });
    }
    if (secondaryPaneId && secondarySessionKey) {
      panes.push({
        id: secondaryPaneId,
        sessionKey: secondarySessionKey,
        fileLinks: [noteKey, boardKey, ...(primarySessionKey ? [primarySessionKey] : [])],
      });
    }
    panes.push({
      id: notePaneId,
      kind: 'notebook',
      target: notebookTarget,
      resourceId: notebookResourceId,
      fileLinks: [
        ...(primarySessionKey ? [primarySessionKey] : []),
        ...(secondarySessionKey ? [secondarySessionKey] : []),
      ],
    });
    panes.push({
      id: boardPaneId,
      kind: 'taskboard',
      resourceId: taskboardResourceId,
      fileLinks: [
        ...(primarySessionKey ? [primarySessionKey] : []),
        ...(secondarySessionKey ? [secondarySessionKey] : []),
      ],
    });

    const leftDock: Dock | undefined = primaryPaneId && secondaryPaneId
      ? {
          kind: 'split',
          axis: 'horizontal',
          ratio: 0.5,
          first: { kind: 'pane', id: primaryPaneId },
          second: { kind: 'pane', id: secondaryPaneId },
        }
      : primaryPaneId
        ? { kind: 'pane', id: primaryPaneId }
        : undefined;

    const rightDock: Dock = {
      kind: 'split',
      axis: 'vertical',
      ratio: 0.52,
      first: { kind: 'pane', id: notePaneId },
      second: { kind: 'pane', id: boardPaneId },
    };

    return {
      version: 2,
      panes,
      dock: leftDock
        ? { kind: 'split', axis: 'horizontal', ratio: 0.62, first: leftDock, second: rightDock }
        : rightDock,
      floating: [],
      active: primaryPaneId ?? notePaneId,
    };
  }

  // research-triage
  const researchPaneId = makeId('research');
  const boardPaneId = makeId('board');
  const primaryPaneId = primarySessionKey ? makeId('session') : undefined;
  const researchKey = paneKey({ id: researchPaneId, kind: 'research', resourceId: 'search' });
  const boardKey = paneKey({ id: boardPaneId, kind: 'taskboard', resourceId: taskboardResourceId });
  const panes: Pane[] = [];
  if (primaryPaneId && primarySessionKey) {
    panes.push({ id: primaryPaneId, sessionKey: primarySessionKey, fileLinks: [researchKey, boardKey] });
  }
  panes.push({ id: researchPaneId, kind: 'research', resourceId: 'search', fileLinks: primarySessionKey ? [primarySessionKey] : [] });
  panes.push({ id: boardPaneId, kind: 'taskboard', resourceId: taskboardResourceId, fileLinks: primarySessionKey ? [primarySessionKey] : [] });

  const rightDock: Dock = {
    kind: 'split',
    axis: 'vertical',
    ratio: 0.55,
    first: { kind: 'pane', id: researchPaneId },
    second: { kind: 'pane', id: boardPaneId },
  };

  return {
    version: 2,
    panes,
    dock: primaryPaneId
      ? { kind: 'split', axis: 'horizontal', ratio: 0.5, first: { kind: 'pane', id: primaryPaneId }, second: rightDock }
      : rightDock,
    floating: [],
    active: primaryPaneId ?? researchPaneId,
  };
}

/**
 * Re-wire a workspace when a Moderator target (Moderator Session, Scout Session,
 * Notebook, or Taskboard) is swapped in-place, updating both the pane slot in
 * the layout and all connected `fileLinks` edges automatically.
 */
export function retargetModeratorWorkspace(
  workspace: SessionWorkspace,
  previous: {
    moderatorSessionKey?: string | undefined;
    scoutSessionKey?: string | undefined;
    notebookTarget?: 'session' | 'hub' | undefined;
    notebookId?: string | undefined;
    taskboardId?: string | undefined;
  },
  next: {
    moderatorSessionKey?: string | undefined;
    scoutSessionKey?: string | undefined;
    notebookTarget?: 'session' | 'hub' | undefined;
    notebookId?: string | undefined;
    taskboardId?: string | undefined;
  },
): SessionWorkspace {
  const oldNoteKey = previous.notebookId
    ? paneKey({ id: 'tmp-old-note', kind: 'notebook', target: previous.notebookTarget ?? 'hub', resourceId: previous.notebookId })
    : undefined;
  const newNoteKey = next.notebookId
    ? paneKey({ id: 'tmp-new-note', kind: 'notebook', target: next.notebookTarget ?? 'hub', resourceId: next.notebookId })
    : undefined;
  const oldBoardKey = previous.taskboardId
    ? paneKey({ id: 'tmp-old-board', kind: 'taskboard', resourceId: previous.taskboardId })
    : undefined;
  const newBoardKey = next.taskboardId
    ? paneKey({ id: 'tmp-new-board', kind: 'taskboard', resourceId: next.taskboardId })
    : undefined;

  const replaceLink = (link: string): string => {
    if (previous.moderatorSessionKey && next.moderatorSessionKey && link === previous.moderatorSessionKey) {
      return next.moderatorSessionKey;
    }
    if (previous.scoutSessionKey && next.scoutSessionKey && link === previous.scoutSessionKey) {
      return next.scoutSessionKey;
    }
    if (oldNoteKey && newNoteKey && link === oldNoteKey) {
      return newNoteKey;
    }
    if (oldBoardKey && newBoardKey && link === oldBoardKey) {
      return newBoardKey;
    }
    return link;
  };

  const dedupe = (items: readonly string[] | undefined): string[] | undefined => {
    if (!items?.length) return undefined;
    const mapped = Array.from(new Set(items.map(replaceLink).filter(Boolean)));
    return mapped.length ? mapped : undefined;
  };

  let changed = false;
  const panes: Pane[] = workspace.panes.map(pane => {
    const updatedLinks = dedupe(pane.fileLinks);
    if (updatedLinks?.join('|') !== pane.fileLinks?.join('|')) changed = true;

    if (isSessionPane(pane)) {
      if (previous.moderatorSessionKey && next.moderatorSessionKey && pane.sessionKey === previous.moderatorSessionKey) {
        changed = true;
        return { ...pane, sessionKey: next.moderatorSessionKey, ...(updatedLinks ? { fileLinks: updatedLinks } : {}) };
      }
      if (previous.scoutSessionKey && next.scoutSessionKey && pane.sessionKey === previous.scoutSessionKey) {
        changed = true;
        return { ...pane, sessionKey: next.scoutSessionKey, ...(updatedLinks ? { fileLinks: updatedLinks } : {}) };
      }
      return updatedLinks !== pane.fileLinks
        ? { ...pane, ...(updatedLinks ? { fileLinks: updatedLinks } : {}) }
        : pane;
    }

    if (pane.kind === 'notebook' && next.notebookId && (
      !previous.notebookId || (pane.target === (previous.notebookTarget ?? 'hub') && pane.resourceId === previous.notebookId)
    )) {
      const target = next.notebookTarget ?? 'hub';
      if (pane.target !== target || pane.resourceId !== next.notebookId) {
        changed = true;
        return {
          ...pane,
          target,
          resourceId: next.notebookId,
          ...(updatedLinks ? { fileLinks: updatedLinks } : {}),
        };
      }
    }

    if (pane.kind === 'taskboard' && next.taskboardId && (
      !previous.taskboardId || pane.resourceId === previous.taskboardId
    )) {
      if (pane.resourceId !== next.taskboardId) {
        changed = true;
        return {
          ...pane,
          resourceId: next.taskboardId,
          ...(updatedLinks ? { fileLinks: updatedLinks } : {}),
        };
      }
    }

    return updatedLinks !== pane.fileLinks
      ? { ...pane, ...(updatedLinks ? { fileLinks: updatedLinks } : {}) }
      : pane;
  });

  return changed ? { ...workspace, panes } : workspace;
}

export type AutoBindTransport = {
  fileCardBinding: (resource: string) => Promise<{ enabled: boolean; binding: { state: string } | null }>;
  bindFileCard: (resource: string, intent: { requestId: string; sessionId: string; revision: number }) => Promise<unknown>;
  fileBoardBinding: (id: string) => Promise<{ enabled: boolean; binding: { state: string } | null }>;
  bindFileBoard: (id: string, intent: { requestId: string; sessionId: string; revision: number }) => Promise<unknown>;
  ensureHubNotebook?: ((id: string, title: string) => Promise<unknown>) | undefined;
  ensureWorkspaceBoard?: ((id: string, title: string) => Promise<unknown>) | undefined;
  sendGuidancePrimer?: ((sessionKey: string, text: string) => Promise<unknown>) | undefined;
};

export async function autoBindTemplateResources(
  scope: string,
  templateId: WorkspaceTemplateId,
  options: BuildTemplateOptions & { sendInitialGuidance?: boolean | undefined; resourceTitleSuffix?: string | undefined },
  transport?: AutoBindTransport,
): Promise<{ moderatorConfigUpdated: boolean; notebookBound: boolean; taskboardBound: boolean; guidanceSent: boolean }> {
  const primarySessionKey = options.primarySessionKey?.trim() || undefined;
  const secondarySessionKey = options.secondarySessionKey?.trim() && options.secondarySessionKey !== primarySessionKey
    ? options.secondarySessionKey.trim()
    : undefined;
  const notebookTarget: 'session' | 'hub' = options.notebookTarget
    ?? (options.notebookResourceId ? 'hub' : primarySessionKey ? 'session' : 'hub');
  const notebookResourceId = options.notebookResourceId
    ?? (notebookTarget === 'session' && primarySessionKey ? primarySessionKey : 'default');
  const taskboardResourceId = options.taskboardResourceId || 'default';
  const suffix = options.resourceTitleSuffix ?? new Date().toISOString().slice(0, 16).replace('T', ' ');

  if (transport?.ensureHubNotebook && notebookTarget === 'hub' && notebookResourceId !== 'default') {
    try {
      await transport.ensureHubNotebook(notebookResourceId, `Meeting Notes · ${suffix}`);
    } catch {
      // Best-effort notebook creation
    }
  }

  if (transport?.ensureWorkspaceBoard && taskboardResourceId !== 'default') {
    try {
      await transport.ensureWorkspaceBoard(taskboardResourceId, `Meeting Tasks · ${suffix}`);
    } catch {
      // Best-effort board creation
    }
  }

  let moderatorConfigUpdated = false;
  let guidanceSent = false;
  if (scope && templateId === 'moderator-mode') {
    const current = loadModeratorOrchestrationConfig(scope);
    const updatedConfig = {
      ...current,
      moderatorSessionKey: primarySessionKey ?? current.moderatorSessionKey,
      scoutSessionKey: secondarySessionKey ?? current.scoutSessionKey,
      notebookTarget,
      notebookId: notebookResourceId,
      taskboardId: taskboardResourceId,
    };
    saveModeratorOrchestrationConfig(scope, updatedConfig);
    moderatorConfigUpdated = true;

    if (options.sendInitialGuidance !== false && updatedConfig.moderatorSessionKey && transport?.sendGuidancePrimer) {
      try {
        const primer = buildModeratorGuidancePrimer(updatedConfig);
        await transport.sendGuidancePrimer(updatedConfig.moderatorSessionKey, primer);
        guidanceSent = true;
      } catch {
        // Best-effort initial guidance delivery
      }
    }
  }

  let notebookBound = false;
  let taskboardBound = false;
  if (!primarySessionKey || !transport) {
    return { moderatorConfigUpdated, notebookBound, taskboardBound, guidanceSent };
  }

  const makeReqId = () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

  if (templateId === 'moderator-mode' || templateId === 'collab-pair') {
    const noteCardResource = workspaceFileCardResource('notebook', `${notebookTarget}:${notebookResourceId}`);
    try {
      const existing = await transport.fileCardBinding(noteCardResource);
      if (existing.enabled) {
        await transport.bindFileCard(noteCardResource, {
          requestId: makeReqId(),
          sessionId: primarySessionKey,
          revision: 0,
        });
        notebookBound = true;
      }
    } catch {
      // Best-effort auto-binding
    }
  }

  try {
    const existingBoard = await transport.fileBoardBinding(taskboardResourceId);
    if (existingBoard.enabled) {
      await transport.bindFileBoard(taskboardResourceId, {
        requestId: makeReqId(),
        sessionId: primarySessionKey,
        revision: 0,
      });
      taskboardBound = true;
    }
  } catch {
    // Best-effort auto-binding
  }

  return { moderatorConfigUpdated, notebookBound, taskboardBound, guidanceSent };
}

export function createHubNotebookLayoutPayload(title: string): string {
  return JSON.stringify({
    ...DEFAULT_HUB_NOTEBOOK_LAYOUT,
    title,
    hidden: false,
    x: 96,
    y: 96,
  });
}

export function prepareTemplateOptions(
  templateId: WorkspaceTemplateId,
  sessions: ReadonlyArray<{ sessionKey: string }>,
  dismissed: ReadonlySet<string>,
  selectedSessionKey: string | undefined,
  firstNotebookId: string | undefined,
): BuildTemplateOptions {
  const activeSessions = sessions.filter(s => !dismissed.has(s.sessionKey));
  const isMod = templateId === "moderator-mode";
  const primaryKey = isMod ? undefined : (selectedSessionKey ?? activeSessions[0]?.sessionKey);
  const secondaryKey = isMod ? undefined : activeSessions.find(s => s.sessionKey !== primaryKey)?.sessionKey;
  const makeUuid = () => (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  return {
    primarySessionKey: primaryKey,
    secondarySessionKey: secondaryKey,
    notebookTarget: isMod ? "hub" : (firstNotebookId ? "hub" : (primaryKey ? "session" : "hub")),
    notebookResourceId: isMod ? makeUuid() : (firstNotebookId ?? primaryKey ?? "default"),
    taskboardResourceId: isMod ? makeUuid() : "default",
  };
}
