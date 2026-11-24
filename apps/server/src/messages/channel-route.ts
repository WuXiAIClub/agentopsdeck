export type ExplicitChannelRoute = {
  originatingChannel: string;
  originatingTo: string;
  originatingAccountId?: string;
  outboundTarget: string;
};

export function resolveExplicitChannelRoute(sessionKey: string, defaultAgentId: string): ExplicitChannelRoute | undefined {
  const parts = sessionKey.split(':');
  const offset = parts[0] === 'agent' ? 2 : 0;
  const channel = parts[offset];
  const shape = parts[offset + 1];
  const to = parts.slice(offset + 2).join(':');
  if (!channel || !shape || !to) return undefined;
  if (!['direct', 'group', 'channel', 'thread'].includes(shape)) return undefined;
  const accountId = parts[0] === 'agent' && parts[1] ? parts[1] : defaultAgentId;
  return {
    originatingChannel: channel,
    originatingTo: to,
    ...(channel === 'feishu' && accountId ? { originatingAccountId: accountId } : {}),
    outboundTarget: channel === 'feishu' && shape === 'direct' ? `user:${to}` : to,
  };
}
