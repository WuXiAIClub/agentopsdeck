export type HubAccountAccess = { userId: string; status: 'enabled' | 'disabled'; version: number };

/** Unknown ACKs never authorize a retry or turn an unavailable view usable. */
export function parseHubAccountAccess(value: unknown, userId: string,
  change?: { status: HubAccountAccess['status']; expectedVersion: number }): HubAccountAccess {
  const access = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).access : undefined;
  if (!access || typeof access !== 'object' || Array.isArray(access)) throw new Error('Account state unavailable');
  const v = access as Record<string, unknown>;
  if (Object.keys(v).sort().join() !== 'status,userId,version' || v.userId !== userId
    || (v.status !== 'enabled' && v.status !== 'disabled') || !Number.isSafeInteger(v.version)
    || Number(v.version) < 0 || v.status === 'disabled' && v.version === 0
    || change && (v.status !== change.status || v.version !== change.expectedVersion + 1)) {
    throw new Error('Account state unavailable');
  }
  return { userId, status: v.status, version: Number(v.version) };
}
