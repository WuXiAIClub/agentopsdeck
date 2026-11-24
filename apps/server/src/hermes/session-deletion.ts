import { SessionDeletionConflict } from '../commands/turn-queue.js';
import { record } from './protocol.js';
import { HermesRemoteError } from './rpc-peer.js';

export type HermesDeletionNative = { request(method: string, params: Record<string, unknown>): Promise<unknown> };

/** Observation only. Never resume/create an absent live session to delete it. */
export async function inspectHermesDeletion(stored: string, live: string | undefined, native: HermesDeletionNative) {
  if (!live) return;
  const snapshot = await native.request('session.activate', { session_id: live, omit_messages: true });
  const retainedFailure = record(snapshot) && record(snapshot.inflight)
    && snapshot.inflight.status === 'error' && snapshot.inflight.streaming === false;
  if (!record(snapshot) || snapshot.session_id !== live || snapshot.session_key !== stored
    || record(snapshot.info) && snapshot.info.stored_session_id && snapshot.info.stored_session_id !== stored
    || snapshot.status !== 'idle' || snapshot.running !== false || snapshot.queued || snapshot.hydrating
    || snapshot.auto_continue || snapshot.pending_approval || snapshot.pending_connection
    || snapshot.inflight && !retainedFailure || Array.isArray(snapshot.open_requests) && snapshot.open_requests.length) {
    throw new SessionDeletionConflict('Hermes is not safely idle; refresh before deleting');
  }
}

/** One original close/delete sequence. Any missing ACK stays unknown upstream.
 * Guard is re-entered for EACH effect; never interpret an awaited bool as a lease. */
export async function deleteHermesNative(stored: string, live: string | undefined, native: HermesDeletionNative,
  guard: (stage: 'close' | 'delete') => void | Promise<void>, closed: () => void, current = () => true) {
  const closePermission = guard('close');
  if (closePermission) await closePermission;
  if (current() !== true) throw Error('Hermes deletion connection changed');
  if (live) {
    const result = await native.request('session.close', { session_id: live });
    if (!record(result) || result.closed !== true) throw Error('Unconfirmed Hermes close');
    closed();
  }
  const deletePermission = guard('delete');
  if (deletePermission) await deletePermission;
  if (current() !== true) throw Error('Hermes deletion connection changed');
  try {
    const result = await native.request('session.delete', { session_id: stored });
    if (!record(result) || result.deleted !== stored) throw Error('Invalid Hermes deletion acknowledgement');
  } catch (error) {
    // Only the typed reply to THIS original delete proves absence.
    if (!(error instanceof HermesRemoteError && error.code === 4007)) throw error;
  }
}
