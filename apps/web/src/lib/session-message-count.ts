import type { SessionSummary } from '@agentopsdeck/shared';

/** A loaded history window (or optimistic row) is not the session total. */
export function sessionMessageCount(session: SessionSummary): number | undefined {
  const legacy = session as SessionSummary & { messagesCount?: unknown; context?: { messageCount?: unknown } };
  const value = session.messageCount ?? legacy.messagesCount ?? legacy.context?.messageCount;
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}
