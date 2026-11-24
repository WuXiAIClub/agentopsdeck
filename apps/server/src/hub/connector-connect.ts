import { setTimeout as pause } from 'node:timers/promises';
import { connectorAuthorization, type ConnectorAuthorization } from './connector-authorization.js';

// A connect(2) refusal establishes that this HTTP attempt could not write.
// Reset, timeout, proxy HTTP errors, and lost responses do NOT establish that.
export class ConnectorNotDispatchedError extends Error {
  constructor() { super('Connector is not ready; command was not sent'); }
}

function refusedConnect(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every(refusedConnect);
  const failure = error as { code?: unknown; syscall?: unknown };
  return failure.code === 'ECONNREFUSED' && failure.syscall === 'connect';
}

// Only used around native fetch, before a Response has been returned. Callers
// reconstruct buffered requests, retain the same delivery key and node pin,
// and own the overall deadline. This is not a persisted offline-send queue.
// Five backoffs (3.1s total) cover a short process restart without extending
// the existing request deadline. Only buffered message sends opt in.
export async function connectWithRetry<T>(attempt: () => Promise<T>, signal: AbortSignal,
  authorize: ConnectorAuthorization, delays: readonly number[] = [100, 200, 400, 800, 1600]): Promise<T> {
  for (let retries = 0; ; retries++) {
    signal.throwIfAborted();
    await connectorAuthorization(authorize, signal);
    signal.throwIfAborted();
    try { return await attempt(); }
    catch (error) {
      // Native fetch wraps socket-connect errors in a TypeError. Do not infer
      // safety from arbitrary error text or an upstream response's JSON.
      if (!(error instanceof TypeError) || !refusedConnect(error.cause)) throw error;
      if (retries >= delays.length) throw new ConnectorNotDispatchedError();
      try { await pause(delays[retries], undefined, { signal }); }
      catch (error) { signal.throwIfAborted(); throw error; }
    }
  }
}
