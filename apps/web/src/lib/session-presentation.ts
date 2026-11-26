import type { ChatMessage, SessionSummary } from '@agentopsdeck/shared';
import { hasInvalidAssistantOutput } from './assistant-output.js';
import { compactProgressLabel, executionFailureLabel, executionProtectionLabel, hasObservedRunningExecution, hasObservedRunningSuccessor, hasQueueBlockingRun, runSyncNotice, sessionRunOutcome } from './live-session.js';

/** Execution colour does not erase transport health or release protection. */
export function sessionPresentation(session: SessionSummary, unread = false, syncError?: string) {
  const failureLabel = executionFailureLabel(session);
  if (failureLabel === 'Execution reported an error · outcome unconfirmed') return { state: 'error', label: failureLabel } as const;
  if (hasObservedRunningExecution(session)) {
    if (session.runtime?.sync === 'error') return { state: 'running', label: 'Running · history sync interrupted' } as const;
    if (syncError) return { state: 'running', label: 'Running · latest messages unavailable' } as const;
    if (session.runtime?.executionProtection?.state === 'blocked') return { state: 'running', label: 'Running · execution protected' } as const;
    if (session.runtime?.sync === 'syncing') return { state: 'running', label: 'Running · syncing history…' } as const;
    return { state: 'running', label: 'Run' } as const;
  }
  const backgroundLabel = runSyncNotice(session, 0).backgroundWorkLabel;
  if (backgroundLabel) return { state: 'error', label: backgroundLabel } as const;
  if (session.runtime?.sync === 'error') return { state: 'error', label: 'History sync interrupted' } as const;
  if (syncError) return { state: 'error', label: 'Latest messages unavailable' } as const;
  if (session.runtime?.connection === 'disconnected') return { state: 'error', label: 'Connector disconnected' } as const;
  if (session.runtime?.sync === 'syncing' && session.runtime.threadActivity === 'idle'
    && session.runtime.connection === 'connected' && session.runtime.operation !== 'compact'
    && ['completed', 'failed', 'interrupted'].includes(session.runtime.phase)) {
    return { state: 'neutral', label: 'Run finished · syncing history…' } as const;
  }
  const protectionLabel = executionProtectionLabel(session);
  if (protectionLabel) return { state: 'error', label: protectionLabel } as const;
  if (session.runtime?.operation === 'compact') {
    const label = compactProgressLabel(session)!;
    if (session.runtime.phase === 'unknown') return { state: 'error', label } as const;
    if (hasQueueBlockingRun(session)) return { state: 'running', label } as const;
    return { state: 'neutral', label } as const;
  }
  // Queue blocking is conservative safety evidence, not a verified running
  // badge. Keep explicit uncertainty consistent with dashboard classification.
  if (session.runtime?.phase === 'unknown' || session.runtime?.threadActivity === 'unknown') {
    return { state: 'error', label: 'Execution status unconfirmed' } as const;
  }
  if (hasQueueBlockingRun(session)) return { state: 'running', label: 'Run' } as const;
  const outcome = sessionRunOutcome(session);
  if (outcome === 'failed' || session.runtime?.phase === 'failed' || (!session.runtime && session.status === 'failed')) return { state: 'error', label: 'Run failed' } as const;
  if (outcome === 'completed') return unread
    ? { state: 'unread', label: 'Done · unread' } as const
    : { state: 'completed', label: 'Done' } as const;
  if (!session.runtime && session.status === 'unknown') {
    return { state: 'error', label: 'Agent runtime not ready' } as const;
  }
  return { state: 'neutral', label: outcome === 'interrupted' ? 'Interrupted' : 'Idle' } as const;
}

/** Keep sync retry visible even when the execution colour is running. */
export function sessionSyncIssueLabel(session: SessionSummary, syncError?: string) {
  if (session.runtime?.sync === 'error') {
    // Native final-history verification and visible-message fetching fail
    // independently. Do not let a stale native warning hide a current fetch
    // error, or imply that all later messages stopped arriving.
    if (hasObservedRunningSuccessor(session)) return syncError
      ? 'Previous run history sync incomplete · latest messages unavailable'
      : 'Previous run history sync incomplete · thread still active';
    return syncError ? 'History sync incomplete · latest messages unavailable' : 'History sync interrupted';
  }
  if (syncError) return 'Latest messages unavailable';
  const presentation = sessionPresentation(session);
  return presentation.state === 'error' ? presentation.label : undefined;
}

/** Input is the visible conversation, excluding tool/internal render items.
 * Never decorate a previous turn while a fresh final reply is still syncing. */
export function completedReplyId(session: SessionSummary, messages: readonly ChatMessage[]) {
  const reply = latestCompletedReply(session, messages);
  return reply && !hasInvalidAssistantOutput(reply) ? reply.id : undefined;
}

export function hasInvalidCompletedReply(session: SessionSummary, messages: readonly ChatMessage[]) {
  const reply = latestCompletedReply(session, messages);
  return !!reply && hasInvalidAssistantOutput(reply);
}

function latestCompletedReply(session: SessionSummary, messages: readonly ChatMessage[]) {
  if (sessionRunOutcome(session) !== 'completed') return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.status === 'queued' || message.status === 'sending' || message.status === 'outcome_unknown' || message.status === 'failed') continue;
    if (message.role === 'user') return undefined;
    if (message.role !== 'assistant' || message.parentToolUseId || message.toolName || message.toolCallId || message.toolPhase || message.phase === 'commentary') continue;
    if (!message.text.trim() && !message.media?.length) continue;
    if (message.text.trim() === 'NO_REPLY') continue;
    const turnId = session.runtime?.turnId;
    if (turnId && message.turnId) {
      if (turnId !== message.turnId) continue;
    } else if (session.runStartedAt && message.createdAt < session.runStartedAt) continue;
    return message;
  }
  return undefined;
}
