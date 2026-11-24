import type { DatabaseSync } from 'node:sqlite';
import { observedSavepoint } from './observed-savepoint.js';
import { synchronousParticipantInspector } from './synchronous-participant.js';

type Operation = 'execution-issuer-check' | 'content-authority-check' | 'node-authority-check'
  | 'maintenance-policy-check' | 'delegation-authority-check' | 'checkpoint-authority-check';

/** Inspect callbacks before interpreting their return values. In an existing
 * observed operation use its ORIGINAL inspector, never an inner retirement.
 * Standalone callbacks get a rollback boundary even when nominally read-only:
 * injected JavaScript can write before returning its asynchronous continuation.
 * This is not an async adapter, cache, retry or permission to replay a write. */
export function observedParticipant<T>(db: DatabaseSync, operation: Operation, work: () => T): T {
  const inspect = synchronousParticipantInspector(db);
  if (inspect) {
    // A caller may have caught an earlier contract violation. The original
    // sticky inspector must refuse another hook before invoking its body.
    inspect(undefined);
    const value = work(); inspect(value); return value;
  }
  return observedSavepoint(db, operation, check => {
    const value = work(); check(value); return value as T extends PromiseLike<unknown> ? never : T;
  });
}
