import type { SessionSummary } from '@agentopsdeck/shared';

/** Display metadata only. Never infer a channel from the Hub's opaque ID. */
export function sessionChannelRoute(session: SessionSummary): { channel: string; shape: 'direct' | 'group' | 'channel' | 'thread'; target: string } | undefined {
  const ref = session.sessionRef;
  if (!ref || ref.runtimeId !== 'openclaw') return undefined;
  const parts = ref.nativeSessionKey.split(':');
  const offset = parts[0] === 'agent' ? 2 : 0;
  const channel = parts[offset], shape = parts[offset + 1], target = parts.slice(offset + 2).join(':');
  if (!channel || !target || (shape !== 'direct' && shape !== 'group' && shape !== 'channel' && shape !== 'thread')) return undefined;
  return { channel, shape, target };
}
