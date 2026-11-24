import type { HubStore } from './hub-store.js';
import type { HubMemberEvidence } from './member-owner-domain.js';
import { completionTarget, connectionCompletionTarget } from './completion-unread-store.js';
import { decodeHubSessionId } from './session-id.js';

export type HubCompletionAction = { action: 'summary'; sessions: string[] }
  | { action: 'observe'; sessionKey: string }
  | { action: 'read'; sessionKey: string; requestId: string; token: string; throughSequence: number };
type Summary = { sessionKey: string; displayTarget: string; generation: string; latestSequence: number;
  readThrough: number; unread: boolean; coverage: 'observed' | 'gap' };
type Observation = { token: string; generation: string; throughSequence: number; expiresAt: number; turnId?: string };
export type HubCompletionResult = { items: Summary[] } | { observation: Observation } | { throughSequence: number }
  | { error: 'invalid' | 'missing' } | { conflict: string } | null;
// Original HTTP summary admits 256 session keys within a 64KiB body. The
// typed wire envelope also includes request evidence/scope. Do not truncate.
export const HUB_COMPLETION_RPC_BYTES = 128 * 1024;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && Object.keys(v).every(k => keys.includes(k));
const sequence = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const sessionKey = (v: unknown): v is string => typeof v === 'string' && v.length <= 4096;
const identity = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\x00-\x1f\x7f]/.test(v);
const uuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
export function validHubCompletionAction(v: unknown): v is HubCompletionAction {
  if (!object(v)) return false;
  if (v.action === 'summary') return fields(v, ['action', 'sessions']) && Array.isArray(v.sessions)
    && v.sessions.length <= 256 && v.sessions.every(sessionKey);
  if (v.action === 'observe') return fields(v, ['action', 'sessionKey']) && sessionKey(v.sessionKey);
  return v.action === 'read' && fields(v, ['action', 'sessionKey', 'requestId', 'token', 'throughSequence'])
    && sessionKey(v.sessionKey) && typeof v.requestId === 'string' && typeof v.token === 'string'
    && typeof v.throughSequence === 'number' && Number.isFinite(v.throughSequence);
}
export function validHubCompletionResult(v: unknown, action: HubCompletionAction['action']): v is HubCompletionResult {
  if (v === null) return true;
  if (!object(v) || Object.keys(v).length !== 1) return false;
  if (v.error === 'invalid' || v.error === 'missing') return true;
  if (typeof v.conflict === 'string') return ['identity', 'sequence', 'target-missing', 'clock', 'observation-capacity',
    'request-reused', 'observation-invalid', 'ack-capacity', 'target-limit'].includes(v.conflict);
  if (action === 'read') return sequence(v.throughSequence);
  if (action === 'observe') {
    const o = v.observation;
    return object(o) && fields(o, ['token', 'generation', 'throughSequence', 'expiresAt', ...('turnId' in o ? ['turnId'] : [])])
      && uuid(o.token) && uuid(o.generation) && sequence(o.throughSequence) && sequence(o.expiresAt)
      && (o.turnId === undefined || identity(o.turnId));
  }
  return Array.isArray(v.items) && v.items.length <= 256 && v.items.every(r => object(r)
    && fields(r, ['sessionKey', 'displayTarget', 'generation', 'latestSequence', 'readThrough', 'unread', 'coverage'])
    && sessionKey(r.sessionKey) && typeof r.displayTarget === 'string' && /^[a-f0-9]{64}$/.test(r.displayTarget)
    && uuid(r.generation) && sequence(r.latestSequence) && sequence(r.readThrough) && typeof r.unread === 'boolean'
    && r.unread === (r.latestSequence > r.readThrough) && (r.coverage === 'observed' || r.coverage === 'gap'));
}
export type HubCompletionAuthority = { owner: string; targets: Array<{ sessionKey: string; id: string; displayTarget: string }> }
  | { error: 'invalid' | 'missing' } | null;

/** Called only inside the original completion transaction. Credentials and
 * current connection authority are resolved by this COMPLETE original owner,
 * not caller-supplied user/target/authority claims. No callback crosses RPC. */
export function hubCompletionAuthority(owner: HubStore, request: Request, expectedScope: string,
  action: HubCompletionAction): HubCompletionAuthority {
  const actor = owner.identities.commandPrincipal(request);
  if (!actor || owner.identities.recoveryScope(actor) !== expectedScope) return null;
  const keys = action.action === 'summary' ? action.sessions : [action.sessionKey];
  const targets: Array<{ sessionKey: string; id: string; displayTarget: string }> = [];
  for (const key of new Set(keys)) {
    const decoded = decodeHubSessionId(key);
    if (!decoded) return { error: 'invalid' };
    const connection = owner.getConnection(decoded.connectionId, actor.userId);
    const version = owner.connectionAuthority(decoded.connectionId, actor.userId);
    if (!connection?.nodeId || connection.status === 'disabled' || version === undefined) {
      if (action.action === 'summary') continue;
      return { error: 'missing' };
    }
    targets.push({ sessionKey: key, id: connectionCompletionTarget(connection.nodeId, connection.id, version, decoded.remoteSessionKey),
      displayTarget: completionTarget(connection.nodeId, 'display-only', decoded.remoteSessionKey) });
  }
  return { owner: actor.userId, targets };
}
export type HubCompletionProof = { evidence: HubMemberEvidence; expectedScope: string; command: HubCompletionAction };
