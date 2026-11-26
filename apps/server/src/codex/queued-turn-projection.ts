import type { ChatMessage, SessionSummary } from '@agentopsdeck/shared';
import { TurnAuthorizationError, type QueuedTurn } from '../commands/turn-queue.js';
import type { CodexStartupPayload } from './startup-recovery.js';

/** Display facts only. Neither this mapping nor its result authorizes effects. */
export type CodexQueueDisplayFacts = { version: string | undefined; headId: string | null; executionCommandId: string | null };

export function codexQueueDisposition(id: string, facts: Pick<CodexQueueDisplayFacts, 'headId' | 'executionCommandId'>,
  current: Pick<SessionSummary, 'runtime' | 'hasActiveRun' | 'status'> | undefined): 'waiting' | 'preparing' {
  if (facts.headId && facts.headId !== id) return 'waiting';
  if (facts.executionCommandId === id) return 'preparing';
  const runtime = current?.runtime;
  const blocking = runtime
    ? ['starting', 'running', 'waiting', 'finalizing', 'unknown'].includes(runtime.phase)
      || ['running', 'waiting', 'unknown'].includes(runtime.threadActivity ?? '')
      || runtime.sync !== 'current'
      || runtime.executionProtection?.state === 'blocked'
      || runtime.connection === 'disconnected'
    : current?.hasActiveRun || current?.status === 'running' || current?.status === 'waiting';
  return blocking ? 'waiting' : 'preparing';
}

export function codexQueuedTurnMessage(entry: QueuedTurn<CodexStartupPayload>, facts: CodexQueueDisplayFacts,
  current: SessionSummary | undefined, updatedAt = Date.now()): ChatMessage {
  return { id: entry.id, sessionKey: entry.sessionKey, role: 'user', text: entry.payload.text,
    queueVersion: facts.version, queueDisposition: codexQueueDisposition(entry.id, facts, current),
    status: entry.state === 'blocked' ? 'failed' : entry.state === 'queued' ? 'queued' : 'outcome_unknown',
    ...(entry.state === 'blocked' ? { failureReason: new TurnAuthorizationError().message } : {}),
    createdAt: entry.createdAt, updatedAt,
    ...(entry.payload.images.length ? { media: entry.payload.images.map(image => image.media) } : {}) };
}
