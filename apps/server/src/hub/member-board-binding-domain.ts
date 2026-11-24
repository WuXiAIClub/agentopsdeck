import { validBoardId, validBoardUuid } from '@agentopsdeck/shared';
import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import { decodeHubSessionId } from './session-id.js';
import { validBoardToolCredential } from '../tools/workspace-board-cli.js';
import { parseBoardAgentEndpoint, validHubBoardBindingInput, type HubBoardBinding, type HubBoardBindingInput } from './workspace-board-bindings.js';

export type HubBoardBindingTarget = { sessionId: string; connectionId: string; remoteSessionKey: string; nodeId: string; epoch: number };
type Base = { boardId: string };
export type HubBoardBindingCommand = Base & (
  { action: 'list' } | { action: 'target'; sessionId: string }
  | { action: 'check'; target: HubBoardBindingTarget }
  | { [A in 'read' | 'revoke' | 'cancel']: { action:A; id:string } }['read' | 'revoke' | 'cancel']
  | { action: 'prepare'; input: HubBoardBindingInput; target: HubBoardBindingTarget; endpoint: string }
  | { action: 'claim'; id: string; target: HubBoardBindingTarget }
  | { action: 'outcome'; id: string; target: HubBoardBindingTarget; state: 'installed' | 'uncertain' });
export type HubBoardBindingCredential = { endpoint: string; token: string; expiresAt: number };
export type HubBoardBindingResult = null | { error: 403 | 404 | 409 | 429 }
  | { action: 'list'; enabled: boolean; bindings: HubBoardBinding[] }
  | { action: 'target'; target: HubBoardBindingTarget }
  | { action: 'check'; ok: true }
  | { [A in 'read' | 'prepare' | 'outcome' | 'revoke']: { action: A; binding: HubBoardBinding | null } }['read' | 'prepare' | 'outcome' | 'revoke']
  | { action: 'claim'; binding: HubBoardBinding; credential: HubBoardBindingCredential | null }
  | { action: 'cancel'; cancelled: true; requestId: string; binding: HubBoardBinding | null };
export const HUB_BOARD_BINDING_RESULT_BYTES = 1024 * 1024;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v,k));
const text = (v: unknown, max = 2048): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0');
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const session = (v: unknown): v is string => text(v) && !!decodeHubSessionId(v) && /^(codex|claude-code|ghcp):/.test(decodeHubSessionId(v)!.remoteSessionKey);
function target(v: unknown): v is HubBoardBindingTarget {
  if (!object(v) || !fields(v,['sessionId','connectionId','remoteSessionKey','nodeId','epoch']) || !session(v.sessionId)
    || !text(v.connectionId) || !text(v.remoteSessionKey) || !text(v.nodeId) || !integer(v.epoch)) return false;
  const decoded = decodeHubSessionId(v.sessionId)!;
  return decoded.connectionId === v.connectionId && decoded.remoteSessionKey === v.remoteSessionKey;
}
function binding(v: unknown): v is HubBoardBinding {
  return object(v) && fields(v,['requestId','boardId','sessionId','capabilityId','state','expiresAt','createdAt'])
    && validBoardUuid(v.requestId) && validBoardId(v.boardId) && session(v.sessionId) && validBoardUuid(v.capabilityId)
    && ['prepared','installed','uncertain','revoked','expired','unavailable'].includes(String(v.state)) && integer(v.expiresAt) && integer(v.createdAt);
}
export function validHubBoardBindingCommand(v: unknown): v is HubBoardBindingCommand {
  if (!object(v) || !validBoardId(v.boardId)) return false;
  switch (v.action) {
    case 'list': return fields(v,['action','boardId']);
    case 'target': return fields(v,['action','boardId','sessionId']) && session(v.sessionId);
    case 'check': return fields(v,['action','boardId','target']) && target(v.target);
    case 'read': case 'revoke': case 'cancel': return fields(v,['action','boardId','id']) && validBoardUuid(v.id);
    case 'prepare': {
      if (!fields(v,['action','boardId','input','target','endpoint']) || !validHubBoardBindingInput(v.input)
        || !target(v.target) || v.input.sessionId !== v.target.sessionId || !text(v.endpoint,8192)) return false;
      try { return parseBoardAgentEndpoint(v.endpoint) === v.endpoint; } catch { return false; }
    }
    case 'claim': return fields(v,['action','boardId','id','target']) && validBoardUuid(v.id) && target(v.target);
    case 'outcome': return fields(v,['action','boardId','id','target','state']) && validBoardUuid(v.id) && target(v.target) && ['installed','uncertain'].includes(String(v.state));
    default: return false;
  }
}
export function validHubBoardBindingResult(v: unknown): v is HubBoardBindingResult {
  if (v === null) return true;
  if (!object(v)) return false;
  if ('error' in v) return fields(v,['error']) && [403,404,409,429].includes(Number(v.error)) && typeof v.error === 'number';
  switch (v.action) {
    case 'list': return fields(v,['action','enabled','bindings']) && typeof v.enabled === 'boolean' && Array.isArray(v.bindings)
      && v.bindings.length <= 256 && v.bindings.every(binding) && new Set(v.bindings.map(b => b.requestId)).size === v.bindings.length;
    case 'target': return fields(v,['action','target']) && target(v.target);
    case 'check': return fields(v,['action','ok']) && v.ok === true;
    case 'read': case 'prepare': case 'outcome': case 'revoke': return fields(v,['action','binding']) && (v.binding === null || binding(v.binding));
    case 'claim': return fields(v,['action','binding','credential']) && binding(v.binding) && (v.credential === null
      || object(v.credential) && fields(v.credential,['endpoint','token','expiresAt']) && validBoardToolCredential(v.credential)
        && v.binding.state === 'uncertain' && v.credential.expiresAt === v.binding.expiresAt);
    case 'cancel': return fields(v,['action','cancelled','requestId','binding']) && v.cancelled === true && validBoardUuid(v.requestId)
      && (v.binding === null || binding(v.binding) && v.binding.requestId === v.requestId);
    default: return false;
  }
}

/** Called only inside the identity owner's original savepoint. No callback,
 * caller principal, SQL or external effect crosses the worker boundary. */
export function executeHubBoardBinding(owner: HubStore, actor: HubPrincipal, command: HubBoardBindingCommand): HubBoardBindingResult {
  const user = actor.userId, board = command.boardId, store = owner.boardBindings;
  const currentTarget = (sessionId: string): HubBoardBindingTarget | undefined => {
    const decoded = decodeHubSessionId(sessionId);
    if (!decoded || !session(sessionId)) return;
    const connection = owner.getConnection(decoded.connectionId,user), epoch = owner.connectionAuthority(decoded.connectionId,user);
    if (!connection?.nodeId || connection.status === 'disabled' || epoch === undefined) return;
    return { sessionId,connectionId:decoded.connectionId,remoteSessionKey:decoded.remoteSessionKey,nodeId:connection.nodeId,epoch };
  };
  if (command.action === 'list') return { action:'list',enabled:store.enabled,bindings:store.list(user,board) };
  if (command.action === 'target') {
    const value = currentTarget(command.sessionId); return value ? { action:'target',target:value } : { error:404 };
  }
  if ('target' in command) {
    const fresh = currentTarget(command.target.sessionId);
    if (!fresh || fresh.connectionId !== command.target.connectionId || fresh.remoteSessionKey !== command.target.remoteSessionKey
      || fresh.nodeId !== command.target.nodeId || fresh.epoch !== command.target.epoch) return { error:403 };
  }
  if (command.action === 'check') return { action:'check',ok:true };
  if (command.action === 'cancel') {
    const receipt = store.cancelIntent(user,board,command.id); return receipt ? { action:'cancel',...receipt } : { error:429 };
  }
  if (command.action === 'revoke') return { action:'revoke',binding:store.revoke(user,board,command.id) ?? null };
  if (command.action === 'read') return { action:'read',binding:store.get(user,board,command.id) ?? null };
  if (command.action === 'prepare') return { action:'prepare',binding:store.prepare(user,board,command.input,
    command.target.connectionId,command.target.epoch,command.endpoint) ?? null };
  const original = store.get(user,board,command.id);
  if (!original || original.sessionId !== command.target.sessionId) return { error:404 };
  // uncertain is produced only by an explicit remote GET, not a late PUT
  // failure. Such a lookup must be able to invalidate an old installed view.
  if (command.action === 'outcome') return { action:'outcome',binding:store.outcome(user,board,command.id,command.state) ?? null };
  // This CAS is in the same original transaction as proof/epoch/credential.
  // Only prepared may dispatch. An uncertain receipt is never a retry permit.
  if (original.state !== 'prepared') return { action:'claim',binding:original,credential:null };
  const credential = store.credential(user,board,command.id);
  if (!credential) return { error:409 };
  const claimed = store.outcome(user,board,command.id,'uncertain')!;
  return { action:'claim',binding:claimed,credential };
}
