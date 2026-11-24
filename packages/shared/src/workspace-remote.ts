/** Ephemeral same-account control. Only an explicit send action submits a message. */
export type RemoteTargetStatus = 'idle' | 'running' | 'waiting' | 'error';
export type RemoteTarget = {
  id: string;
  title: string;
  kind: 'session' | 'notebook';
  status?: RemoteTargetStatus;
  unread?: boolean;
  elapsedSec?: number;
  snippet?: string;
  tokens?: number;
};
export type RemoteSnapshot = { name: string; targets: RemoteTarget[]; active: string | null };
export type RemoteDevice = RemoteSnapshot & { id: string; revision: number; sequence: number; expiresAt: number };
export type RemoteCommand = { id: string; revision: number; sequence: number; target: string; action: 'focus' | 'draft' | 'send'; text?: string };
/** Relative durations avoid depending on synchronized browser/server wall clocks. */
export type RemoteDelivery = RemoteCommand & { validForMs: number; waitedMs: number };
export type RemoteOutcome = 'applied' | 'occupied' | 'unavailable' | 'unknown';
export const REMOTE_TEXT_LIMIT = 8000;
export const remoteCatalogKey = (snapshot: RemoteSnapshot) =>
  JSON.stringify({ name: snapshot.name, targets: snapshot.targets.map(t => ({ id: t.id, title: t.title, kind: t.kind })) });
export const remoteTelemetryKey = (snapshot: RemoteSnapshot) =>
  JSON.stringify({
    name: snapshot.name,
    active: snapshot.active,
    targets: snapshot.targets.map(t => ({
      id: t.id,
      title: t.title,
      kind: t.kind,
      status: t.status ?? 'idle',
      unread: Boolean(t.unread),
      elapsedSec: t.elapsedSec ?? 0,
      snippet: t.snippet ?? '',
      tokens: t.tokens ?? 0,
    })),
  });
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const clean = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(v);
const cleanOptional = (v: unknown, max: number): boolean => v === undefined || (typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(v));
const ALLOWED_TARGET_KEYS = new Set(['id', 'title', 'kind', 'status', 'unread', 'elapsedSec', 'snippet', 'tokens']);
export function validRemoteSnapshot(v: unknown): v is RemoteSnapshot {
  if (!obj(v) || Object.keys(v).length !== 3 || !clean(v.name, 80) || !Array.isArray(v.targets) || v.targets.length > 64) return false;
  const ids = new Set<string>();
  for (const target of v.targets) {
    if (!obj(target)) return false;
    const keys = Object.keys(target);
    if (keys.length < 3 || !keys.every(k => ALLOWED_TARGET_KEYS.has(k))) return false;
    if (!clean(target.id, 160) || !clean(target.title, 160)
      || !['session', 'notebook'].includes(String(target.kind)) || ids.has(target.id)) return false;
    if (target.status !== undefined && !['idle', 'running', 'waiting', 'error'].includes(String(target.status))) return false;
    if (target.unread !== undefined && typeof target.unread !== 'boolean') return false;
    if (target.elapsedSec !== undefined && (!Number.isSafeInteger(target.elapsedSec) || Number(target.elapsedSec) < 0 || Number(target.elapsedSec) > 864000)) return false;
    if (!cleanOptional(target.snippet, 160)) return false;
    if (target.tokens !== undefined && (!Number.isSafeInteger(target.tokens) || Number(target.tokens) < 0 || Number(target.tokens) > 1_000_000_000)) return false;
    ids.add(target.id);
  }
  return v.active === null || (typeof v.active === 'string' && ids.has(v.active));
}
export function validRemoteCommand(v: unknown): v is RemoteCommand {
  return obj(v) && Object.keys(v).every(key => ['id', 'revision', 'sequence', 'target', 'action', 'text'].includes(key))
    && typeof v.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v.id) && Number.isSafeInteger(v.revision) && Number(v.revision) > 0
    && Number.isSafeInteger(v.sequence) && Number(v.sequence) > 0
    && clean(v.target, 160) && (v.action === 'focus' ? v.text === undefined : (v.action === 'draft' || v.action === 'send')
      && typeof v.text === 'string' && !!v.text.trim() && v.text.length <= REMOTE_TEXT_LIMIT && !/[\u0000\u202a-\u202e\u2066-\u2069]/.test(v.text));
}
