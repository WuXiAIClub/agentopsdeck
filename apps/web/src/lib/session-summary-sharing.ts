import type { SessionSummary } from '@agentopsdeck/shared';
import { projectionCursor } from './refresh-control.js';
import type { SessionListSnapshot } from './session-snapshot.js';

// API snapshots are JSON data. Compare every own field, including fields added
// by future servers; never maintain a presentation-only runtime/permission list.
function equalData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
  if (!Array.isArray(left) && Object.getPrototypeOf(left) !== Object.prototype) return false;
  if (Array.isArray(left) && left.length !== (right as unknown[]).length) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key =>
    Object.prototype.hasOwnProperty.call(right, key) && equalData(
      (left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key],
    ));
}

/** Pure, one-snapshot structural sharing AFTER the authority/request gate.
 * No retained history, module cache, mutation, or merging of missing fields.
 * The caller's workspace is remounted on recovery-scope changes.
 */
export function shareSessionSummaries<T extends SessionListSnapshot>(previous: T, next: T): T {
  if (previous.viewKey !== next.viewKey || Boolean(previous.sourceStates) !== Boolean(next.sourceStates)) return next;
  const beforeSources = new Map(previous.sourceStates?.map(source => [source.connectionId, source]));
  const afterSources = new Map(next.sourceStates?.map(source => [source.connectionId, source]));
  const canShareSource = (session: SessionSummary) => {
    if (!next.sourceStates) return true; // Legacy snapshots still compare all fields.
    const id = (session as SessionSummary & { envConnectionId?: string }).envConnectionId ?? session.sessionKey.split(':')[0]!;
    const before = beforeSources.get(id), after = afterSources.get(id);
    if (!before || !after || before.state !== 'ready' || after.state !== 'ready' || before.authority !== after.authority) return false;
    // Unknown cursors are only equivalent when literally unchanged.
    return before.cursor === after.cursor || Boolean(projectionCursor(before.cursor) &&
      projectionCursor(before.cursor)?.epoch === projectionCursor(after.cursor)?.epoch);
  };
  const before = new Map<string, SessionSummary>();
  const duplicates = new Set<string>();
  for (const group of previous.groups) for (const session of group.sessions) {
    if (before.has(session.sessionKey)) duplicates.add(session.sessionKey);
    before.set(session.sessionKey, session);
  }
  const seen = new Set<string>();
  for (const group of next.groups) for (const session of group.sessions) {
    if (seen.has(session.sessionKey)) duplicates.add(session.sessionKey);
    seen.add(session.sessionKey);
  }
  const groups = next.groups.map((group, index) => {
    const sessions = group.sessions.map(session => {
      const prior = before.get(session.sessionKey);
      return prior && !duplicates.has(session.sessionKey) && canShareSource(session) && equalData(prior, session) ? prior : session;
    });
    const prior = previous.groups[index];
    // Reference equality here prevents reusing a group across an authority or
    // epoch boundary even when its JSON representation happens to be identical.
    const sameRows = prior && prior.sessions.length === sessions.length && sessions.every((session, i) => session === prior.sessions[i]);
    const result = { ...group, sessions };
    return sameRows && equalData(prior, result) ? prior : result;
  });
  const sameGroups = groups.length === previous.groups.length && groups.every((group, i) => group === previous.groups[i]);
  return { ...next, groups: sameGroups ? previous.groups : groups };
}
