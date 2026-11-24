/**
 * Moderator Mode Orchestrator (v2.4.1).
 * Formats speech batches with pre-configured prompt guidance, parses structured
 * directives from Moderator assistant responses, and coordinates updates to
 * Notebook, Taskboard, and Scout/Research Session.
 */

import type { BoardStatus, BoardTask } from '@agentopsdeck/shared';
import type { SttBatch } from './moderator-stt.js';

export interface ModeratorOrchestrationConfig {
  moderatorSessionKey: string;
  scoutSessionKey: string;
  notebookTarget: 'hub' | 'session';
  notebookId: string;
  taskboardId: string;
  systemPrompt: string;
  autoSyncNotebook: boolean;
  autoSyncTaskboard: boolean;
  autoDispatchScout: boolean;
}

export const DEFAULT_MODERATOR_PROMPT = `You are the Meeting Moderator Agent. For each speech transcript batch:
1. Summarize key decisions and discussion points for the live meeting notebook.
2. Extract actionable tasks for the taskboard.
3. Identify any background questions or lookups that the Scout Agent should investigate.

When applicable, emit structured blocks so the workspace can automatically sync:
[MODERATOR_NOTE]
## Meeting Update
- Key point or decision
[/MODERATOR_NOTE]

[MODERATOR_TASK status="todo" title="Action item title"]Optional detail[/MODERATOR_TASK]

[MODERATOR_SCOUT]Specific research query or verification task for the Scout session[/MODERATOR_SCOUT]`;

export interface ParsedModeratorTask {
  title: string;
  status: BoardStatus;
  detail?: string;
}

export interface ParsedModeratorActions {
  notes: string[];
  tasks: ParsedModeratorTask[];
  scoutQueries: string[];
}

/** Build the one-time Moderator Guidance initialization message sent when binding/creating the Moderator layout. */
export function buildModeratorGuidancePrimer(
  config: Pick<ModeratorOrchestrationConfig, 'systemPrompt' | 'notebookId' | 'taskboardId' | 'scoutSessionKey'>,
): string {
  const targets = [
    config.notebookId ? `Notebook: ${config.notebookId}` : null,
    config.taskboardId ? `Taskboard: ${config.taskboardId}` : null,
    config.scoutSessionKey ? `Scout Session: ${config.scoutSessionKey}` : null,
  ].filter(Boolean).join(' | ');
  return `[Moderator Guidance]\n${config.systemPrompt.trim()}${targets ? `\n\n(Bound Targets · ${targets})` : ''}\n\nAcknowledge briefly that Moderator Mode is initialized and standing by for incremental speech batches.`;
}

/**
 * Build the incremental speech payload sent to the Moderator session when an STT batch flushes.
 * By default (`includeSystemHeader = false`), only the incremental speech batch and target metadata
 * are sent, because the `[Moderator Guidance]` primer is sent once when the layout/binding is created.
 */
export function buildModeratorBatchPrompt(
  batch: Pick<SttBatch, 'text' | 'reason' | 'startedAtMs' | 'flushedAtMs'>,
  config: Pick<ModeratorOrchestrationConfig, 'systemPrompt' | 'notebookId' | 'taskboardId' | 'scoutSessionKey'>,
  includeSystemHeader = false,
): string {
  const timestamp = new Date(batch.flushedAtMs).toISOString();
  const header = includeSystemHeader && config.systemPrompt.trim()
    ? `[Moderator Guidance]\n${config.systemPrompt.trim()}\n\n`
    : '';
  const targets = [
    config.notebookId ? `Notebook: ${config.notebookId}` : null,
    config.taskboardId ? `Taskboard: ${config.taskboardId}` : null,
    config.scoutSessionKey ? `Scout Session: ${config.scoutSessionKey}` : null,
  ].filter(Boolean).join(' | ');
  return `${header}[Live STT Transcript · ${batch.reason} · ${timestamp}]${targets ? `\n(${targets})` : ''}\n${batch.text.trim()}`;
}

/** Check whether a session message snapshot already contains the Moderator Guidance header. */
export function shouldInjectModeratorGuidance(
  messages: ReadonlyArray<{ role?: string; text?: string }> | null | undefined,
  systemPrompt: string,
  alreadyInjectedInRuntime = false,
): boolean {
  const cleanPrompt = systemPrompt.trim();
  if (!cleanPrompt) return false;
  if (!messages || messages.length === 0) return !alreadyInjectedInRuntime;
  const recent = messages.slice(-40);
  for (const msg of recent) {
    if (!msg.text) continue;
    if (msg.text.includes('[Moderator Guidance]') || msg.text.includes(cleanPrompt.slice(0, 48))) {
      return false;
    }
  }
  return !alreadyInjectedInRuntime;
}

/** Parse structured Moderator directives from an assistant message. */
export function parseModeratorDirectives(messageText: string): ParsedModeratorActions {
  const notes: string[] = [];
  const tasks: ParsedModeratorTask[] = [];
  const scoutQueries: string[] = [];

  if (!messageText) return { notes, tasks, scoutQueries };

  const noteRegex = /\[MODERATOR_NOTE\]([\s\S]*?)\[\/MODERATOR_NOTE\]/gi;
  let match: RegExpExecArray | null;
  while ((match = noteRegex.exec(messageText)) !== null) {
    const content = match[1]?.trim();
    if (content) notes.push(content);
  }

  const taskRegex = /\[MODERATOR_TASK([^\]]*)\]([\s\S]*?)\[\/MODERATOR_TASK\]/gi;
  while ((match = taskRegex.exec(messageText)) !== null) {
    const attrs = match[1] ?? '';
    const body = match[2]?.trim() ?? '';
    const titleMatch = /title="([^"]+)"/i.exec(attrs);
    const statusMatch = /status="(todo|doing|done)"/i.exec(attrs);
    const title = (titleMatch?.[1] ?? body.split('\n')[0] ?? '').trim().slice(0, 160);
    if (!title) continue;
    const status = (statusMatch?.[1]?.toLowerCase() as BoardStatus | undefined) ?? 'todo';
    const detail = titleMatch ? body : body.split('\n').slice(1).join('\n').trim();
    tasks.push({ title, status, ...(detail ? { detail } : {}) });
  }

  const scoutRegex = /\[MODERATOR_SCOUT\]([\s\S]*?)\[\/MODERATOR_SCOUT\]/gi;
  while ((match = scoutRegex.exec(messageText)) !== null) {
    const query = match[1]?.trim();
    if (query) scoutQueries.push(query);
  }

  return { notes, tasks, scoutQueries };
}

/** Merge extracted Moderator tasks into an existing task list idempotently by title. */
export function mergeModeratorTasks(existing: BoardTask[], incoming: ParsedModeratorTask[]): { tasks: BoardTask[]; changed: boolean } {
  if (!incoming.length) return { tasks: existing, changed: false };
  const next = existing.map(task => ({ ...task }));
  let changed = false;

  for (const item of incoming) {
    const normalized = item.title.trim().toLocaleLowerCase();
    if (!normalized) continue;
    const found = next.find(t => t.title.trim().toLocaleLowerCase() === normalized);
    if (found) {
      if (found.status !== item.status || (item.detail && found.detail !== item.detail)) {
        found.status = item.status;
        if (item.detail) found.detail = item.detail;
        changed = true;
      }
    } else {
      if (next.length >= 200) break;
      next.push({
        id: `mod-task-${crypto.randomUUID()}`,
        title: item.title.trim().slice(0, 160),
        status: item.status,
        detail: (item.detail ?? '').slice(0, 4000),
      });
      changed = true;
    }
  }

  return { tasks: next, changed };
}

/** Append Moderator notes into a notebook markdown string without duplicating identical blocks. */
export function appendModeratorNotes(existingMarkdown: string, notes: string[]): { text: string; changed: boolean } {
  const additions = notes.map(n => n.trim()).filter(n => n && !existingMarkdown.includes(n));
  if (!additions.length) return { text: existingMarkdown, changed: false };
  const separator = existingMarkdown.trim().length > 0 ? '\n\n' : '';
  return {
    text: `${existingMarkdown.trimEnd()}${separator}${additions.join('\n\n')}\n`,
    changed: true,
  };
}

export const DEFAULT_MODERATOR_ORCHESTRATION_CONFIG: ModeratorOrchestrationConfig = {
  moderatorSessionKey: '',
  scoutSessionKey: '',
  notebookTarget: 'hub',
  notebookId: 'default',
  taskboardId: 'default',
  systemPrompt: DEFAULT_MODERATOR_PROMPT,
  autoSyncNotebook: true,
  autoSyncTaskboard: true,
  autoDispatchScout: true,
};

const ORCH_STORAGE_PREFIX = 'agentopsdeck.moderator-orchestrator:v1:';
export const MODERATOR_CONFIG_EVENT = 'agentopsdeck:moderator-config-updated';

export function loadModeratorOrchestrationConfig(scope: string): ModeratorOrchestrationConfig {
  try {
    const raw = localStorage.getItem(`${ORCH_STORAGE_PREFIX}${scope || 'default'}`);
    if (!raw) return { ...DEFAULT_MODERATOR_ORCHESTRATION_CONFIG };
    const parsed = JSON.parse(raw) as Partial<ModeratorOrchestrationConfig>;
    return {
      moderatorSessionKey: typeof parsed.moderatorSessionKey === 'string' ? parsed.moderatorSessionKey : '',
      scoutSessionKey: typeof parsed.scoutSessionKey === 'string' ? parsed.scoutSessionKey : '',
      notebookTarget: parsed.notebookTarget === 'session' ? 'session' : 'hub',
      notebookId: typeof parsed.notebookId === 'string' && parsed.notebookId ? parsed.notebookId : 'default',
      taskboardId: typeof parsed.taskboardId === 'string' && parsed.taskboardId ? parsed.taskboardId : 'default',
      systemPrompt: typeof parsed.systemPrompt === 'string' && parsed.systemPrompt.trim() ? parsed.systemPrompt : DEFAULT_MODERATOR_PROMPT,
      autoSyncNotebook: parsed.autoSyncNotebook !== false,
      autoSyncTaskboard: parsed.autoSyncTaskboard !== false,
      autoDispatchScout: parsed.autoDispatchScout !== false,
    };
  } catch {
    return { ...DEFAULT_MODERATOR_ORCHESTRATION_CONFIG };
  }
}

export function saveModeratorOrchestrationConfig(scope: string, config: ModeratorOrchestrationConfig): void {
  try {
    localStorage.setItem(`${ORCH_STORAGE_PREFIX}${scope || 'default'}`, JSON.stringify(config));
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent(MODERATOR_CONFIG_EVENT, { detail: { scope: scope || 'default', config } }));
    }
  } catch {
    // Ignore storage quota errors
  }
}
