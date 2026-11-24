/** Read-only, bounded Preview protocol. Each item has its own outcome/validator. */
export const WORKSPACE_SYNC_VERSION = 1;
export const WORKSPACE_SYNC_MAX_ITEMS = 8;
export const WORKSPACE_SYNC_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export type WorkspaceSyncItem = { sessionKey: string; limit: number; etag?: string; priority?: number };
export type WorkspaceSyncFrame = {
  sessionKey: string;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
};

export function parseWorkspaceSyncRequest(value: unknown): WorkspaceSyncItem[] {
  const input = value as { version?: unknown; items?: unknown } | null;
  if (input?.version !== WORKSPACE_SYNC_VERSION || !Array.isArray(input.items)
    || input.items.length < 1 || input.items.length > WORKSPACE_SYNC_MAX_ITEMS) throw new Error('Invalid workspace sync request');
  const keys = new Set<string>();
  return input.items.map(item => {
    if (!item || typeof item !== 'object' || typeof item.sessionKey !== 'string' || !item.sessionKey.length || item.sessionKey.length > 4096
      || !Number.isInteger(item.limit) || item.limit < 1 || item.limit > 500 || keys.has(item.sessionKey)
      || (item.etag !== undefined && (typeof item.etag !== 'string' || !/^W\/"history-[a-f0-9]{64}"$/.test(item.etag)))
      || (item.priority !== undefined && (!Number.isInteger(item.priority) || item.priority < -10 || item.priority > 20)))
      throw new Error('Invalid workspace sync item');
    keys.add(item.sessionKey);
    return {
      sessionKey: item.sessionKey,
      limit: item.limit,
      ...(item.etag ? { etag: item.etag } : {}),
      ...(item.priority !== undefined ? { priority: item.priority } : {}),
    };
  });
}
