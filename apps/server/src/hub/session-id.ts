export function encodeHubSessionId(connectionId: string, remoteSessionKey: string) {
  return `${connectionId}:${Buffer.from(remoteSessionKey, 'utf8').toString('base64url')}`;
}

export function decodeHubSessionId(value: string) {
  const idx = value.indexOf(':');
  if (idx <= 0) return undefined;
  const connectionId = value.slice(0, idx);
  const encoded = value.slice(idx + 1);
  try {
    const remoteSessionKey = Buffer.from(encoded, 'base64url').toString('utf8');
    if (!remoteSessionKey || encodeHubSessionId(connectionId, remoteSessionKey) !== value) return undefined;
    return { connectionId, remoteSessionKey };
  } catch {
    return undefined;
  }
}
