import { types } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { AuthPersistenceError } from './private-store.js';
import { synchronousParticipantInspector } from '../storage/synchronous-participant.js';
import { retireConnectionForAsyncWork } from '../storage/connection-recovery.js';

/** A local scalar callback is not an asynchronous SQL command. Reject known
 * async functions before dispatch. If an ordinary function has already escaped
 * native Promise work, latch it on the ORIGINAL transaction before retirement;
 * outside a transaction, fence the same connection and its prepared statements.
 * Never inspect a returned object's then/getters or replace/replay its owner. */
export function synchronousSqliteValue<Args extends unknown[] = []>(db: DatabaseSync,
  reader: (...args: Args) => unknown, receiver?: unknown, args?: Args): unknown {
  if (types.isAsyncFunction(reader)) throw new AuthPersistenceError();
  const value: unknown = Reflect.apply(reader, receiver, args ?? []);
  if (types.isPromise(value)) {
    const inspect = synchronousParticipantInspector(db);
    if (inspect) inspect(value);
    else retireConnectionForAsyncWork(db);
    // Native Promise observation reads constructor/species. Fence SQL (or latch
    // the original transaction's escaped work) BEFORE any such getter can run.
    try { void Promise.prototype.then.call(value, () => {}, () => {}); } catch { /* Denied regardless. */ }
    throw new AuthPersistenceError();
  }
  return value;
}

export function synchronousSqliteIdentity(db: DatabaseSync, reader: () => unknown, receiver?: unknown): string | undefined {
  const value = synchronousSqliteValue(db, reader, receiver);
  if (value !== undefined && (typeof value !== 'string' || !/^[a-f0-9]{24}$/.test(value))) throw new AuthPersistenceError();
  return value;
}
