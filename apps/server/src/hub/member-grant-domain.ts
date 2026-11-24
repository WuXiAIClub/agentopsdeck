import type { DatabaseSync } from 'node:sqlite';
import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import { NodeGrantConflict, parseNodeGrantPolicy, type NodeGrantPolicy, type NodeGrantRecord } from './node-grants.js';
import { isNodeId } from '../connector/node-identity.js';

type Target = { ownerUserId: string; connectionId: string };
export type HubGrantCommand = { action: 'authorize'; target: Target }
  | { action: 'list'; target: Target; after: string; limit: number }
  | { action: 'get'; target: Target; id: string }
  | { action: 'create'; target: Target; userId: string; nodeVersion: number; policy: NodeGrantPolicy }
  | { action: 'replace'; target: Target; id: string; version: number; nodeVersion: number; policy: NodeGrantPolicy }
  | { action: 'revoke'; target: Target; id: string; version: number; nodeVersion: number };
type Authority = { nodeVersion: number; verified: boolean; executionConfigured: boolean; creationConfigured: boolean };
export type HubGrantResult = null | { error: 'denied' | 'missing' | 'recipient' | 'managed' | 'changed' | 'unverified' | 'capacity' }
  | { target: Target; action: 'authorize'; authority: Authority }
  | { target: Target; action: 'list'; authority: Authority; grants: NodeGrantRecord[]; nextCursor: string | null }
  | { target: Target; action: 'get' | 'create' | 'replace' | 'revoke'; grant: NodeGrantRecord };
export const HUB_GRANT_RESULT_BYTES = 2 * 1024 * 1024;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && Object.keys(v).every(k => names.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= 16_384;
const version = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 1;
const target = (v: unknown): v is Target => object(v) && fields(v, ['ownerUserId', 'connectionId']) && id(v.ownerUserId) && id(v.connectionId);
const cursor = (v: unknown): v is string => typeof v === 'string' && (v === '' || /^[0-9a-f-]{36}$/.test(v));
const policy = (v: unknown): v is NodeGrantPolicy => { try { parseNodeGrantPolicy(v); return true; } catch { return false; } };
const directPolicy = (v: unknown): v is NodeGrantPolicy => policy(v)
  && (!v.actions.includes('sessions:create') || v.runtime === 'codex' && !v.agentId && !v.sessionKey);
const record = (v: unknown): v is NodeGrantRecord => object(v)
  && Object.keys(v).every(k => ['id', 'userId', 'version', 'nodeVersion', 'revoked', 'policy', 'derived'].includes(k))
  && ['id', 'userId', 'version', 'nodeVersion', 'revoked', 'policy'].every(k => k in v)
  && id(v.id) && id(v.userId) && version(v.version) && version(v.nodeVersion) && typeof v.revoked === 'boolean'
  && policy(v.policy) && (!('derived' in v) || v.derived === true);
const authority = (v: unknown): v is Authority => object(v)
  && fields(v, ['nodeVersion', 'verified', 'executionConfigured', 'creationConfigured']) && version(v.nodeVersion)
  && typeof v.verified === 'boolean' && typeof v.executionConfigured === 'boolean' && typeof v.creationConfigured === 'boolean'
  && (!v.executionConfigured || v.verified) && (!v.creationConfigured || v.executionConfigured);
export function validHubGrantCommand(v: unknown): v is HubGrantCommand {
  if (!object(v) || !target(v.target)) return false;
  if (v.action === 'authorize') return fields(v, ['action', 'target']);
  if (v.action === 'list') return fields(v, ['action', 'target', 'after', 'limit']) && cursor(v.after)
    && Number.isInteger(v.limit) && Number(v.limit) >= 1 && Number(v.limit) <= 100;
  if (v.action === 'get') return fields(v, ['action', 'target', 'id']) && id(v.id);
  if (!version(v.nodeVersion)) return false;
  if (v.action === 'create') return fields(v, ['action', 'target', 'userId', 'nodeVersion', 'policy']) && id(v.userId) && directPolicy(v.policy);
  if (!id(v.id) || !version(v.version) || v.version >= Number.MAX_SAFE_INTEGER) return false;
  return v.action === 'replace' && fields(v, ['action', 'target', 'id', 'version', 'nodeVersion', 'policy']) && directPolicy(v.policy)
    || v.action === 'revoke' && fields(v, ['action', 'target', 'id', 'version', 'nodeVersion']);
}
export function validHubGrantResult(v: unknown): v is HubGrantResult {
  if (v === null) return true;
  if (!object(v)) return false;
  if (fields(v, ['error'])) return ['denied', 'missing', 'recipient', 'managed', 'changed', 'unverified', 'capacity'].includes(v.error as string);
  if (!target(v.target)) return false;
  if (v.action === 'authorize') return fields(v, ['action', 'target', 'authority']) && authority(v.authority);
  if (v.action === 'list') return fields(v, ['action', 'target', 'authority', 'grants', 'nextCursor']) && authority(v.authority)
    && Array.isArray(v.grants) && v.grants.length <= 100 && v.grants.every(record)
    && new Set(v.grants.map(g => g.id)).size === v.grants.length
    && (v.nextCursor === null || cursor(v.nextCursor) && v.nextCursor !== '');
  return ['get', 'create', 'replace', 'revoke'].includes(v.action as string) && fields(v, ['action', 'target', 'grant']) && record(v.grant);
}
/** Owned immutable expectation; no credentials, callbacks or connection URLs. */
export function hubGrantReplyExpectation(command: HubGrantCommand): HubGrantCommand {
  return 'policy' in command ? { ...command, target: { ...command.target }, policy: { ...command.policy, actions: [...command.policy.actions] } }
    : { ...command, target: { ...command.target } };
}
const samePolicy = (a: NodeGrantPolicy, b: NodeGrantPolicy) => a.runtime === b.runtime && a.agentId === b.agentId && a.sessionKey === b.sessionKey
  && JSON.stringify([...new Set(a.actions)].sort()) === JSON.stringify([...new Set(b.actions)].sort());
export function validHubGrantReply(command: HubGrantCommand, v: unknown): v is HubGrantResult {
  if (!validHubGrantResult(v)) return false;
  if (v === null) return true;
  if ('error' in v) {
    if (v.error === 'denied') return true;
    if (v.error === 'missing') return ['get', 'replace', 'revoke'].includes(command.action);
    if (v.error === 'recipient' || v.error === 'capacity') return command.action === 'create';
    if (v.error === 'unverified') return command.action === 'create' || command.action === 'replace';
    if (v.error === 'managed' || v.error === 'changed') return ['create', 'replace', 'revoke'].includes(command.action);
    return false;
  }
  if (v.action !== command.action || v.target.ownerUserId !== command.target.ownerUserId || v.target.connectionId !== command.target.connectionId) return false;
  if (command.action === 'authorize') return v.action === 'authorize';
  if (command.action === 'list') return v.action === 'list' && v.grants.length <= command.limit
    && v.grants.every((g, i) => g.id > command.after && (i === 0 || g.id > v.grants[i - 1]!.id))
    && (v.nextCursor === null || v.grants.length === command.limit && v.nextCursor === v.grants.at(-1)!.id);
  if (!('grant' in v)) return false;
  const g = v.grant;
  if (command.action === 'get') return g.id === command.id;
  if (command.action === 'create') return g.userId === command.userId && g.version === 1 && g.nodeVersion === command.nodeVersion
    && !g.revoked && !g.derived && samePolicy(g.policy, command.policy);
  if (g.id !== command.id || g.version !== command.version + 1) return false;
  return command.action === 'revoke' ? g.revoked : !g.revoked && !g.derived && g.nodeVersion === command.nodeVersion && samePolicy(g.policy, command.policy);
}
/** Numeric SQL preflight before original SELECT * / JSON decoding. Whole
 * command refusal, not permission truncation; never opens another connection. */
export function boundOriginalRows(db: DatabaseSync, t: Target, recipient?: string) {
  const inspect = (sql: string, args: string[], maximum: number) => {
    let count = 0, bytes = 0;
    for (const row of db.prepare(sql).iterate(...args)) {
      if (++count > maximum) throw new Error('hub_grant_unavailable');
      for (const n of Object.values(row)) if (!Number.isSafeInteger(n) || Number(n) < 0 || Number(n) > 65_536 || (bytes += Number(n)) > 16 * 1024 * 1024) throw new Error('hub_grant_unavailable');
    }
  };
  const lengths = (columns: string[]) => columns.map(c => `coalesce(length(CAST(${c} AS BLOB)),0) AS ${c}`).join(',');
  inspect(`SELECT ${lengths(['id','label','connector_url','capabilities_json','node_id','environment_id','environment_label'])} FROM env_connections WHERE id=? AND owner_user_id=?`, [t.connectionId, t.ownerUserId], 1);
  inspect(`SELECT ${lengths(['id','user_id','runtime','agent_id','session_key','actions'])} FROM node_grants WHERE node_owner=? AND connection_id=? LIMIT 10001`, [t.ownerUserId,t.connectionId], 10000);
  inspect(`SELECT ${lengths(['user_id','environments'])} FROM connector_memberships WHERE node_owner=? AND connection_id=? LIMIT 4097`, [t.ownerUserId,t.connectionId], 4096);
  inspect(`SELECT ${lengths(['id','node_id','issuer_id','connector_url'])} FROM hub_execution_issuers WHERE owner_id=? AND connection_id=? LIMIT 1001`, [t.ownerUserId,t.connectionId], 1000);
  // Original create checks getUser(), which materializes the label even though
  // this command only needs existence. Bound that read before materialization.
  if (recipient !== undefined) inspect(`SELECT ${lengths(['id','label'])} FROM users WHERE id=?`, [recipient], 1);
}
/** Original owner routes, original node/version/CAS/grant policy. SQL and
 * commit uncertainty propagate; only definite original capacity refusal is
 * typed. No remote I/O, issuer provisioning, execution lease or mutation replay. */
export function executeHubGrantCommand(db: DatabaseSync, store: HubStore, actor: HubPrincipal, command: HubGrantCommand): Exclude<HubGrantResult, null> {
  if (!validHubGrantCommand(command)) throw new Error('hub_grant_unavailable');
  const t = command.target;
  if (t.ownerUserId !== actor.userId) return { error: 'denied' };
  boundOriginalRows(db, t, command.action === 'create' ? command.userId : undefined);
  const connection = store.getConnection(t.connectionId, t.ownerUserId);
  if (!connection) return { error: 'denied' };
  const nodeVersion = store.connectionAuthority(t.connectionId, t.ownerUserId)!;
  let result: Exclude<HubGrantResult, null>;
  if (command.action === 'authorize' || command.action === 'list') {
    const verified = isNodeId(connection.nodeId) && connection.status !== 'disabled', issuer = store.executionIssuers.current(t.ownerUserId, t.connectionId);
    const authority = { nodeVersion, verified, executionConfigured: verified && issuer?.nodeId === connection.nodeId,
      creationConfigured: verified && issuer?.nodeId === connection.nodeId && issuer?.creationAllowed === true };
    result = command.action === 'authorize' ? { target: { ...t }, action: command.action, authority }
      : { target: { ...t }, action: command.action, authority, ...store.grants.list(t, command.after, command.limit) };
  } else if (command.action === 'get') {
    const grant = store.grants.get(t, command.id);
    result = grant ? { target: { ...t }, action: command.action, grant } : { error: 'missing' };
  } else {
    if (command.nodeVersion !== nodeVersion) return { error: 'changed' };
    if (command.action !== 'revoke' && (!connection.nodeId || connection.status === 'disabled')) return { error: 'unverified' };
    const previous = command.action === 'create' ? undefined : store.grants.get(t, command.id);
    if (command.action !== 'create' && !previous) return { error: 'missing' };
    const userId = command.action === 'create' ? command.userId : previous!.userId;
    if (command.action === 'create' && !store.getUser(userId)) return { error: 'recipient' };
    if (command.action !== 'create' && store.roles.managedGrant(command.id)
      || command.action !== 'revoke' && !store.roles.permitsDirectGrant({ ...t, userId }, command.policy)) return { error: 'managed' };
    let grantId: string;
    if (command.action === 'create') {
      try { grantId = store.grants.create({ ...t, userId }, command.policy).id; }
      catch (error) { if (!(error instanceof NodeGrantConflict)) throw error; return { error: 'capacity' }; }
    } else {
      grantId = command.id;
      const saved = command.action === 'replace' ? store.grants.replace({ ...t, userId }, grantId, command.version, command.policy)
        : store.grants.revoke({ ...t, userId }, grantId, command.version);
      if (!saved) return { error: 'changed' };
    }
    const grant = store.grants.get(t, grantId);
    if (!grant) throw new Error('hub_grant_unavailable');
    result = { target: { ...t }, action: command.action, grant };
  }
  if (!validHubGrantReply(command, result) || Buffer.byteLength(JSON.stringify(result)) > HUB_GRANT_RESULT_BYTES) throw new Error('hub_grant_unavailable');
  return result;
}
