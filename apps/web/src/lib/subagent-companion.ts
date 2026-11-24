import type { ChatMessage, CodexSubagentStep, SessionSummary } from '@agentopsdeck/shared';
import { formatSubagentLabel } from './codex-subagents.js';

export const OPEN_SUBAGENT_COMPANION_EVENT = 'agentopsdeck:open-subagent-companion';

export type OpenSubagentCompanionDetail = {
  sessionKey: string;
};

export function requestOpenSubagentCompanion(sessionKey: string): void {
  if (!sessionKey || typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<OpenSubagentCompanionDetail>(OPEN_SUBAGENT_COMPANION_EVENT, {
      detail: { sessionKey },
    }),
  );
}

export type SubagentRuntimeKind = 'codex' | 'ghcp';

export type SubagentChildStatus =
  | 'pendingInit'
  | 'running'
  | 'completed'
  | 'errored'
  | 'interrupted'
  | 'shutdown'
  | 'notFound'
  | 'unknown';

export type CompanionSubagentChild = {
  id: string;
  label: string;
  status: SubagentChildStatus;
  task?: string | undefined;
  currentStep?: string | undefined;
  latestText?: string | undefined;
  message?: string | undefined;
  steps: readonly CodexSubagentStep[];
  firstObservedAt?: number | undefined;
  lastObservedAt?: number | undefined;
  eventCount: number;
};

export type SessionSubagentCompanionState = {
  sessionKey: string;
  runtimeKind: SubagentRuntimeKind;
  waveId: string;
  active: boolean;
  current: boolean;
  waiting: boolean;
  waitObservedAt?: number | undefined;
  hasLiveDispatch: boolean;
  latestActivityAt: number;
  children: readonly CompanionSubagentChild[];
};

type DecodedGhcpScope = {
  sessionKey: string;
  agentId: string | null;
  parentToolCallId: string | null;
  role: string;
  identity: string;
};

const terminalStatuses = new Set<SubagentChildStatus>([
  'completed',
  'errored',
  'interrupted',
  'shutdown',
  'notFound',
]);

function extractNativeCodexThreadId(session: SessionSummary): string | undefined {
  const nativeKey = session.sessionRef?.nativeSessionKey;
  if (typeof nativeKey === 'string') {
    const idx = nativeKey.indexOf('codex:');
    if (idx >= 0 && nativeKey.length > idx + 6) return nativeKey.slice(idx + 6);
  }
  const idx = session.sessionKey.indexOf('codex:');
  if (idx >= 0 && session.sessionKey.length > idx + 6) return session.sessionKey.slice(idx + 6);
  return undefined;
}

function isSessionActive(session: SessionSummary, stale: boolean): { current: boolean; active: boolean } {
  const runtime = session.runtime;
  if (runtime) {
    const current = !stale && runtime.sync === 'current' && runtime.connection === 'connected';
    const active =
      (!stale && ['starting', 'running', 'waiting'].includes(runtime.phase ?? '')) ||
      session.status === 'running';
    return { current, active };
  }
  return { current: !stale, active: !stale && session.status === 'running' };
}

function decodeBase64UrlUtf8(encoded: string): string | undefined {
  try {
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    if (typeof globalThis.atob === 'function') {
      const binary = globalThis.atob(padded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    }
    const bufCtor = (globalThis as unknown as { Buffer?: { from(input: string, enc: string): { toString(enc: string): string } } }).Buffer;
    if (bufCtor) return bufCtor.from(encoded, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
  return undefined;
}

export function decodeGhcpMessageScope(id: string | undefined): DecodedGhcpScope | undefined {
  if (!id || !id.startsWith('ghcp-message:')) return undefined;
  const raw = decodeBase64UrlUtf8(id.slice('ghcp-message:'.length));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 5) return undefined;
    const [sessionKey, agentId, parentToolCallId, role, identity] = parsed;
    if (typeof sessionKey !== 'string' || typeof role !== 'string' || typeof identity !== 'string') return undefined;
    if (agentId !== null && typeof agentId !== 'string') return undefined;
    if (parentToolCallId !== null && typeof parentToolCallId !== 'string') return undefined;
    return { sessionKey, agentId, parentToolCallId, role, identity };
  } catch {
    return undefined;
  }
}

function clipText(value: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, Math.max(1, max - 1))}…`;
}

function resolveCodexCompanion(
  session: SessionSummary,
  messages: readonly ChatMessage[],
  stale: boolean,
): SessionSubagentCompanionState | undefined {
  const subagentRows = messages
    .filter((m) => m.role === 'tool' && !m.parentToolUseId && m.codexSubagent)
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || (a.toolPhase === 'result' ? 1 : 0) - (b.toolPhase === 'result' ? 1 : 0));

  if (!subagentRows.length) return undefined;

  const { current, active } = isSessionActive(session, stale);
  const activeTurnId = session.runtime?.turnId;

  let targetTurnId: string | undefined;
  if (activeTurnId && subagentRows.some((m) => m.turnId === activeTurnId)) {
    targetTurnId = activeTurnId;
  } else {
    for (let i = subagentRows.length - 1; i >= 0; i -= 1) {
      if (subagentRows[i]?.turnId) {
        targetTurnId = subagentRows[i]!.turnId;
        break;
      }
    }
  }

  const waveRows = targetTurnId ? subagentRows.filter((m) => m.turnId === targetTurnId) : subagentRows;
  if (!waveRows.length) return undefined;

  const isCurrentActiveWave = active && (!activeTurnId || targetTurnId === activeTurnId);
  const selfThreadId = extractNativeCodexThreadId(session);
  const finishedCalls = new Set(waveRows.filter((m) => m.toolPhase === 'result').map((m) => m.toolCallId));
  const children = new Map<string, CompanionSubagentChild>();

  let waiting = false;
  let waitObservedAt: number | undefined;
  let hasPendingSubagentCall = false;
  let latestActivityAt = 0;

  for (const m of waveRows) {
    const obs = m.codexSubagent!;
    const at =
      obs.source === 'live' && Number.isFinite(obs.observedAt) && obs.observedAt! >= 0
        ? obs.observedAt
        : m.updatedAt ?? m.createdAt;
    if (at && at > latestActivityAt) latestActivityAt = at;

    const callInFlight =
      isCurrentActiveWave &&
      m.toolPhase === 'call' &&
      m.status === 'sending' &&
      (!m.toolCallId || !finishedCalls.has(m.toolCallId));

    if (callInFlight) {
      hasPendingSubagentCall = true;
      if (obs.action === 'wait') {
        waiting = true;
        if (at !== undefined) waitObservedAt = waitObservedAt === undefined ? at : Math.min(waitObservedAt, at);
      }
    }

    for (const rawAgent of obs.agents.slice(0, 32)) {
      if (rawAgent.path?.trim() === '/root' || (selfThreadId && rawAgent.id === selfThreadId)) {
        continue;
      }
      const prev = children.get(rawAgent.id);
      if (!prev && children.size >= 32) continue;

      const rawStatus = rawAgent.status as SubagentChildStatus;
      const reset = prev && terminalStatuses.has(prev.status) && !terminalStatuses.has(rawStatus);
      const nextSteps =
        rawAgent.steps && rawAgent.steps.length > 0
          ? rawAgent.steps
          : reset
            ? []
            : (prev?.steps ?? []);
      const latestStepUpdate = nextSteps.reduce<number>(
        (max, s) => (s.updatedAt !== undefined && s.updatedAt > max ? s.updatedAt : max),
        0,
      );
      if (latestStepUpdate > latestActivityAt) latestActivityAt = latestStepUpdate;

      const effectiveStatus: SubagentChildStatus =
        rawStatus === 'unknown' && prev && prev.status !== 'unknown' ? prev.status : rawStatus;
      const label = formatSubagentLabel({ id: rawAgent.id, path: rawAgent.path ?? undefined });

      children.set(rawAgent.id, {
        id: rawAgent.id,
        label: prev && prev.label !== prev.id && label === rawAgent.id ? prev.label : label,
        status: effectiveStatus,
        task: obs.task ?? prev?.task,
        currentStep: rawAgent.currentStep ?? (terminalStatuses.has(effectiveStatus) ? undefined : prev?.currentStep),
        latestText: rawAgent.latestText ?? rawAgent.message ?? prev?.latestText,
        message: rawAgent.message ?? prev?.message,
        steps: nextSteps,
        firstObservedAt: at === undefined || reset ? at : (prev?.firstObservedAt ?? at),
        lastObservedAt: Math.max(at ?? 0, latestStepUpdate) || prev?.lastObservedAt,
        eventCount: reset ? 1 : (prev?.eventCount ?? 0) + 1,
      });
    }
  }

  const childList = [...children.values()];
  if (!childList.length && !waiting) return undefined;

  const anyChildActive = childList.some((c) => c.status === 'running' || c.status === 'pendingInit');
  const hasLiveDispatch = isCurrentActiveWave && (waiting || anyChildActive || hasPendingSubagentCall);
  const waveId = targetTurnId ?? waveRows[0]!.id;

  return {
    sessionKey: session.sessionKey,
    runtimeKind: 'codex',
    waveId: `codex:${waveId}`,
    active: isCurrentActiveWave,
    current,
    waiting,
    waitObservedAt,
    hasLiveDispatch,
    latestActivityAt: latestActivityAt || waveRows[waveRows.length - 1]!.createdAt,
    children: childList,
  };
}

function resolveGhcpCompanion(
  session: SessionSummary,
  messages: readonly ChatMessage[],
  stale: boolean,
): SessionSubagentCompanionState | undefined {
  const decodedRows: Array<{ msg: ChatMessage; scope?: DecodedGhcpScope | undefined }> = [];
  let hasChildMessages = false;

  for (const msg of messages) {
    const scope = decodeGhcpMessageScope(msg.id);
    if (scope?.parentToolCallId || msg.parentToolUseId) {
      hasChildMessages = true;
    }
    decodedRows.push({ msg, scope });
  }

  if (!hasChildMessages) return undefined;

  const { current, active } = isSessionActive(session, stale);
  const activeTurnId = session.runtime?.turnId;

  const childTurnIds: string[] = [];
  for (const { msg, scope } of decodedRows) {
    if ((scope?.parentToolCallId || msg.parentToolUseId) && msg.turnId) {
      childTurnIds.push(msg.turnId);
    }
  }
  const targetTurnId =
    activeTurnId && childTurnIds.includes(activeTurnId)
      ? activeTurnId
      : childTurnIds[childTurnIds.length - 1];

  const waveDecoded = targetTurnId
    ? decodedRows.filter(({ msg }) => !msg.turnId || msg.turnId === targetTurnId)
    : decodedRows;

  const rootToolByNativeId = new Map<
    string,
    { call?: ChatMessage | undefined; result?: ChatMessage | undefined }
  >();
  const rootToolByPublicId = new Map<
    string,
    { call?: ChatMessage | undefined; result?: ChatMessage | undefined; nativeId?: string | undefined }
  >();

  for (const { msg, scope } of waveDecoded) {
    if (msg.role !== 'tool' || scope?.parentToolCallId || msg.parentToolUseId) continue;
    const nativeId = scope?.identity;
    if (nativeId) {
      const entry = rootToolByNativeId.get(nativeId) ?? {};
      if (msg.toolPhase === 'result') entry.result = msg;
      else entry.call = msg;
      rootToolByNativeId.set(nativeId, entry);
    }
    if (msg.toolCallId) {
      const pubEntry = rootToolByPublicId.get(msg.toolCallId) ?? { nativeId };
      if (msg.toolPhase === 'result') pubEntry.result = msg;
      else pubEntry.call = msg;
      rootToolByPublicId.set(msg.toolCallId, pubEntry);
    }
  }

  type GhcpBuilder = {
    id: string;
    label: string;
    parentToolCallId?: string | undefined;
    parentToolUseId?: string | undefined;
    task?: string | undefined;
    steps: Map<string, CodexSubagentStep>;
    latestText?: string | undefined;
    currentStep?: string | undefined;
    firstObservedAt?: number | undefined;
    lastObservedAt?: number | undefined;
    eventCount: number;
    hasRunningChildStep: boolean;
  };

  const builders = new Map<string, GhcpBuilder>();
  let latestActivityAt = 0;

  const sortedWave = waveDecoded
    .filter(({ msg, scope }) => Boolean(scope?.parentToolCallId || msg.parentToolUseId))
    .sort(
      (a, b) =>
        a.msg.createdAt - b.msg.createdAt ||
        (a.msg.toolPhase === 'result' ? 1 : 0) - (b.msg.toolPhase === 'result' ? 1 : 0),
    );

  if (!sortedWave.length) return undefined;

  for (const { msg, scope } of sortedWave) {
    const parentCallNative = scope?.parentToolCallId ?? undefined;
    const agentKey = scope?.agentId ?? parentCallNative ?? msg.parentToolUseId!;
    let builder = builders.get(agentKey);
    if (!builder) {
      if (builders.size >= 32) continue;
      const cleanLabel = scope?.agentId
        ? scope.agentId
        : parentCallNative
          ? `subagent-${builders.size + 1}`
          : `subagent-${builders.size + 1}`;
      builder = {
        id: agentKey,
        label: cleanLabel,
        parentToolCallId: parentCallNative,
        parentToolUseId: msg.parentToolUseId,
        steps: new Map(),
        eventCount: 0,
        hasRunningChildStep: false,
      };
      builders.set(agentKey, builder);
    }

    const ts = msg.updatedAt ?? msg.createdAt;
    if (ts > latestActivityAt) latestActivityAt = ts;
    builder.firstObservedAt = builder.firstObservedAt === undefined ? msg.createdAt : Math.min(builder.firstObservedAt, msg.createdAt);
    builder.lastObservedAt = builder.lastObservedAt === undefined ? ts : Math.max(builder.lastObservedAt, ts);
    builder.eventCount += 1;

    if (msg.role === 'user' && msg.text.trim() && !builder.task) {
      builder.task = clipText(msg.text, 320);
    } else if (msg.role === 'tool') {
      const stepKey = msg.toolCallId ?? scope?.identity ?? msg.id;
      const prevStep = builder.steps.get(stepKey);
      const title = msg.toolName ?? prevStep?.title ?? (clipText(msg.text, 120) || 'Tool');
      const files = msg.sourceFiles?.map((f) => f.path).filter(Boolean) ?? [];
      const detail = files.length
        ? files.slice(0, 3).join(', ')
        : msg.text && msg.text !== title
          ? clipText(msg.text, 200)
          : prevStep?.detail;
      const isResult = msg.toolPhase === 'result';
      const failed = msg.status === 'failed';
      const status: CodexSubagentStep['status'] = failed ? 'error' : isResult ? 'done' : 'running';
      builder.steps.set(stepKey, {
        id: stepKey,
        kind: 'tool',
        title,
        ...(detail ? { detail } : {}),
        status,
        updatedAt: ts,
      });
    } else if (msg.role === 'assistant' && msg.text.trim()) {
      builder.latestText = clipText(msg.text, 1200);
      const stepKey = scope?.identity ?? msg.id;
      const isLiveStream = active && (!targetTurnId || targetTurnId === activeTurnId) && msg.status === 'sending';
      builder.steps.set(stepKey, {
        id: stepKey,
        kind: 'assistant',
        title: isLiveStream ? 'Writing response…' : 'Assistant response',
        detail: clipText(msg.text, 240),
        status: isLiveStream ? 'running' : 'done',
        updatedAt: ts,
      });
    }
  }

  const isCurrentActiveWave = active && (!activeTurnId || !targetTurnId || targetTurnId === activeTurnId);
  const children: CompanionSubagentChild[] = [];

  for (const builder of builders.values()) {
    const rootPair =
      (builder.parentToolCallId ? rootToolByNativeId.get(builder.parentToolCallId) : undefined) ??
      (builder.parentToolUseId ? rootToolByPublicId.get(builder.parentToolUseId) : undefined);

    if (!builder.task && rootPair?.call) {
      const callLabel = rootPair.call.toolPreview ?? rootPair.call.text ?? rootPair.call.toolName;
      if (callLabel && callLabel !== rootPair.call.toolName) {
        builder.task = clipText(callLabel, 320);
      } else if (rootPair.call.toolName) {
        builder.task = rootPair.call.toolName;
      }
    }

    const allSteps = [...builder.steps.values()].slice(-12);
    const runningStep = [...allSteps].reverse().find((s) => s.status === 'running');

    let status: SubagentChildStatus;
    if (rootPair?.result) {
      status = rootPair.result.status === 'failed' ? 'errored' : 'completed';
      for (let i = 0; i < allSteps.length; i += 1) {
        if (allSteps[i]!.status === 'running') {
          allSteps[i] = { ...allSteps[i]!, status: status === 'errored' ? 'error' : 'done' };
        }
      }
    } else if (isCurrentActiveWave) {
      status = 'running';
    } else {
      status = allSteps.some((s) => s.status === 'error') ? 'errored' : 'completed';
    }

    children.push({
      id: builder.id,
      label: builder.label,
      status,
      task: builder.task,
      currentStep: status === 'running' ? (runningStep?.title ?? 'Working…') : undefined,
      latestText: builder.latestText,
      steps: allSteps,
      firstObservedAt: rootPair?.call?.createdAt ?? builder.firstObservedAt,
      lastObservedAt: rootPair?.result?.createdAt ?? builder.lastObservedAt,
      eventCount: builder.eventCount,
    });
  }

  if (!children.length) return undefined;

  const anyRunning = children.some((c) => c.status === 'running' || c.status === 'pendingInit');
  const waveId = targetTurnId ?? children[0]!.id;

  return {
    sessionKey: session.sessionKey,
    runtimeKind: 'ghcp',
    waveId: `ghcp:${waveId}`,
    active: isCurrentActiveWave,
    current,
    waiting: isCurrentActiveWave && anyRunning,
    hasLiveDispatch: isCurrentActiveWave && anyRunning,
    latestActivityAt: latestActivityAt || sortedWave[sortedWave.length - 1]!.msg.createdAt,
    children,
  };
}

export function resolveSessionSubagentCompanion(
  session: SessionSummary | undefined,
  messages: readonly ChatMessage[],
  stale = false,
): SessionSubagentCompanionState | undefined {
  if (!session || !messages.length) return undefined;
  const codex = resolveCodexCompanion(session, messages, stale);
  if (codex) return codex;
  return resolveGhcpCompanion(session, messages, stale);
}
