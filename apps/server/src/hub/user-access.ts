import type { DatabaseSync } from 'node:sqlite';

export type HubUserAccess = { userId: string; status: 'enabled' | 'disabled'; version: number };
export type HubUserAccessCommand = { action: 'accessRead'; userId: string }
  | { action: 'accessChange'; userId: string; status: HubUserAccess['status']; expectedVersion: number };

/** An absent row preserves existing accounts as enabled/version zero. Account
 * epochs are independent of labels, roles, grants and connection versions. */
export function initializeHubUserAccess(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS hub_user_access (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    status TEXT NOT NULL CHECK(status IN ('enabled', 'disabled')),
    version INTEGER NOT NULL CHECK(version > 0 AND version <= 9007199254740991)
  );`);
}

export function hubUserEnabled(db: DatabaseSync, userId: string): boolean {
  return !db.prepare("SELECT 1 FROM hub_user_access WHERE user_id = ? AND status = 'disabled'").get(userId);
}

export function readHubUserAccess(db: DatabaseSync, userId: string): HubUserAccess | undefined {
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return undefined;
  const row = db.prepare('SELECT status, version FROM hub_user_access WHERE user_id = ?').get(userId) as
    Pick<HubUserAccess, 'status' | 'version'> | undefined;
  return { userId, status: row?.status ?? 'enabled', version: row?.version ?? 0 };
}

export function validHubUserAccess(value: unknown): value is HubUserAccess {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).sort().join() === 'status,userId,version'
    && typeof v.userId === 'string' && !!v.userId && !v.userId.includes('\0') && Buffer.byteLength(v.userId) <= 16_384
    && (v.status === 'enabled' || v.status === 'disabled')
    && Number.isSafeInteger(v.version) && Number(v.version) >= 0;
}

export function validHubUserAccessCommand(value: unknown): value is HubUserAccessCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.userId !== 'string' || !v.userId || v.userId.includes('\0') || Buffer.byteLength(v.userId) > 16_384) return false;
  return v.action === 'accessRead' && Object.keys(v).sort().join() === 'action,userId'
    || v.action === 'accessChange' && Object.keys(v).sort().join() === 'action,expectedVersion,status,userId'
      && (v.status === 'enabled' || v.status === 'disabled')
      && Number.isSafeInteger(v.expectedVersion) && Number(v.expectedVersion) >= 0 && Number(v.expectedVersion) < Number.MAX_SAFE_INTEGER;
}
