import type { DatabaseSync } from 'node:sqlite';
import type { SharedGrantPage, SharedGrantSummary } from '@agentopsdeck/shared';
import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import { parseNodeGrantPolicy } from './node-grants.js';
import { sessionRef } from './session-ref.js';
import { encodeHubSessionId } from './session-id.js';
import { isNodeId } from '../connector/node-identity.js';

/** Recipient ID is correlation, never authority: original identity must match.
 * GET also maintains administrator-derived grants and is NOT a pure read. */
export type HubReceivedGrantCommand = { userId: string; after: string; limit: number };
export type HubReceivedGrantResult = null | HubReceivedGrantCommand & { page: SharedGrantPage };
export const HUB_RECEIVED_GRANT_RESULT_BYTES = 2 * 1024 * 1024;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && Object.keys(v).every(k => names.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= 16_384;
const cursor = (v: unknown): v is string => typeof v === 'string' && (v === '' || /^[0-9a-f-]{36}$/.test(v));
const version = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 1;
export function validHubReceivedGrantCommand(v: unknown): v is HubReceivedGrantCommand {
  return object(v) && fields(v, ['userId','after','limit']) && id(v.userId) && cursor(v.after)
    && Number.isInteger(v.limit) && Number(v.limit) >= 1 && Number(v.limit) <= 100;
}
function summary(v: unknown): v is SharedGrantSummary {
  if (!object(v) || !fields(v, ['id','ownerUserId','connectionId','version','nodeVersion','policy','availability','sessionId'])
    || !id(v.id) || !id(v.ownerUserId) || !id(v.connectionId) || !version(v.version) || !version(v.nodeVersion)
    || !['disabled','unverified','reauthorization_required','available'].includes(v.availability as string)
    || !(v.sessionId === null || typeof v.sessionId === 'string' && v.sessionId.length > 0 && v.sessionId.length <= 4096)) return false;
  try { parseNodeGrantPolicy(v.policy); } catch { return false; }
  // A session link never expands wildcard/agent scope or grants resource access.
  if (v.sessionId !== null) {
    const policy = v.policy as SharedGrantSummary['policy'];
    if (v.availability !== 'available' || !policy.sessionKey || policy.agentId
      || v.sessionId !== encodeHubSessionId(v.connectionId, policy.sessionKey)) return false;
  }
  return true;
}
export function validHubReceivedGrantResult(v: unknown): v is HubReceivedGrantResult {
  return v === null || object(v) && fields(v, ['userId','after','limit','page'])
    && validHubReceivedGrantCommand({userId:v.userId,after:v.after,limit:v.limit})
    && object(v.page) && fields(v.page, ['grants','nextCursor']) && Array.isArray(v.page.grants)
    && v.page.grants.length <= Number(v.limit) && v.page.grants.every(summary)
    && v.page.grants.every((g,i,a) => g.id > (v.after as string) && (i === 0 || g.id > a[i-1]!.id))
    && (v.page.nextCursor === null || cursor(v.page.nextCursor) && v.page.nextCursor > (v.after as string)
      && (!v.page.grants.length || v.page.nextCursor >= v.page.grants.at(-1)!.id));
}
export function validHubReceivedGrantReply(command: HubReceivedGrantCommand, v: unknown): v is HubReceivedGrantResult {
  return validHubReceivedGrantResult(v) && (v === null || v.userId === command.userId && v.after === command.after && v.limit === command.limit);
}
/** Preflight numeric lengths before original stores materialize text/JSON. No
 * second connection, truncation, schema change or persistent permission cache. */
export function boundReceivedGrantRows(db: DatabaseSync) {
  const inspect = (table: string, columns: string[], maximum: number) => {
    let count = 0, bytes = 0;
    const lengths = columns.map(c => `coalesce(length(CAST(${c} AS BLOB)),0) AS ${c}`).join(',');
    for (const row of db.prepare(`SELECT ${lengths} FROM ${table} LIMIT ${maximum+1}`).iterate()) {
      if (++count > maximum) throw new Error('hub_received_grants_unavailable');
      for (const n of Object.values(row)) if (!Number.isSafeInteger(n) || Number(n) < 0 || Number(n) > 65_536
        || (bytes += Number(n)) > 16*1024*1024) throw new Error('hub_received_grants_unavailable');
    }
  };
  inspect('env_connections',['id','owner_user_id','label','connector_url','capabilities_json','node_id','environment_id','environment_label'],10000);
  inspect('node_grants',['id','node_owner','connection_id','user_id','runtime','agent_id','session_key','actions'],10000);
  inspect('connector_memberships',['node_owner','connection_id','user_id','environments'],65536);
  inspect('hub_execution_issuers',['id','owner_id','connection_id','node_id','issuer_id','connector_url'],10000);
  inspect('role_grants',['grant_id','source'],10000);
}
/** Original shared-list projection, inside original identity savepoint. Its
 * maintenance writes stay with the complete owner and cannot be time-cancelled.
 * Listing is not execution admission, does not provision issuers or remote IO. */
export function executeHubReceivedGrantCommand(db: DatabaseSync, store: HubStore, actor: HubPrincipal,
  command: HubReceivedGrantCommand): HubReceivedGrantResult {
  if (!validHubReceivedGrantCommand(command)) throw new Error('hub_received_grants_unavailable');
  if (actor.userId !== command.userId) return null;
  boundReceivedGrantRows(db);
  store.roles.syncAdministrator(actor);
  const page = store.grants.received(actor.userId,command.after,command.limit);
  const grants: SharedGrantSummary[] = page.grants.filter(grant => grant.policy.actions.some(action => store.roles.permits({userId:actor.userId,
    ownerUserId:grant.ownerUserId,connectionId:grant.connectionId,administrator:actor.admin},action,grant.policy,grant.id))).map(grant => {
    const availability = grant.nodeStatus === 'disabled' ? 'disabled' : !isNodeId(grant.nodeId) ? 'unverified'
      : grant.currentNodeVersion !== grant.nodeVersion ? 'reauthorization_required' : 'available';
    let sessionId: string | null = null;
    if (availability === 'available' && grant.policy.sessionKey && !grant.policy.agentId) {
      let ref;
      try { ref = sessionRef(grant.nodeId ?? undefined,grant.policy.sessionKey); } catch { /* Original invalid legacy mapping. */ }
      if (ref && ref.runtimeId === grant.policy.runtime && store.grants.authorize({userId:actor.userId,ownerUserId:grant.ownerUserId,
        connectionId:grant.connectionId,administrator:actor.admin},'messages:read',{runtime:ref.runtimeId,sessionKey:grant.policy.sessionKey})) {
        const id = encodeHubSessionId(grant.connectionId,grant.policy.sessionKey); if (id.length <= 4096) sessionId = id;
      }
    }
    return {id:grant.id,ownerUserId:grant.ownerUserId,connectionId:grant.connectionId,version:grant.version,
      nodeVersion:grant.nodeVersion,policy:grant.policy,availability,sessionId};
  });
  return {...command,page:{grants,nextCursor:page.nextCursor}};
}
