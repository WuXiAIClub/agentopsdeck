import type { DatabaseSync } from 'node:sqlite';

type Inspector = (value: unknown) => void;
const participants = new WeakMap<DatabaseSync, Inspector>();

/** Inner synchronous hooks belong to the original outer owner. Latch an
 * escaped Promise there so all enclosing writes roll back before retirement.
 * Do not let a nested RELEASE or a caught inner rejection settle that owner. */
export function withSynchronousParticipants<T>(db: DatabaseSync, inspect: Inspector, work: () => T): T {
  if (participants.has(db)) return work();
  participants.set(db, inspect);
  try { return work(); } finally { participants.delete(db); }
}

export function synchronousParticipantInspector(db: DatabaseSync): Inspector | undefined {
  return participants.get(db);
}
