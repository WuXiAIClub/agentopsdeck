import type { ChatMessage, DeckEvent, SessionSummary } from '@agentopsdeck/shared';
import { parseToolDetail } from './tool-detail-format.js';

// A remembered request/cache revision is not proof that these displayed items
// contain that snapshot (navigation, eviction and storage failure can drop it).
export function hasMessageSnapshotRevision(current: { sessionKey?: string; loadedLimit?: number | undefined; revision?: string | undefined },
  sessionKey: string, limit: number, revision: string | undefined) {
  return !!revision && current.sessionKey === sessionKey && current.loadedLimit === limit && current.revision === revision;
}

export function isSessionBusy(session: SessionSummary) {
  return session.runtime ? session.runtime.sync === 'error' || session.runtime.executionProtection?.state === 'blocked'
    || (!!session.runtime.threadActivity && session.runtime.threadActivity !== 'idle')
    || ['starting', 'running', 'waiting', 'finalizing', 'unknown'].includes(session.runtime.phase)
    : Boolean(session.hasActiveRun || ['running', 'waiting'].includes(session.structuredStatus?.displayStatus ?? session.status));
}

export function hasQueuedMessageControls(message: ChatMessage, activeRun: boolean) {
  return showsQueuedMessage(message, activeRun) && !!message.queueVersion;
}

export function showsQueuedMessage(message: ChatMessage, activeRun: boolean) {
  return message.role === 'user' && message.status === 'queued' && !message.queueObservation
    && (message.queueDisposition === 'waiting' || (message.queueDisposition === undefined && activeRun && !!message.queueVersion));
}

// Unlike conservative send/stop guards, a stale/unknown runtime or history
// synchronization failure alone is not evidence of a run blocking this send.
export function hasQueueBlockingRun(session: SessionSummary) {
  return session.runtime
    ? ['starting', 'running', 'waiting', 'finalizing'].includes(session.runtime.phase)
      || ['running', 'waiting'].includes(session.runtime.threadActivity ?? '')
    : Boolean(session.hasActiveRun || ['running', 'waiting'].includes(session.structuredStatus?.displayStatus ?? session.status));
}

/** Presentation evidence only. Never use this to release send/stop protection:
 * connected metadata can show execution and a history failure simultaneously. */
export function hasObservedRunningExecution(session: SessionSummary) {
  const runtime = session.runtime;
  return !!runtime && runtime.connection === 'connected' && runtime.phase !== 'unknown'
    && runtime.threadActivity !== 'unknown' && runtime.operation !== 'compact'
    && hasQueueBlockingRun(session);
}

/** Scope an old turn's history warning without claiming transport health. */
export function hasObservedRunningSuccessor(session: SessionSummary) {
  const runtime = session.runtime;
  return !!runtime && ['completed', 'failed', 'interrupted'].includes(runtime.phase)
    && ['running', 'waiting'].includes(runtime.threadActivity ?? '')
    && hasObservedRunningExecution(session);
}

/** Acknowledging the unread badge must not erase the last run's outcome. */
export function sessionRunOutcome(session: SessionSummary): 'completed' | 'failed' | 'interrupted' | undefined {
  if (session.runtime?.operation === 'compact') return;
  // A paused long-term goal must not erase a verified completed turn. This is
  // presentation only: isSessionBusy continues to protect runtime operations.
  if (goalWaitingLabel(session)) return 'completed';
  if (isSessionBusy(session) || session.runtime?.connection === 'disconnected') return;
  if (session.runtime) {
    if (session.runtime.sync !== 'current') return;
    const phase = session.runtime.phase;
    if (phase === 'completed' || phase === 'failed' || phase === 'interrupted') return phase;
    return;
  }
  if (session.runCompletedAt && (!session.runStartedAt || session.runCompletedAt >= session.runStartedAt)) {
    if (session.status === 'failed') return 'failed';
    if (session.status === 'idle') return 'completed';
  }
}

export function compactProgressLabel(session: SessionSummary) {
  const runtime = session.runtime;
  if (runtime?.operation !== 'compact') return;
  if (runtime.connection === 'disconnected' || runtime.phase === 'unknown') return 'Compaction outcome unconfirmed · not retried';
  if (runtime.phase === 'completed') return 'Context compacted';
  if (runtime.phase === 'interrupted') return 'Compaction stopped';
  if (runtime.phase === 'failed') return 'Compaction failed';
  if (runtime.stopRequested) return 'Stopping compaction · awaiting confirmation…';
  return runtime.phase === 'finalizing' ? 'Verifying compacted history…' : 'Compacting…';
}

// A blocked goal is not a failed message transport or an executing turn.
// This is presentation-only: do not relax send/stop/compact safety guards.
export function goalWaitingLabel(session: SessionSummary) {
  const runtime = session.runtime;
  if (runtime?.executionProtection?.state === 'blocked' && runtime.executionProtection.reason === 'goal-blocked'
    && runtime.operation !== 'compact' && runtime.phase === 'completed' && runtime.threadActivity === 'idle'
    && runtime.connection === 'connected' && runtime.sync === 'current') {
    return 'Long-term goal paused';
  }
}

export function executionProtectionLabel(session: SessionSummary) {
  if (session.runtime?.executionProtection?.state !== 'blocked') return undefined;
  if (goalWaitingLabel(session)) return undefined;
  // A retained checkpoint is not a failed transport. The terminal snapshot
  // has its own pending notice; never show two competing sync/error banners.
  if (session.runtime.sync === 'syncing' && session.runtime.connection === 'connected'
    && session.runtime.threadActivity === 'idle' && ['completed', 'failed', 'interrupted'].includes(session.runtime.phase)
    && session.runtime.operation !== 'compact') return undefined;
  // A completed tracked turn and a live successor are different facts. A
  // stale final-history check must not present a confirmed running thread as
  // an indefinitely pending execution check. This is never clearance to send.
  if (hasObservedRunningExecution(session)) return 'Execution continuing · execution protected';
  if (session.runtime.executionProtection.reason === 'background-work') return 'Background work unfinished · execution protected';
  if (session.runtime.executionProtection.reason === 'cleanup-unconfirmed') return 'Tool cleanup unconfirmed · execution protected';
  if (session.runtime.sync !== 'current') return 'Checking execution protection…';
  if (session.runtime.executionProtection.reason === 'goal-unknown') return 'Native goal status unavailable · execution protected';
  if (session.runtime.executionProtection.reason === 'native-unavailable') return 'Native execution status unavailable · execution protected';
  return session.runtime.executionProtection.reason === 'goal-blocked'
    ? 'Native goal blocked · execution protected' : 'History readable · execution protected';
}

export function executionFailureLabel(session: SessionSummary) {
  const runtime = session.runtime;
  if (runtime?.operation === 'compact') return undefined;
  if (runtime?.phase === 'failed') {
    if (hasObservedRunningSuccessor(session)) return 'Previous execution failed';
    return runtime.connection === 'connected' && runtime.sync === 'current' && runtime.threadActivity === 'idle' && !isSessionBusy(session)
      ? 'Execution failed · ready for your next message' : 'Execution failed';
  }
  if (runtime?.reason === 'Codex reported an error · waiting for final run status') {
    return 'Execution reported an error · outcome unconfirmed';
  }
  if (!runtime && session.status === 'failed') return 'Execution failed';
  return undefined;
}

export function formatElapsedDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  if (safeSeconds < 60) return `${safeSeconds}s`;
  const totalMinutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  if (totalMinutes < 60) {
    return seconds ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

export function runSyncNotice(session: SessionSummary, now: number, latestMessagesUnavailable = false) {
  const runtime = session.runtime;
  const incomplete = runtime?.sync === 'error';
  const terminal = runtime && ['completed', 'interrupted', 'failed'].includes(runtime.phase);
  const unconfirmed = runtime?.phase === 'unknown' || runtime?.threadActivity === 'unknown' || runtime?.connection === 'disconnected';
  const threadActive = runtime?.threadActivity === 'running' || runtime?.threadActivity === 'waiting';
  const liveSuccessor = hasObservedRunningSuccessor(session);
  // Exact, known Connector reason only. This is a presentation distinction,
  // not evidence that history is current or permission to terminate a process.
  // Unknown/disconnected snapshots retain the conservative sync notice.
  const backgroundWaitReason = runtime?.reason === 'Codex background terminals are still running'
    // Retain the legacy completed prefix for older Connectors, and accept
    // exact outcome-aware reasons from newer Connectors. No fuzzy matching.
    || ['completed', 'failed', 'interrupted'].some(outcome => runtime?.reason
      === `Codex ${outcome}, but AgentOpsDeck could not load the final response: Codex background terminals are still running`);
  const backgroundPending = terminal && runtime.connection === 'connected' && !unconfirmed
    && (runtime.executionProtection?.state === 'blocked' && runtime.executionProtection.reason === 'background-work'
      || incomplete && backgroundWaitReason);
  const executionLabel = executionFailureLabel(session);
  const backgroundWorkLabel = backgroundPending ? 'Background work unfinished · execution protected' : undefined;
  const historyErrorLabel = incomplete && !(backgroundPending && backgroundWaitReason)
    ? liveSuccessor ? 'Previous run history sync incomplete · thread still active'
      : terminal ? 'Run finished · history sync incomplete'
        : unconfirmed ? 'History sync incomplete · run state unconfirmed' : 'History sync incomplete'
    : undefined;
  const notice = {
    incomplete,
    backgroundLabel: backgroundPending ? 'Queue waiting for terminal cleanup' : undefined,
    goalLabel: goalWaitingLabel(session),
    progressLabel: !terminal && !unconfirmed && !incomplete && runtime?.phase === 'running' ? runtime.reason : undefined,
    errorLabel: backgroundPending ? 'Run finished · background terminals still active'
      : historyErrorLabel ?? executionProtectionLabel(session),
    syncLabel: terminal && runtime.sync === 'syncing' ? liveSuccessor
      ? 'Syncing previous run history · thread still active' : 'Run finished · syncing history…' : undefined,
    connectionLabel: runtime?.connection === 'disconnected' ? terminal ? 'Agent connection lost · run finished'
      : 'Connection lost · run state unconfirmed' : undefined,
    threadLabel: terminal && runtime.threadActivity && runtime.threadActivity !== 'idle'
      ? runtime.threadActivity === 'unknown' ? 'Previous run finished · checking thread state…'
        : runtime.threadActivity === 'waiting' ? 'Previous run finished · thread waiting for approval or input'
          : 'Previous run finished · thread still active' : undefined,
    // Sync failure is not execution time. A finished run must not keep a
    // spinner/elapsed counter alive just because sending is queue-gated.
    animate: executionLabel !== 'Execution reported an error · outcome unconfirmed' && !incomplete && (!terminal || threadActive) && !unconfirmed,
    elapsed: !executionLabel && !incomplete && !terminal && !unconfirmed && runtime?.phase !== 'finalizing' && isSessionBusy(session) && session.runStartedAt
      ? formatElapsedDuration(((session.runCompletedAt ?? now) - session.runStartedAt) / 1_000) : '',
  } as const;
  return { ...notice, executionLabel, backgroundWorkLabel,
    detailLabels: [...new Set([backgroundWorkLabel, backgroundPending ? historyErrorLabel : notice.errorLabel,
      notice.syncLabel, notice.connectionLabel, notice.threadLabel,
      latestMessagesUnavailable ? 'Latest messages unavailable' : undefined].filter((label): label is NonNullable<typeof label> => !!label))] } as const;
}

const IGNORED_LIVE_TOOL_NAMES = new Set(['subagent/activity', 'wait_agent', 'multi_agent_v1__wait_agent']);

function compactSingleLine(value: string, maxChars = 48): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

/** Presentation-only live tool summary for the active turn so multi-minute
 * commands/tools never appear silently hung behind generic "Agent is working…". */
export function activeToolProgressSummary(
  session: SessionSummary,
  messages: readonly ChatMessage[],
): { kind: 'command' | 'tool'; detail: string } | undefined {
  const runtime = session.runtime;
  if (!runtime || runtime.phase !== 'running' || runtime.connection !== 'connected'
    || runtime.sync === 'error' || runtime.threadActivity === 'unknown' || runtime.operation === 'compact') {
    return undefined;
  }
  let startIndex = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const item = messages[i]!;
    if (item.sessionKey === session.sessionKey && item.role === 'user' && item.status !== 'queued') {
      startIndex = i + 1;
      break;
    }
  }
  const finished = new Set<string>();
  const candidates: ChatMessage[] = [];
  for (let i = startIndex; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.sessionKey !== session.sessionKey || msg.role !== 'tool' || msg.parentToolUseId) continue;
    if (runtime.turnId && msg.turnId && msg.turnId !== runtime.turnId) continue;
    if (msg.toolPhase === 'result' && msg.toolCallId) {
      finished.add(msg.toolCallId);
      continue;
    }
    if (msg.toolPhase === 'call' || msg.status === 'sending') {
      candidates.push(msg);
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    const msg = candidates[i]!;
    if (msg.toolCallId && finished.has(msg.toolCallId)) continue;
    if (msg.codexSubagent?.action === 'wait') continue;
    const rawName = (msg.toolName ?? '').trim();
    if (rawName && IGNORED_LIVE_TOOL_NAMES.has(rawName)) continue;
    const rawPreview = msg.toolPreview ?? msg.text ?? '';
    const parsed = parseToolDetail(rawPreview);
    if (parsed.kind === 'structured') {
      if (parsed.toolName && IGNORED_LIVE_TOOL_NAMES.has(parsed.toolName)) continue;
      if (parsed.input?.kind === 'command') {
        const detail = compactSingleLine(parsed.input.command);
        if (detail) return { kind: 'command', detail };
      }
      const structuredName = compactSingleLine(rawName || parsed.toolName || '', 40);
      if (structuredName) {
        const kind = /^(?:commandExecution|bash|sh|shell|exec_command|terminal)$/i.test(structuredName) ? 'command' : 'tool';
        return { kind, detail: structuredName };
      }
    }
    const fallbackName = compactSingleLine(rawName || rawPreview, 40);
    if (fallbackName && !IGNORED_LIVE_TOOL_NAMES.has(fallbackName)) {
      const kind = /^(?:commandExecution|bash|sh|shell|exec_command|terminal)$/i.test(fallbackName) ? 'command' : 'tool';
      return { kind, detail: fallbackName };
    }
  }
  return undefined;
}

export function mergeSelectedMessages(current: ChatMessage[], incoming: ChatMessage[], selected: Set<string | undefined>) {
  const previous = new Map(current.map((message) => [message.id, message]));
  return incoming.map((message) => selected.has(message.id) ? previous.get(message.id) ?? message : message);
}

export function isStreamCatchup(event: DeckEvent) {
  return event.type === 'stream.reset' || event.type === 'stream.status';
}

/** Detect whether a user message is currently being submitted or was just admitted
 * before the next session-state snapshot arrives, so the UI can immediately
 * reflect running status and accelerate active polling. */
export function hasOptimisticActiveSend(
  session: SessionSummary,
  sending: boolean,
  optimisticMessages: readonly ChatMessage[],
  now = Date.now(),
): boolean {
  if (sending) return true;
  for (const item of optimisticMessages) {
    if (item.role !== 'user' || item.text.trim() === '/stop') continue;
    if (item.status === 'sending') return true;
    if (
      item.status === 'sent' &&
      now - item.createdAt < 20_000 &&
      (!session.runCompletedAt || item.createdAt > session.runCompletedAt)
    ) {
      return true;
    }
  }
  return false;
}

/** Presentation-only projection that promotes an idle/completed session summary
 * into a running display state immediately when a message is sent. Never used
 * to relax send/stop/compact safety guards. */
export function withOptimisticRunningState(
  session: SessionSummary,
  activeSend: boolean,
  startedAt?: number,
): SessionSummary {
  if (!activeSend || isSessionBusy(session)) return session;
  const effectiveStart =
    session.runStartedAt && (!session.runCompletedAt || session.runStartedAt > session.runCompletedAt)
      ? session.runStartedAt
      : (startedAt ?? Date.now());
  const { runCompletedAt: _droppedCompletedAt, ...rest } = session;
  return {
    ...rest,
    status: 'running',
    hasActiveRun: true,
    runStartedAt: effectiveStart,
    ...(session.structuredStatus
      ? {
          structuredStatus: {
            ...session.structuredStatus,
            runState: 'running',
            hasActiveRun: true,
            displayStatus: 'running',
          },
        }
      : {}),
    ...(session.runtime && ['completed', 'failed', 'interrupted', 'idle'].includes(session.runtime.phase)
      ? {
          runtime: {
            ...session.runtime,
            phase: 'starting',
            threadActivity: 'running',
          },
        }
      : {}),
  };
}
