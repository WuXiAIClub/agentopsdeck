import {
  LEGACY_MAX_MESSAGE_CHARS,
  normalizeSourceFiles,
  workspaceFileCardResource,
  type BoardDocument,
  type BoardSummary,
  type ChatMessage,
  type SessionSummary,
} from '@agentopsdeck/shared';
import type { GuidanceSnapshot } from './session-guidance.js';
import type { NotebookDocument } from './session-notebook.js';
import type { Pane, SessionWorkspace } from './workspace-layout.js';
import { isSessionPane, paneKey, paneSessionKey, validPane } from './workspace-layout.js';
import { currentLayoutKey, layoutSnapshot, legacyCurrentLayoutKey, osDesktopLayoutKey, parseCurrentLayout } from './current-layout.js';
import { legacySavedLayoutKey, parseSavedLayouts, savedLayoutKey, validWorkspace, type SavedLayout } from './saved-layouts.js';
import type { FileBoardBinding, FileBoardIntent } from './workspace-file-board.js';

export const WATERMARK_ROLLOUT_WARNING_BYTES = 350 * 1024 * 1024;
export const WATERMARK_ROLLOUT_CRITICAL_BYTES = 750 * 1024 * 1024;
export const WATERMARK_MESSAGES_WARNING = 35_000;
export const WATERMARK_MESSAGES_CRITICAL = 80_000;
export const WATERMARK_COMPACTIONS_WARNING = 32;
export const WATERMARK_COMPACTIONS_CRITICAL = 55;
export const WATERMARK_COMPACTIONS_MIN_ROLLOUT_BYTES = 64 * 1024 * 1024;
export const WATERMARK_COMPACTIONS_MIN_MESSAGES = 6_000;

export const SESSION_HANDOFF_EVENT = 'agentopsdeck:session-handoff';

export type SessionHandoffEventDetail = {
  fromSessionKey: string;
  toSessionKey: string;
  session: SessionSummary;
  replaceSourcePane?: boolean | undefined;
  claimedSavedSync?: boolean | undefined;
  claimedCurrentSync?: boolean | undefined;
};

export type SessionWatermarkReason = 'rolloutBytes' | 'messageCount' | 'turnCompactions';
export type SessionWatermarkSeverity = 'warning' | 'critical';

export type SessionWatermarkMetrics = {
  rolloutBytes: number;
  messageCount: number;
  turnCompactions: number;
  lastTurnCompactions: number;
  maxTurnCompactions: number;
};

export type SessionWatermarkState = {
  triggered: boolean;
  severity: SessionWatermarkSeverity | null;
  reasons: SessionWatermarkReason[];
  metrics: SessionWatermarkMetrics;
};

export function evaluateSessionWatermark(
  session: Pick<SessionSummary, 'rolloutBytes' | 'messageCount' | 'lastTurnCompactions' | 'maxTurnCompactions'>,
  loadedMessageCount = 0,
): SessionWatermarkState {
  const rolloutBytes = Math.max(0, session.rolloutBytes ?? 0);
  const messageCount = Math.max(0, session.messageCount ?? 0, loadedMessageCount);
  const lastTurnCompactions = Math.max(0, session.lastTurnCompactions ?? 0);
  const maxTurnCompactions = Math.max(0, session.maxTurnCompactions ?? 0);
  const turnCompactions = Math.max(lastTurnCompactions, maxTurnCompactions);

  const reasons: SessionWatermarkReason[] = [];
  if (rolloutBytes >= WATERMARK_ROLLOUT_WARNING_BYTES) reasons.push('rolloutBytes');
  if (messageCount >= WATERMARK_MESSAGES_WARNING) reasons.push('messageCount');
  const compactionsSubstantial =
    turnCompactions >= WATERMARK_COMPACTIONS_CRITICAL ||
    (turnCompactions >= WATERMARK_COMPACTIONS_WARNING &&
      (rolloutBytes >= WATERMARK_COMPACTIONS_MIN_ROLLOUT_BYTES ||
        messageCount >= WATERMARK_COMPACTIONS_MIN_MESSAGES));
  if (compactionsSubstantial) reasons.push('turnCompactions');

  if (reasons.length === 0) {
    return {
      triggered: false,
      severity: null,
      reasons,
      metrics: { rolloutBytes, messageCount, turnCompactions, lastTurnCompactions, maxTurnCompactions },
    };
  }

  const isCritical =
    rolloutBytes >= WATERMARK_ROLLOUT_CRITICAL_BYTES ||
    messageCount >= WATERMARK_MESSAGES_CRITICAL ||
    turnCompactions >= WATERMARK_COMPACTIONS_CRITICAL;

  return {
    triggered: true,
    severity: isCritical ? 'critical' : 'warning',
    reasons,
    metrics: { rolloutBytes, messageCount, turnCompactions, lastTurnCompactions, maxTurnCompactions },
  };
}

export function formatRolloutBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 100) return `${Math.round(mb)} MB`;
  return `${mb.toFixed(1)} MB`;
}

export function watermarkDismissKey(scope: string, sessionKey: string, severity: SessionWatermarkSeverity): string {
  return `agentopsdeck.watermark-dismissed:v1:${scope}:${sessionKey}:${severity}`;
}

export function buildSessionHandoffTitle(rawTitle: string | undefined, fallbackKey: string): string {
  const base = (rawTitle?.trim() || fallbackKey.trim() || 'Session').slice(0, 96);
  const match = base.match(/^(.*?)(?:\s*[·\-]\s*(?:续接|Handoff)(?:\s*#?(\d+))?)$/i);
  if (match) {
    const stem = match[1]?.trim() || base;
    const nextNum = Number.parseInt(match[2] ?? '1', 10) + 1;
    return `${stem} · 续接 #${nextNum}`.slice(0, 110);
  }
  return `${base} · 续接`.slice(0, 110);
}

function cleanMessageExcerpt(content: string | undefined, maxChars: number): string {
  if (!content) return '';
  const normalized = content
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  const headChars = Math.max(120, Math.floor(maxChars * 0.45));
  const tailChars = Math.max(120, maxChars - headChars - 24);
  return `${normalized.slice(0, headChars).trimEnd()}\n… [truncated] …\n${normalized.slice(-tailChars).trimStart()}`;
}

function pickRecentRoleExcerpts(
  messages: readonly ChatMessage[],
  role: 'user' | 'assistant',
  maxItems: number,
  perItemChars: number,
): string[] {
  const picked: string[] = [];
  const seen = new Set<string>();
  for (let i = messages.length - 1; i >= 0 && picked.length < maxItems; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== role) continue;
    if (msg.status === 'failed') continue;
    const rawText = msg.text ?? (msg as ChatMessage & { content?: string }).content;
    const text = cleanMessageExcerpt(rawText, perItemChars);
    if (!text) continue;
    if (text === '/stop' || text === '/compact') continue;
    if (seen.has(text)) continue;
    seen.add(text);
    picked.push(text);
  }
  return picked.reverse();
}

function inferWorkingDirectoryHint(
  sourceSession: SessionSummary,
  messages: readonly ChatMessage[],
): string | undefined {
  const explicit = (sourceSession as SessionSummary & { cwd?: string }).cwd?.trim();
  if (explicit) return explicit;
  for (let i = messages.length - 1; i >= Math.max(0, messages.length - 200); i--) {
    const msg = messages[i];
    if (!msg || msg.role !== 'tool' || !msg.sourceFiles) continue;
    const files = normalizeSourceFiles(msg.sourceFiles);
    for (const file of files) {
      const slash = file.path.lastIndexOf('/');
      if (slash > 0) return file.path.slice(0, slash);
    }
  }
  return undefined;
}

export type InheritedArtifactsSummary = {
  sessionNotebookCopied: boolean;
  sessionNotebookPreview?: string | undefined;
  guidanceCopied: boolean;
  guidancePreview?: string | undefined;
  migratedBoardIds: string[];
  migratedHubNotebookIds: string[];
  modelApplied: boolean;
};

export type BuildHandoffPromptInput = {
  sourceSession: SessionSummary;
  messages: readonly ChatMessage[];
  watermark: SessionWatermarkState;
  inherited: InheritedArtifactsSummary;
  maxChars?: number | undefined;
};

export function buildSessionHandoffPrompt(input: BuildHandoffPromptInput): string {
  const hardCeiling = Math.max(2_000, Math.min(input.maxChars ?? LEGACY_MAX_MESSAGE_CHARS, LEGACY_MAX_MESSAGE_CHARS) - 600);
  const { sourceSession, messages, watermark, inherited } = input;
  const title = sourceSession.title?.trim() || sourceSession.sessionKey;

  const metricParts: string[] = [];
  if (watermark.metrics.rolloutBytes > 0) {
    metricParts.push(`rollout ${formatRolloutBytes(watermark.metrics.rolloutBytes)}`);
  }
  if (watermark.metrics.messageCount > 0) {
    metricParts.push(`${watermark.metrics.messageCount.toLocaleString('en-US')} messages`);
  }
  if (watermark.metrics.turnCompactions > 0) {
    metricParts.push(`max ${watermark.metrics.turnCompactions} compactions/turn`);
  }

  const lines: string[] = [
    '[Session Handoff / 无缝续接上下文]',
    `This is a clean continuation session forked from "${title}" (${sourceSession.sessionKey})${metricParts.length ? ` after reaching volume watermark (${metricParts.join(', ')})` : ''}.`,
    '',
  ];

  const resourceLines: string[] = [];
  const workingDir = inferWorkingDirectoryHint(sourceSession, messages);
  if (workingDir) {
    resourceLines.push(`- Working directory (reference): \`${workingDir}\``);
  }
  if (sourceSession.model?.trim()) {
    resourceLines.push(`- Source model: \`${sourceSession.model.trim()}\`${inherited.modelApplied ? ' (inherited)' : ''}`);
  }
  if (inherited.sessionNotebookCopied) {
    resourceLines.push('- Session notebook: migrated to this session');
  }
  if (inherited.guidanceCopied) {
    resourceLines.push('- Session fixed guidance: migrated to this session');
  }
  if (inherited.migratedBoardIds.length > 0) {
    resourceLines.push(`- Re-bound Taskboard(s): ${inherited.migratedBoardIds.map((id) => `\`${id}\``).join(', ')}`);
  }
  if (inherited.migratedHubNotebookIds.length > 0) {
    resourceLines.push(`- Re-bound Hub Notebook(s): ${inherited.migratedHubNotebookIds.map((id) => `\`${id}\``).join(', ')}`);
  }
  if (sourceSession.codexGoal?.objective?.trim()) {
    resourceLines.push(`- Active Goal reference: ${cleanMessageExcerpt(sourceSession.codexGoal.objective, 300)} (status: ${sourceSession.codexGoal.status})`);
  }

  if (resourceLines.length > 0) {
    lines.push('## Inherited Workspace & Environment Context', ...resourceLines, '');
  }

  if (inherited.guidancePreview?.trim()) {
    lines.push(
      '## Fixed Guidance Excerpt',
      cleanMessageExcerpt(inherited.guidancePreview, 1_200),
      '',
    );
  }

  if (inherited.sessionNotebookPreview?.trim()) {
    lines.push(
      '## Session Notebook Snapshot',
      cleanMessageExcerpt(inherited.sessionNotebookPreview, 2_200),
      '',
    );
  }

  const recentUser = pickRecentRoleExcerpts(messages, 'user', 5, 900);
  if (recentUser.length > 0) {
    lines.push('## Recent User Objectives & Instructions (Chronological)');
    recentUser.forEach((item, idx) => {
      lines.push(`### User [${idx + 1}/${recentUser.length}]`, item, '');
    });
  }

  const recentAssistant = pickRecentRoleExcerpts(messages, 'assistant', 4, 1_200);
  if (recentAssistant.length > 0) {
    lines.push('## Latest Assistant Progress & Conclusions (Chronological)');
    recentAssistant.forEach((item, idx) => {
      lines.push(`### Assistant [${idx + 1}/${recentAssistant.length}]`, item, '');
    });
  }

  lines.push(
    '## Handoff Readiness Request',
    '1. Briefly confirm you have absorbed the handoff summary, working directory, and any linked Notebook / Taskboard state (3-5 concise bullet points).',
    '2. Highlight the immediate next actionable step or open item, then stand by for my next instruction without repeating already-completed work.',
  );

  const full = lines.join('\n').trim();
  if (full.length <= hardCeiling) return full;
  return cleanMessageExcerpt(full, hardCeiling);
}

export function parseHubNotebookIdFromResource(resourceId: string): string | null {
  if (!resourceId) return null;
  try {
    const parsed = JSON.parse(resourceId) as unknown;
    if (Array.isArray(parsed) && parsed.length >= 3 && typeof parsed[2] === 'string' && parsed[2].trim()) {
      return parsed[2].trim();
    }
  } catch {
    // Fallback if plain id was passed
  }
  return null;
}

export type SessionArtifactInheritanceTransport = {
  isSharedSession: boolean;
  readSessionNotebook: (sessionKey: string) => Promise<NotebookDocument>;
  saveSessionNotebook: (sessionKey: string, value: { resourceId: string; text: string; revision: number }) => Promise<NotebookDocument>;
  readSessionGuidance?: ((sessionKey: string, signal: AbortSignal) => Promise<GuidanceSnapshot>) | undefined;
  saveSessionGuidance?: ((sessionKey: string, value: { revision: number; text: string; enabled: boolean }, signal: AbortSignal) => Promise<unknown>) | undefined;
  listWorkspaceBoards?: ((signal?: AbortSignal) => Promise<{ boards: BoardSummary[] }>) | undefined;
  readFileBoardBinding?: ((boardId: string, signal?: AbortSignal) => Promise<{ enabled: boolean; binding: FileBoardBinding | null }>) | undefined;
  revokeFileBoard?: ((boardId: string, bindingId: string, signal?: AbortSignal) => Promise<unknown>) | undefined;
  readWorkspaceBoard?: ((boardId: string, signal?: AbortSignal) => Promise<Pick<BoardDocument, 'revision'>>) | undefined;
  bindFileBoard?: ((boardId: string, input: FileBoardIntent, signal?: AbortSignal) => Promise<unknown>) | undefined;
  listHubNotebooks?: ((after?: string) => Promise<{ items: NotebookDocument[]; nextCursor: string | null }>) | undefined;
  readFileCardBinding?: ((cardResource: string, signal?: AbortSignal) => Promise<{ enabled: boolean; binding: FileBoardBinding | null }>) | undefined;
  revokeFileCard?: ((cardResource: string, bindingId: string, signal?: AbortSignal) => Promise<unknown>) | undefined;
  readFileCard?: ((cardResource: string, signal?: AbortSignal) => Promise<{ revision: number }>) | undefined;
  bindFileCard?: ((cardResource: string, input: FileBoardIntent, signal?: AbortSignal) => Promise<unknown>) | undefined;
  applyModelSettings?: (() => Promise<boolean>) | undefined;
  makeRequestId?: (() => string) | undefined;
};

export async function inheritSessionArtifacts(
  fromSessionKey: string,
  toSessionKey: string,
  transport: SessionArtifactInheritanceTransport,
  signal?: AbortSignal,
): Promise<InheritedArtifactsSummary> {
  const abort = signal ?? new AbortController().signal;
  const makeId = transport.makeRequestId ?? (() =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

  const summary: InheritedArtifactsSummary = {
    sessionNotebookCopied: false,
    guidanceCopied: false,
    migratedBoardIds: [],
    migratedHubNotebookIds: [],
    modelApplied: false,
  };

  // 1. Apply runtime model / thinking overrides in parallel-safe best-effort
  if (transport.applyModelSettings) {
    try {
      summary.modelApplied = await transport.applyModelSettings();
    } catch {
      summary.modelApplied = false;
    }
  }

  // 2. Copy per-session notebook text if non-empty
  try {
    const srcNote = await transport.readSessionNotebook(fromSessionKey);
    if (srcNote.text.trim()) {
      summary.sessionNotebookPreview = srcNote.text;
      const dstNote = await transport.readSessionNotebook(toSessionKey);
      await transport.saveSessionNotebook(toSessionKey, {
        resourceId: dstNote.resourceId,
        text: srcNote.text,
        revision: dstNote.revision,
      });
      summary.sessionNotebookCopied = true;
    }
  } catch {
    // Non-fatal: keep handoff resilient even if notebook endpoint fails
  }

  if (transport.isSharedSession) {
    return summary;
  }

  // 3. Copy per-session fixed guidance if configured
  if (transport.readSessionGuidance && transport.saveSessionGuidance) {
    try {
      const srcGuidance = await transport.readSessionGuidance(fromSessionKey, abort);
      const cfg = srcGuidance.guidance?.config;
      if (cfg && cfg.text.trim()) {
        summary.guidancePreview = cfg.text;
        const dstGuidance = await transport.readSessionGuidance(toSessionKey, abort);
        const dstRevision = dstGuidance.guidance?.config.revision ?? 0;
        await transport.saveSessionGuidance(
          toSessionKey,
          { revision: dstRevision, text: cfg.text, enabled: cfg.enabled },
          abort,
        );
        summary.guidanceCopied = true;
      }
    } catch {
      // Non-fatal
    }
  }

  // 4. Re-bind active Hub Taskboard file-bindings from old session to new session
  if (
    transport.listWorkspaceBoards &&
    transport.readFileBoardBinding &&
    transport.revokeFileBoard &&
    transport.readWorkspaceBoard &&
    transport.bindFileBoard
  ) {
    try {
      const { boards } = await transport.listWorkspaceBoards(abort);
      const boardIds = [...new Set(['default', ...boards.map((b) => b.resourceId).filter(Boolean)])];
      for (const boardId of boardIds) {
        try {
          const current = await transport.readFileBoardBinding(boardId, abort);
          if (
            current.enabled &&
            current.binding &&
            current.binding.state !== 'revoked' &&
            current.binding.sessionId === fromSessionKey
          ) {
            await transport.revokeFileBoard(boardId, current.binding.bindingId, abort);
            const boardDoc = await transport.readWorkspaceBoard(boardId, abort);
            await transport.bindFileBoard(
              boardId,
              { requestId: makeId(), sessionId: toSessionKey, revision: boardDoc.revision },
              abort,
            );
            summary.migratedBoardIds.push(boardId);
          }
        } catch {
          // Continue checking remaining boards
        }
      }
    } catch {
      // Non-fatal
    }
  }

  // 5. Re-bind active Hub Notebook file-bindings from old session to new session
  if (
    transport.listHubNotebooks &&
    transport.readFileCardBinding &&
    transport.revokeFileCard &&
    transport.readFileCard &&
    transport.bindFileCard
  ) {
    try {
      const noteIds = new Set<string>(['default']);
      let after: string | undefined;
      let pages = 0;
      do {
        const page = await transport.listHubNotebooks(after);
        for (const item of page.items) {
          const parsedId = parseHubNotebookIdFromResource(item.resourceId);
          if (parsedId) noteIds.add(parsedId);
        }
        after = page.nextCursor ?? undefined;
        pages += 1;
      } while (after && pages < 5);

      for (const noteId of noteIds) {
        const cardResource = workspaceFileCardResource('notebook', `hub:${noteId}`);
        try {
          const current = await transport.readFileCardBinding(cardResource, abort);
          if (
            current.enabled &&
            current.binding &&
            current.binding.state !== 'revoked' &&
            current.binding.sessionId === fromSessionKey
          ) {
            await transport.revokeFileCard(cardResource, current.binding.bindingId, abort);
            const cardDoc = await transport.readFileCard(cardResource, abort);
            await transport.bindFileCard(
              cardResource,
              { requestId: makeId(), sessionId: toSessionKey, revision: cardDoc.revision },
              abort,
            );
            summary.migratedHubNotebookIds.push(noteId);
          }
        } catch {
          // Continue checking remaining notebooks
        }
      }
    } catch {
      // Non-fatal
    }
  }

  return summary;
}

/**
 * Updates workspace layout panes when handing off from `fromSessionKey` to `toSessionKey`:
 * 1. Appends `toSessionKey` to any pane `fileLinks` that referenced `fromSessionKey` (preserving multi-session co-bindings & file browser links).
 * 2. If `replaceSourcePane` is true and `fromSessionKey` has an open session pane (and `toSessionKey` does not yet have one),
 *    replaces the pane's `sessionKey` in-place so exact dock/floating geometry is preserved!
 */
export function applyHandoffToCollapsedKeys(
  collapsed: ReadonlySet<string>,
  fromSessionKey: string,
  toSessionKey: string,
  nextWorkspace?: SessionWorkspace,
): Set<string> {
  if (!fromSessionKey || !toSessionKey || fromSessionKey === toSessionKey) {
    return new Set(collapsed);
  }
  const next = new Set(collapsed);
  next.delete(toSessionKey);
  const oldNoteKey = `\u0000notebook:${JSON.stringify(['session', fromSessionKey])}`;
  const newNoteKey = `\u0000notebook:${JSON.stringify(['session', toSessionKey])}`;
  if (next.has(oldNoteKey)) {
    next.delete(oldNoteKey);
    next.add(newNoteKey);
  }
  if (nextWorkspace) {
    const validKeys = new Set(nextWorkspace.panes.map(paneKey));
    if (!validKeys.has(fromSessionKey)) {
      next.delete(fromSessionKey);
    }
    return new Set([...next].filter((k) => validKeys.has(k)));
  }
  return next;
}

export function applyHandoffToWorkspaceLayout(
  layout: SessionWorkspace,
  fromSessionKey: string,
  toSessionKey: string,
  replaceSourcePane = true,
): SessionWorkspace {
  if (!fromSessionKey || !toSessionKey || fromSessionKey === toSessionKey) return layout;
  const targetAlreadyOpen = layout.panes.some((p) => isSessionPane(p) && p.sessionKey === toSessionKey);
  const targetSessionNoteAlreadyOpen = layout.panes.some(
    (p) => !isSessionPane(p) && p.kind === 'notebook' && p.target === 'session' && p.resourceId === toSessionKey,
  );
  let changed = false;

  const nextPanes: Pane[] = layout.panes.map((pane) => {
    let updated: Pane = pane;

    // Swap per-session notebook pane in-place when handing off (the notebook text was already copied)
    if (
      replaceSourcePane &&
      !targetSessionNoteAlreadyOpen &&
      !isSessionPane(updated) &&
      updated.kind === 'notebook' &&
      updated.target === 'session' &&
      updated.resourceId === fromSessionKey &&
      validPane({ ...updated, resourceId: toSessionKey })
    ) {
      const existingLinks = updated.fileLinks ?? [];
      const nextLinks = existingLinks.includes(fromSessionKey)
        ? [...new Set([...existingLinks.filter((k) => k !== fromSessionKey), toSessionKey])].slice(0, 32)
        : existingLinks;
      updated = {
        ...updated,
        resourceId: toSessionKey,
        ...(nextLinks.length ? { fileLinks: nextLinks } : {}),
      };
      changed = true;
    }

    // Preserve multi-session co-bindings on notebooks, taskboards, statuscards, file-browsers, etc.
    const primaryTarget = paneSessionKey(updated);
    const hasLink = Boolean(updated.fileLinks?.includes(fromSessionKey)) || primaryTarget === fromSessionKey;
    if (hasLink && !isSessionPane(updated)) {
      const existingLinks = updated.fileLinks ?? [];
      if (!existingLinks.includes(toSessionKey)) {
        // For file-browser, replace the old session link so the browser tracks the new active continuation session
        const nextLinks = updated.kind === 'file-browser'
          ? [...existingLinks.filter((k) => k !== fromSessionKey), toSessionKey].slice(-32)
          : [...new Set([...existingLinks, toSessionKey])].slice(0, 32);
        updated = { ...updated, fileLinks: nextLinks };
        changed = true;
      }
    }

    // In-place session pane swap preserves exact dock split or floating window slot
    if (
      replaceSourcePane &&
      !targetAlreadyOpen &&
      isSessionPane(updated) &&
      updated.sessionKey === fromSessionKey &&
      validPane({ id: updated.id, sessionKey: toSessionKey })
    ) {
      const transferredLinks = updated.fileLinks ? [...updated.fileLinks] : undefined;
      updated = {
        id: updated.id,
        sessionKey: toSessionKey,
        ...(transferredLinks?.length ? { fileLinks: transferredLinks } : {}),
        ...(updated.dockSize ? { dockSize: updated.dockSize } : {}),
        ...(updated.dockFrame ? { dockFrame: updated.dockFrame } : {}),
      };
      changed = true;
    } else if (isSessionPane(updated) && updated.sessionKey === toSessionKey) {
      const srcPane = layout.panes.find((p) => isSessionPane(p) && p.sessionKey === fromSessionKey);
      if (srcPane?.fileLinks?.length) {
        const merged = [...new Set([...(updated.fileLinks ?? []), ...srcPane.fileLinks])].slice(0, 32);
        if (merged.length !== (updated.fileLinks?.length ?? 0)) {
          updated = { ...updated, fileLinks: merged };
          changed = true;
        }
      }
    }

    return updated;
  });

  if (!changed) {
    const targetPane = layout.panes.find((p) => paneKey(p) === toSessionKey);
    if (targetPane && layout.active !== targetPane.id) {
      return { ...layout, active: targetPane.id };
    }
    return layout;
  }

  const activePane = nextPanes.find((p) => isSessionPane(p) && p.sessionKey === toSessionKey);
  const candidate: SessionWorkspace = {
    ...layout,
    panes: nextPanes,
    ...(activePane ? { active: activePane.id } : {}),
  };
  return validWorkspace(candidate) ? candidate : layout;
}

export function applyHandoffToSavedLayouts(
  items: readonly SavedLayout[],
  fromSessionKey: string,
  toSessionKey: string,
  replaceSourcePane = true,
): { items: SavedLayout[]; changedIds: string[] } {
  if (!fromSessionKey || !toSessionKey || fromSessionKey === toSessionKey || items.length === 0) {
    return { items: [...items], changedIds: [] };
  }
  const changedIds: string[] = [];
  const nextItems = items.map((item) => {
    const nextWorkspace = applyHandoffToWorkspaceLayout(
      item.workspace,
      fromSessionKey,
      toSessionKey,
      replaceSourcePane,
    );
    const nextCollapsed = [
      ...applyHandoffToCollapsedKeys(
        new Set(item.collapsedKeys),
        fromSessionKey,
        toSessionKey,
        nextWorkspace,
      ),
    ];
    const collapsedChanged =
      nextCollapsed.length !== item.collapsedKeys.length ||
      nextCollapsed.some((k, idx) => k !== item.collapsedKeys[idx]);
    if (nextWorkspace === item.workspace && !collapsedChanged) {
      return item;
    }
    changedIds.push(item.id);
    return {
      ...item,
      workspace: structuredClone(nextWorkspace),
      collapsedKeys: nextCollapsed,
    };
  });
  return { items: nextItems, changedIds };
}

export type PersistedHandoffLayoutMigrationResult = {
  savedChangedIds: string[];
  savedSerialized: string | null;
  currentSerialized: string | null;
  osDesktopUpdated: boolean;
};

/**
 * Synchronously migrates all browser-persisted layouts (Named Saved Layouts,
 * Classic Current Layout, and OS Desktop Dedicated Layout) for `scope` when a
 * session handoff occurs — even if `<SavedLayouts>` or `<SessionWorkspaceView>`
 * is currently unmounted (e.g. mobile / single-session view or inactive UI mode).
 */
export function migratePersistedLayoutsForHandoff(params: {
  scope: string | undefined;
  fromSessionKey: string;
  toSessionKey: string;
  replaceSourcePane?: boolean | undefined;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | undefined;
}): PersistedHandoffLayoutMigrationResult {
  const {
    scope,
    fromSessionKey,
    toSessionKey,
    replaceSourcePane = true,
    storage = typeof localStorage !== 'undefined' ? localStorage : undefined,
  } = params;
  const emptyResult: PersistedHandoffLayoutMigrationResult = {
    savedChangedIds: [],
    savedSerialized: null,
    currentSerialized: null,
    osDesktopUpdated: false,
  };
  if (!scope || !storage || !fromSessionKey || !toSessionKey || fromSessionKey === toSessionKey) {
    return emptyResult;
  }

  let savedChangedIds: string[] = [];
  let savedSerialized: string | null = null;
  const sKey = savedLayoutKey(scope);
  if (sKey) {
    try {
      const raw = storage.getItem(sKey) ?? storage.getItem(legacySavedLayoutKey(scope)!);
      const parsed = parseSavedLayouts(raw);
      const migrated = applyHandoffToSavedLayouts(parsed, fromSessionKey, toSessionKey, replaceSourcePane);
      if (migrated.changedIds.length > 0) {
        savedChangedIds = migrated.changedIds;
        savedSerialized = JSON.stringify(migrated.items);
        storage.setItem(sKey, savedSerialized);
        checkpointPendingLayoutSync(storage, scope, 'saved', savedSerialized);
      }
    } catch {
      // Ignore storage failures
    }
  }

  let currentSerialized: string | null = null;
  const cKey = currentLayoutKey(scope);
  if (cKey) {
    try {
      const raw = storage.getItem(cKey) ?? storage.getItem(legacyCurrentLayoutKey(scope)!);
      const parsed = parseCurrentLayout(raw);
      if (parsed) {
        const nextWs = applyHandoffToWorkspaceLayout(parsed.workspace, fromSessionKey, toSessionKey, replaceSourcePane);
        const nextCollapsed = applyHandoffToCollapsedKeys(new Set(parsed.collapsedKeys), fromSessionKey, toSessionKey, nextWs);
        const nextSnap = JSON.stringify(layoutSnapshot(nextWs, nextCollapsed));
        if (nextSnap !== JSON.stringify(parsed)) {
          currentSerialized = nextSnap;
          storage.setItem(cKey, nextSnap);
          checkpointPendingLayoutSync(storage, scope, 'current', nextSnap);
        }
      }
    } catch {
      // Ignore storage failures
    }
  }

  let osDesktopUpdated = false;
  const osKey = osDesktopLayoutKey(scope);
  if (osKey) {
    try {
      const raw = storage.getItem(osKey);
      const parsed = parseCurrentLayout(raw);
      if (parsed) {
        const nextWs = applyHandoffToWorkspaceLayout(parsed.workspace, fromSessionKey, toSessionKey, replaceSourcePane);
        const nextCollapsed = applyHandoffToCollapsedKeys(new Set(parsed.collapsedKeys), fromSessionKey, toSessionKey, nextWs);
        const nextSnap = JSON.stringify(layoutSnapshot(nextWs, nextCollapsed));
        if (nextSnap !== JSON.stringify(parsed)) {
          storage.setItem(osKey, nextSnap);
          osDesktopUpdated = true;
        }
      }
    } catch {
      // Ignore storage failures
    }
  }

  return { savedChangedIds, savedSerialized, currentSerialized, osDesktopUpdated };
}

function checkpointPendingLayoutSync(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  scope: string,
  kind: 'saved' | 'current',
  snapshot: string,
): void {
  const pendingKey = `agentopsdeck:layout-sync-pending:${scope}:${kind}`;
  try {
    const existingRaw = storage.getItem(pendingKey);
    if (existingRaw) {
      const existing = JSON.parse(existingRaw);
      if (
        existing &&
        Number.isSafeInteger(existing.revision) &&
        existing.revision >= 0 &&
        (existing.content === null || typeof existing.content === 'string')
      ) {
        storage.setItem(
          pendingKey,
          JSON.stringify({ revision: existing.revision, content: existing.content, snapshot }),
        );
        return;
      }
    }
    storage.setItem(pendingKey, JSON.stringify(null));
  } catch {
    // Best-effort checkpoint
  }
}

export async function pushMigratedLayoutsToCloud(params: {
  scope: string | undefined;
  isCurrentScope: () => boolean;
  savedSerialized: string | null;
  currentSerialized: string | null;
  loadLayout: (kind: 'current' | 'saved', signal: AbortSignal) => Promise<{ revision: number; content: string | null }>;
  saveLayout: (
    kind: 'current' | 'saved',
    value: { revision: number; content: string },
    signal: AbortSignal,
  ) => Promise<{ revision: number; content: string | null }>;
  fromSessionKey: string;
  toSessionKey: string;
  replaceSourcePane?: boolean | undefined;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined;
}): Promise<void> {
  const {
    scope,
    isCurrentScope,
    savedSerialized,
    currentSerialized,
    loadLayout,
    saveLayout,
    fromSessionKey,
    toSessionKey,
    replaceSourcePane = true,
    storage = typeof localStorage !== 'undefined' ? localStorage : undefined,
  } = params;
  if (!scope || !isCurrentScope()) return;

  const pushKind = async (kind: 'saved' | 'current', fallbackContent: string | null) => {
    if (!fallbackContent || !isCurrentScope()) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    try {
      const remote = await loadLayout(kind, ctrl.signal);
      if (!isCurrentScope()) return;
      let contentToSave = fallbackContent;
      if (kind === 'saved' && remote.content) {
        const remoteItems = parseSavedLayouts(remote.content);
        const migratedRemote = applyHandoffToSavedLayouts(
          remoteItems,
          fromSessionKey,
          toSessionKey,
          replaceSourcePane,
        );
        const localItems = parseSavedLayouts(fallbackContent);
        if (localItems.length === 0 && migratedRemote.items.length > 0) {
          contentToSave = JSON.stringify(migratedRemote.items);
        } else if (migratedRemote.items.length > 0) {
          const byId = new Map(localItems.map((item) => [item.id, item]));
          for (const rItem of migratedRemote.items) {
            if (!byId.has(rItem.id)) byId.set(rItem.id, rItem);
          }
          if (byId.size !== localItems.length) {
            contentToSave = JSON.stringify([...byId.values()].slice(0, 50));
          }
        }
      }
      if (remote.content === contentToSave) {
        if (storage) {
          try { storage.removeItem(`agentopsdeck:layout-sync-pending:${scope}:${kind}`); } catch { /* ignore */ }
        }
        return;
      }
      await saveLayout(kind, { revision: remote.revision, content: contentToSave }, ctrl.signal);
      if (isCurrentScope() && storage) {
        try { storage.removeItem(`agentopsdeck:layout-sync-pending:${scope}:${kind}`); } catch { /* ignore */ }
      }
    } catch {
      // Keep localStorage pending checkpoint so LayoutSync retries automatically when online/mounted
    } finally {
      clearTimeout(timer);
    }
  };

  await Promise.allSettled([
    pushKind('saved', savedSerialized),
    pushKind('current', currentSerialized),
  ]);
}
