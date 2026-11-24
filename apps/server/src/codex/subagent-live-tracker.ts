import type { ChatMessage, CodexSubagentObservation, CodexSubagentStep } from '@agentopsdeck/shared';

const MAX_CHILD_THREADS = 128;
const MAX_ANCHORS_PER_CHILD = 8;
const MAX_STEPS_PER_CHILD = 12;
const MAX_TEXT_CHARS = 1200;
const MAX_DETAIL_CHARS = 240;
const MAX_TITLE_CHARS = 160;
const DELTA_FLUSH_MS = 120;

type AgentStatus = CodexSubagentObservation['agents'][number]['status'];
type TurnStatus = NonNullable<CodexSubagentObservation['agents'][number]['turnStatus']>;

type AnchorRef = {
  parentSessionKey: string;
  turnId?: string;
  messageId: string;
};

type TrackedChild = {
  childId: string;
  parentSessionKey: string;
  anchors: AnchorRef[];
  turnStatus?: TurnStatus | undefined;
  liveStatus?: AgentStatus | undefined;
  currentStep?: string | undefined;
  latestText?: string | undefined;
  steps: CodexSubagentStep[];
  itemOutputs: Map<string, string>;
  itemAssistants: Map<string, string>;
  hasTelemetry: boolean;
  lastUpdatedAt: number;
  flushTimer?: ReturnType<typeof setTimeout> | undefined;
};

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const stringValue = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function clipHead(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(1, max - 1))}…`;
}

function clipTail(value: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-(max - 1))}`;
}

function formatChildItemStep(item: Record<string, unknown>): {
  kind: CodexSubagentStep['kind'];
  title: string;
  detail?: string;
} | undefined {
  const type = stringValue(item.type);
  if (!type) return undefined;
  if (type === 'commandExecution') {
    const rawCmd = Array.isArray(item.command)
      ? item.command.filter((part): part is string => typeof part === 'string').join(' ')
      : stringValue(item.command) ?? stringValue(item.parsedCmd) ?? 'command';
    const output = stringValue(item.aggregatedOutput ?? item.output);
    return {
      kind: 'tool',
      title: clipHead(`$ ${rawCmd}`, MAX_TITLE_CHARS),
      ...(output ? { detail: clipTail(output, MAX_DETAIL_CHARS) } : {}),
    };
  }
  if (type === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const paths = changes
      .map((entry) => (record(entry) ? stringValue(entry.path) : undefined))
      .filter((p): p is string => !!p);
    const label = paths.length
      ? `Edit ${paths.slice(0, 2).join(', ')}${paths.length > 2 ? ` +${paths.length - 2}` : ''}`
      : 'Edit files';
    return { kind: 'tool', title: clipHead(label, MAX_TITLE_CHARS) };
  }
  if (type === 'mcpToolCall' || type === 'dynamicToolCall') {
    const prefix = stringValue(item.server ?? item.namespace);
    const tool = stringValue(item.tool) ?? type;
    const label = [prefix, tool].filter(Boolean).join('/');
    return { kind: 'tool', title: clipHead(label, MAX_TITLE_CHARS) };
  }
  if (type === 'webSearch') {
    const query = stringValue(item.query);
    return {
      kind: 'tool',
      title: clipHead(query ? `Search: ${query}` : 'Web search', MAX_TITLE_CHARS),
    };
  }
  if (type === 'collabAgentToolCall' || type === 'collabToolCall') {
    const tool = stringValue(item.tool) ?? 'subagent';
    return { kind: 'tool', title: clipHead(`Sub-agent: ${tool}`, MAX_TITLE_CHARS) };
  }
  if (type === 'agentMessage') {
    const text = stringValue(item.text ?? item.message);
    return {
      kind: 'assistant',
      title: 'Assistant response',
      ...(text ? { detail: clipTail(text, MAX_DETAIL_CHARS) } : {}),
    };
  }
  if (type === 'reasoning') {
    const summary = Array.isArray(item.summary)
      ? item.summary.filter((s): s is string => typeof s === 'string').join(' ')
      : stringValue(item.summary ?? item.text);
    return {
      kind: 'reasoning',
      title: 'Thinking',
      ...(summary ? { detail: clipTail(summary, MAX_DETAIL_CHARS) } : {}),
    };
  }
  if (type === 'imageView' || type === 'imageGeneration') {
    return { kind: 'tool', title: type === 'imageView' ? 'View image' : 'Generate image' };
  }
  return undefined;
}

function itemFailed(item: Record<string, unknown>): boolean {
  const status = stringValue(item.status);
  if (status === 'failed' || status === 'declined' || status === 'errored') return true;
  if (typeof item.exitCode === 'number' && item.exitCode !== 0) return true;
  if (item.error) return true;
  return false;
}

export type SubagentTrackerFlushHandler = (
  parentSessionKey: string,
  anchorMessageId: string,
  childId: string,
  now: number,
) => void;

/**
 * Bounded display-only tracker for native Codex child thread notifications.
 * Never issues RPCs, mutates execution state, or alters settlement fences.
 */
export class CodexSubagentLiveTracker {
  private readonly children = new Map<string, TrackedChild>();

  constructor(private readonly onFlush?: SubagentTrackerFlushHandler) {}

  hasChild(childThreadId: string): boolean {
    return this.children.has(childThreadId);
  }

  registerParentObservation(
    parentSessionKey: string,
    turnId: string | undefined,
    anchorMessageId: string,
    observation: CodexSubagentObservation | undefined,
  ): CodexSubagentObservation | undefined {
    if (!observation || !observation.agents.length) return observation;
    const now = observation.observedAt ?? Date.now();
    for (const agent of observation.agents) {
      if (!agent.id) continue;
      let tracked = this.children.get(agent.id);
      if (!tracked) {
        this.evictIfNeeded();
        tracked = {
          childId: agent.id,
          parentSessionKey,
          anchors: [],
          steps: [],
          itemOutputs: new Map(),
          itemAssistants: new Map(),
          hasTelemetry: false,
          lastUpdatedAt: now,
        };
      } else {
        this.children.delete(agent.id);
        tracked.parentSessionKey = parentSessionKey;
      }
      this.children.set(agent.id, tracked);
      const existingIdx = tracked.anchors.findIndex((a) => a.messageId === anchorMessageId);
      const ref: AnchorRef = { parentSessionKey, ...(turnId ? { turnId } : {}), messageId: anchorMessageId };
      if (existingIdx >= 0) tracked.anchors[existingIdx] = ref;
      else {
        tracked.anchors.push(ref);
        if (tracked.anchors.length > MAX_ANCHORS_PER_CHILD) {
          tracked.anchors.splice(0, tracked.anchors.length - MAX_ANCHORS_PER_CHILD);
        }
      }
    }
    return this.applyToObservation(parentSessionKey, observation);
  }

  applyToObservation(
    parentSessionKey: string,
    observation: CodexSubagentObservation,
  ): CodexSubagentObservation;
  applyToObservation(
    parentSessionKey: string,
    observation: CodexSubagentObservation | undefined,
  ): CodexSubagentObservation | undefined;
  applyToObservation(
    parentSessionKey: string,
    observation: CodexSubagentObservation | undefined,
  ): CodexSubagentObservation | undefined {
    if (!observation || !observation.agents.length) return observation;
    let changed = false;
    const agents = observation.agents.map((agent) => {
      const tracked = this.children.get(agent.id);
      if (!tracked || tracked.parentSessionKey !== parentSessionKey || !tracked.hasTelemetry) {
        return agent;
      }
      changed = true;
      const mergedStatus =
        (agent.status === 'unknown' || agent.status === 'pendingInit') && tracked.liveStatus
          ? tracked.liveStatus
          : agent.status === 'running' &&
              tracked.liveStatus &&
              ['completed', 'errored', 'interrupted'].includes(tracked.liveStatus)
            ? tracked.liveStatus
            : agent.status;
      return {
        ...agent,
        status: mergedStatus,
        ...(tracked.currentStep ? { currentStep: tracked.currentStep } : {}),
        ...(tracked.latestText ? { latestText: tracked.latestText } : {}),
        ...(tracked.turnStatus ? { turnStatus: tracked.turnStatus } : {}),
        ...(tracked.steps.length ? { steps: tracked.steps.map((step) => ({ ...step })) } : {}),
      };
    });
    return changed ? { ...observation, agents } : observation;
  }

  enrichMessages(sessionKey: string, messages: ChatMessage[]): ChatMessage[] {
    let anyChanged = false;
    const next = messages.map((msg) => {
      if (!msg.codexSubagent) return msg;
      const enriched = this.applyToObservation(sessionKey, msg.codexSubagent);
      if (enriched === msg.codexSubagent) return msg;
      anyChanged = true;
      return { ...msg, codexSubagent: enriched };
    });
    return anyChanged ? next : messages;
  }

  observeChildNotification(childThreadId: string, method: string, params: unknown, now = Date.now()): boolean {
    const tracked = this.children.get(childThreadId);
    if (!tracked || !record(params)) return false;

    let immediate = false;
    let updated = false;

    if (method === 'turn/started') {
      tracked.turnStatus = 'running';
      tracked.liveStatus = 'running';
      tracked.currentStep ||= 'Starting turn…';
      tracked.hasTelemetry = true;
      immediate = true;
      updated = true;
    } else if (method === 'turn/completed') {
      const turn = record(params.turn) ? params.turn : undefined;
      const rawStatus = stringValue(turn?.status);
      if (rawStatus === 'failed') {
        tracked.turnStatus = 'failed';
        tracked.liveStatus = 'errored';
        tracked.currentStep = 'Turn failed';
      } else if (rawStatus === 'interrupted') {
        tracked.turnStatus = 'interrupted';
        tracked.liveStatus = 'interrupted';
        tracked.currentStep = 'Turn interrupted';
      } else {
        tracked.turnStatus = 'completed';
        tracked.liveStatus = 'completed';
        tracked.currentStep = undefined;
      }
      for (const step of tracked.steps) {
        if (step.status === 'running') {
          step.status = tracked.turnStatus === 'failed' ? 'error' : 'done';
          step.updatedAt = now;
        }
      }
      tracked.itemOutputs.clear();
      tracked.itemAssistants.clear();
      tracked.hasTelemetry = true;
      immediate = true;
      updated = true;
    } else if (method === 'item/started') {
      const item = record(params.item) ? params.item : undefined;
      const itemId = stringValue(item?.id ?? params.itemId);
      const formatted = item ? formatChildItemStep(item) : undefined;
      if (item && itemId && formatted) {
        tracked.turnStatus = 'running';
        tracked.liveStatus = 'running';
        tracked.currentStep = formatted.title;
        this.upsertStep(tracked, {
          id: itemId,
          kind: formatted.kind,
          title: formatted.title,
          ...(formatted.detail ? { detail: formatted.detail } : {}),
          status: 'running',
          updatedAt: now,
        });
        tracked.hasTelemetry = true;
        immediate = true;
        updated = true;
      }
    } else if (method === 'item/completed') {
      const item = record(params.item) ? params.item : undefined;
      const itemId = stringValue(item?.id ?? params.itemId);
      const formatted = item ? formatChildItemStep(item) : undefined;
      if (item && itemId && formatted) {
        const failed = itemFailed(item);
        const bufferedOutput = tracked.itemOutputs.get(itemId);
        const bufferedAssistant = tracked.itemAssistants.get(itemId);
        tracked.itemOutputs.delete(itemId);
        tracked.itemAssistants.delete(itemId);
        if (item.type === 'agentMessage') {
          const finalText = stringValue(item.text ?? item.message) ?? bufferedAssistant;
          if (finalText) tracked.latestText = clipTail(finalText, MAX_TEXT_CHARS);
        }
        const detail =
          formatted.detail ??
          (bufferedOutput ? clipTail(bufferedOutput, MAX_DETAIL_CHARS) : undefined) ??
          (bufferedAssistant ? clipTail(bufferedAssistant, MAX_DETAIL_CHARS) : undefined);
        this.upsertStep(tracked, {
          id: itemId,
          kind: formatted.kind,
          title: formatted.title,
          ...(detail ? { detail } : {}),
          status: failed ? 'error' : 'done',
          updatedAt: now,
        });
        const runningStep = [...tracked.steps].reverse().find((s) => s.status === 'running');
        tracked.currentStep = runningStep?.title;
        tracked.hasTelemetry = true;
        immediate = true;
        updated = true;
      }
    } else if (method === 'item/agentMessage/delta') {
      const itemId = stringValue(params.itemId ?? (record(params.item) ? params.item.id : undefined));
      const delta = typeof params.delta === 'string' ? params.delta : typeof params.text === 'string' ? params.text : '';
      if (itemId && delta) {
        const merged = clipTail((tracked.itemAssistants.get(itemId) ?? '') + delta, MAX_TEXT_CHARS);
        tracked.itemAssistants.set(itemId, merged);
        tracked.latestText = merged;
        tracked.turnStatus = 'running';
        tracked.liveStatus = 'running';
        tracked.currentStep = 'Writing response…';
        this.upsertStep(tracked, {
          id: itemId,
          kind: 'assistant',
          title: 'Writing response…',
          detail: clipTail(merged, MAX_DETAIL_CHARS),
          status: 'running',
          updatedAt: now,
        });
        tracked.hasTelemetry = true;
        updated = true;
      }
    } else if (method === 'item/commandExecution/outputDelta' || method === 'item/mcpToolCall/progress') {
      const itemId = stringValue(params.itemId ?? (record(params.item) ? params.item.id : undefined));
      const delta = stringValue(params.delta ?? params.message) ?? '';
      if (itemId && delta) {
        const merged = clipTail((tracked.itemOutputs.get(itemId) ?? '') + delta, MAX_DETAIL_CHARS * 2);
        tracked.itemOutputs.set(itemId, merged);
        const existing = tracked.steps.find((s) => s.id === itemId);
        const title = existing?.title ?? (method === 'item/mcpToolCall/progress' ? 'Tool progress' : 'Running command');
        tracked.turnStatus = 'running';
        tracked.liveStatus = 'running';
        tracked.currentStep = title;
        this.upsertStep(tracked, {
          id: itemId,
          kind: 'tool',
          title,
          detail: clipTail(merged, MAX_DETAIL_CHARS),
          status: 'running',
          updatedAt: now,
        });
        tracked.hasTelemetry = true;
        updated = true;
      }
    } else if (method === 'item/reasoning/summaryTextDelta') {
      const itemId = stringValue(params.itemId ?? (record(params.item) ? params.item.id : undefined)) ?? 'reasoning';
      const delta = typeof params.delta === 'string' ? params.delta : '';
      if (delta) {
        const merged = clipTail((tracked.itemOutputs.get(itemId) ?? '') + delta, MAX_DETAIL_CHARS);
        tracked.itemOutputs.set(itemId, merged);
        tracked.turnStatus = 'running';
        tracked.liveStatus = 'running';
        tracked.currentStep = 'Thinking…';
        this.upsertStep(tracked, {
          id: itemId,
          kind: 'reasoning',
          title: 'Thinking',
          detail: merged,
          status: 'running',
          updatedAt: now,
        });
        tracked.hasTelemetry = true;
        updated = true;
      }
    }

    if (!updated) return false;
    tracked.lastUpdatedAt = now;
    this.scheduleFlush(tracked, immediate, now);
    return true;
  }

  clearSession(parentSessionKey: string) {
    for (const [childId, tracked] of this.children) {
      if (tracked.parentSessionKey === parentSessionKey) {
        if (tracked.flushTimer) clearTimeout(tracked.flushTimer);
        this.children.delete(childId);
      }
    }
  }

  clearAll() {
    for (const tracked of this.children.values()) {
      if (tracked.flushTimer) clearTimeout(tracked.flushTimer);
    }
    this.children.clear();
  }

  private upsertStep(tracked: TrackedChild, step: CodexSubagentStep) {
    const idx = tracked.steps.findIndex((s) => s.id === step.id);
    if (idx >= 0) {
      tracked.steps[idx] = step;
      return;
    }
    tracked.steps.push(step);
    if (tracked.steps.length > MAX_STEPS_PER_CHILD) {
      tracked.steps.splice(0, tracked.steps.length - MAX_STEPS_PER_CHILD);
    }
  }

  private scheduleFlush(tracked: TrackedChild, immediate: boolean, now: number) {
    if (!this.onFlush) return;
    if (immediate) {
      if (tracked.flushTimer) {
        clearTimeout(tracked.flushTimer);
        tracked.flushTimer = undefined;
      }
      this.flushTracked(tracked, now);
      return;
    }
    if (tracked.flushTimer) return;
    tracked.flushTimer = setTimeout(() => {
      tracked.flushTimer = undefined;
      this.flushTracked(tracked, Date.now());
    }, DELTA_FLUSH_MS);
    tracked.flushTimer.unref?.();
  }

  private flushTracked(tracked: TrackedChild, now: number) {
    if (!this.onFlush) return;
    for (const anchor of tracked.anchors) {
      this.onFlush(anchor.parentSessionKey, anchor.messageId, tracked.childId, now);
    }
  }

  private evictIfNeeded() {
    while (this.children.size >= MAX_CHILD_THREADS) {
      const oldestKey = this.children.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.children.get(oldestKey);
      if (oldest?.flushTimer) clearTimeout(oldest.flushTimer);
      this.children.delete(oldestKey);
    }
  }
}
