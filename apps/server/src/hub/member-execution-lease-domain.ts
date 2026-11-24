import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { sessionRuntimeId } from '@agentopsdeck/shared';
import { EXECUTION_ACTIONS, type ExecutionAction, type ExecutionGrantRef } from '../connector/execution-grants.js';
import { isNodeId } from '../connector/node-identity.js';
import type { NodeGrantProof } from './node-grants.js';
import type { ExecutionLease, HubExecutionLeases } from './execution-leases.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';

type ActorTarget = Parameters<HubExecutionLeases['nextQueueActor']>[0];
export type HubExecutionLeaseCommand =
  | { action: 'reserve'; proof: NodeGrantProof; nodeId: string; issuerId: string; actions: ExecutionAction[] }
  | { action: 'authorized'; proof: NodeGrantProof; actions: ExecutionAction[] }
  | { action: 'get' | 'prepareIssue' | 'revoke'; id: number }
  | { action: 'acknowledgeRevoke'; id: number; throughVersion: number }
  | { action: 'acknowledgeIssue'; id: number; ref: ExecutionGrantRef; expiresAt: number }
  | { action: 'revocations'; after: number; limit: number }
  | { action: 'usageDue'; limit: number }
  | { action: 'usageQuiet'; id: number; version: number }
  | { action: 'nextQueueActor'; target: ActorTarget; afterIssuer: string };
export type HubExecutionLeaseResult =
  | { action: 'reserve' | 'get' | 'prepareIssue' | 'nextQueueActor'; lease: ExecutionLease | null }
  | { action: 'authorized' | 'acknowledgeIssue' | 'acknowledgeRevoke' | 'usageQuiet'; value: boolean }
  | { action: 'revoke'; value: null }
  | { action: 'revocations'; leases: ExecutionLease[] }
  | { action: 'usageDue'; page: Array<{ lease: ExecutionLease; version: number }> };
export const HUB_EXECUTION_LEASE_COMMAND_BYTES = 65_536;
export const HUB_EXECUTION_LEASE_RESULT_BYTES = 4 * 1024 * 1024;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && Object.keys(v).every(k => names.includes(k));
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= 16_384 && !/[\x00-\x1f\x7f]/.test(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const nonnegative = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const actions = (v: unknown): v is ExecutionAction[] => Array.isArray(v) && v.length > 0 && v.length <= EXECUTION_ACTIONS.length
  && new Set(v).size === v.length && v.every(a => EXECUTION_ACTIONS.includes(a));
function proof(v: unknown): v is NodeGrantProof {
  if (!object(v) || !Object.keys(v).every(k => ['ownerUserId','connectionId','userId','administrator','grantId','version','nodeVersion','action','resource'].includes(k))
    || !['ownerUserId','connectionId','userId','grantId'].every(k => text(v[k])) || !positive(v.version) || !positive(v.nodeVersion)
    || !EXECUTION_ACTIONS.includes(v.action as ExecutionAction) || 'administrator' in v && typeof v.administrator !== 'boolean') return false;
  const r = v.resource;
  return object(r) && fields(r, ['runtime','sessionKey']) && text(r.sessionKey) && Buffer.byteLength(r.sessionKey) <= 2048
    && (r.runtime === 'codex' || r.runtime === 'openclaw') && r.runtime === sessionRuntimeId(r.sessionKey);
}
const issuer = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(v);
const ref = (v: unknown): v is ExecutionGrantRef => object(v) && fields(v, ['id','actorId'])
  && typeof v.id === 'string' && /^[0-9a-f-]{36}$/.test(v.id) && typeof v.actorId === 'string' && /^actor_[0-9a-f]{64}$/.test(v.actorId);
export function validHubExecutionLeaseCommand(v: unknown): v is HubExecutionLeaseCommand {
  if (!object(v)) return false;
  if (v.action === 'reserve' || v.action === 'authorized') return fields(v, v.action === 'reserve'
    ? ['action','proof','nodeId','issuerId','actions'] : ['action','proof','actions']) && proof(v.proof) && actions(v.actions)
    && v.actions.includes(v.proof.action as ExecutionAction) && (v.action === 'authorized' || isNodeId(v.nodeId) && issuer(v.issuerId));
  if (['get','prepareIssue','revoke'].includes(v.action as string)) return fields(v, ['action','id']) && positive(v.id);
  if (v.action === 'acknowledgeRevoke') return fields(v, ['action','id','throughVersion']) && positive(v.id) && positive(v.throughVersion);
  if (v.action === 'acknowledgeIssue') return fields(v, ['action','id','ref','expiresAt']) && positive(v.id) && ref(v.ref) && nonnegative(v.expiresAt);
  if (v.action === 'usageQuiet') return fields(v, ['action','id','version']) && positive(v.id) && nonnegative(v.version);
  if (v.action === 'usageDue') return fields(v, ['action','limit']) && positive(v.limit) && v.limit <= 32;
  if (v.action === 'revocations') return fields(v, ['action','after','limit']) && nonnegative(v.after) && positive(v.limit) && v.limit <= 128;
  if (v.action !== 'nextQueueActor' || !fields(v, ['action','target','afterIssuer']) || !(v.afterIssuer === '' || issuer(v.afterIssuer))) return false;
  const t = v.target;
  return object(t) && fields(t, ['ownerUserId','connectionId','userId','sessionKey','nodeId'])
    && ['ownerUserId','connectionId','userId','sessionKey'].every(k => text(t[k])) && Buffer.byteLength(t.sessionKey as string) <= 2048
    && isNodeId(t.nodeId) && ['codex','openclaw'].includes(sessionRuntimeId(t.sessionKey as string));
}
function lease(v: unknown): v is ExecutionLease {
  return object(v) && Object.keys(v).every(k => ['id','grantKey','version','nodeId','issuerId','proof','actions','expiresAt','state','ref'].includes(k))
    && ['id','grantKey','version','nodeId','issuerId','proof','actions','expiresAt','state'].every(k => k in v)
    && positive(v.id) && positive(v.version) && typeof v.grantKey === 'string' && /^[0-9a-f]{64}$/.test(v.grantKey)
    && isNodeId(v.nodeId) && issuer(v.issuerId) && proof(v.proof) && actions(v.actions) && v.actions.includes(v.proof.action as ExecutionAction)
    && nonnegative(v.expiresAt) && ['pending','active','revoking','revoked'].includes(v.state as string) && (!('ref' in v) || ref(v.ref));
}
export function validHubExecutionLeaseResult(v: unknown): v is HubExecutionLeaseResult {
  if (!object(v)) return false;
  if (['reserve','get','prepareIssue','nextQueueActor'].includes(v.action as string)) return fields(v, ['action','lease'])
    && (v.lease === null ? v.action === 'get' || v.action === 'nextQueueActor' : lease(v.lease));
  if (['authorized','acknowledgeIssue','acknowledgeRevoke','usageQuiet'].includes(v.action as string)) return fields(v, ['action','value']) && typeof v.value === 'boolean';
  if (v.action === 'revoke') return fields(v, ['action','value']) && v.value === null;
  if (v.action === 'revocations') return fields(v, ['action','leases']) && Array.isArray(v.leases) && v.leases.length <= 128
    && v.leases.every(lease) && v.leases.every((l, i, all) => l.state === 'revoking' && (!i || l.id > all[i-1]!.id));
  return v.action === 'usageDue' && fields(v, ['action','page']) && Array.isArray(v.page) && v.page.length <= 32
    && v.page.every(p => object(p) && fields(p, ['lease','version']) && lease(p.lease) && p.lease.ref !== undefined
      && ['pending','active'].includes(p.lease.state) && nonnegative(p.version))
    && new Set(v.page.map(p => p.lease.id)).size === v.page.length;
}
export function validHubExecutionLeaseReply(c: HubExecutionLeaseCommand, v: unknown): v is HubExecutionLeaseResult {
  if (!validHubExecutionLeaseResult(v) || c.action !== v.action) return false;
  if ('lease' in v && v.lease) {
    const l = v.lease;
    if ('id' in c) return l.id === c.id;
    if (c.action === 'reserve') return l.nodeId === c.nodeId && l.issuerId === c.issuerId
      && ['ownerUserId','connectionId','userId','grantId','version','nodeVersion'].every(k => l.proof[k as keyof NodeGrantProof] === c.proof[k as keyof NodeGrantProof])
      && l.proof.resource.runtime === c.proof.resource.runtime && l.proof.resource.sessionKey === c.proof.resource.sessionKey
      && JSON.stringify([...l.actions].sort()) === JSON.stringify([...c.actions].sort());
    if (c.action === 'nextQueueActor') return l.ref !== undefined && l.issuerId > c.afterIssuer && l.nodeId === c.target.nodeId
      && l.proof.ownerUserId === c.target.ownerUserId && l.proof.connectionId === c.target.connectionId
      && l.proof.userId === c.target.userId && l.proof.resource.sessionKey === c.target.sessionKey;
  }
  if (c.action === 'revocations' && 'leases' in v) return v.leases.length <= c.limit && v.leases.every(l => l.id > c.after);
  if (c.action === 'usageDue' && 'page' in v) return v.page.length <= c.limit;
  return true;
}
/** Bound original SELECT * / JSON parses before materialization. No generic
 * SQL crosses RPC. Invalid legacy records fail closed, never truncate authority. */
function preflight(db: DatabaseSync, c: HubExecutionLeaseCommand, at = Date.now()) {
  const inspectProof = (p: NodeGrantProof) => {
    for (const [sql, args] of [
      ['SELECT coalesce(length(CAST(actions AS BLOB)),0) AS n FROM node_grants WHERE id=? AND node_owner=? AND connection_id=? AND user_id=?', [p.grantId,p.ownerUserId,p.connectionId,p.userId]],
      ['SELECT coalesce(length(CAST(environments AS BLOB)),0) AS n FROM connector_memberships WHERE node_owner=? AND connection_id=? AND user_id=?', [p.ownerUserId,p.connectionId,p.userId]],
    ] as const) for (const row of db.prepare(sql).iterate(...args)) if (!nonnegative(row.n) || row.n > 16_384) throw Error('hub_execution_lease_unavailable');
  };
  if ('proof' in c) inspectProof(c.proof);
  let where: string, args: (string | number)[], limit = 1;
  if ('id' in c) { where = 'id=?'; args = [c.id]; }
  else if (c.action === 'reserve') {
    where = 'grant_key=? ORDER BY version DESC';
    args = [createHash('sha256').update(JSON.stringify([c.proof.ownerUserId,c.proof.connectionId,c.nodeId,c.issuerId,c.proof.grantId,c.proof.userId,c.proof.resource.runtime,c.proof.resource.sessionKey])).digest('hex')];
  } else if (c.action === 'revocations') { where = "state='revoking' AND id>? ORDER BY id"; args = [c.after]; limit = c.limit; }
  else if (c.action === 'usageDue') { where = "usage_pending=1 AND usage_after<=? AND state IN ('active','pending') AND ref IS NOT NULL ORDER BY usage_after,id"; args = [at]; limit = c.limit; }
  else if (c.action === 'nextQueueActor') {
    where = "owner_id=? AND connection_id=? AND principal_id=? AND node_id=? AND json_extract(proof,'$.resource.sessionKey')=? AND issuer_id>? AND ref IS NOT NULL ORDER BY issuer_id,id DESC";
    args = [c.target.ownerUserId,c.target.connectionId,c.target.userId,c.target.nodeId,c.target.sessionKey,c.afterIssuer];
  } else return;
  const columns = ['grant_key','node_id','issuer_id','grant_id','owner_id','connection_id','principal_id','proof','actions','ref'];
  const lens = columns.map(k => `coalesce(length(CAST(${k} AS BLOB)),0) AS ${k}`).join(',');
  for (const r of db.prepare(`SELECT id,${lens} FROM hub_execution_leases WHERE ${where} LIMIT ?`).iterate(...args, limit)) {
    let bytes = 0;
    for (const k of columns) if (!nonnegative(r[k]) || (bytes += r[k] as number) > 16_384) throw Error('hub_execution_lease_unavailable');
    if (c.action === 'usageDue') {
      const row = db.prepare('SELECT * FROM hub_execution_leases WHERE id=?').get(r.id!)!;
      const decoded: unknown = { id:row.id,grantKey:row.grant_key,version:row.version,nodeId:row.node_id,issuerId:row.issuer_id,
        proof:JSON.parse(row.proof as string),actions:JSON.parse(row.actions as string),expiresAt:row.expires_at,state:row.state,
        ...(row.ref ? { ref:JSON.parse(row.ref as string) } : {}) };
      if (!lease(decoded) || !nonnegative(row.usage_version)) throw Error('hub_execution_lease_unavailable');
    }
    if (c.action === 'prepareIssue' || c.action === 'acknowledgeIssue') {
      const row = db.prepare('SELECT proof FROM hub_execution_leases WHERE id=?').get(r.id!);
      const p: unknown = JSON.parse(row!.proof as string);
      if (!proof(p)) throw Error('hub_execution_lease_unavailable');
      inspectProof(p);
    }
  }
}
/** Trusted internal port, not HTTP permission. Original NodeGrants/RoleAccess
 * revalidation and lease/version/CAS rules remain authoritative. Capacity
 * admission yields only outside SQL; callback stays inside this original owner. */
export async function executeHubExecutionLeaseCommand(db: DatabaseSync, leases: HubExecutionLeases, c: HubExecutionLeaseCommand): Promise<HubExecutionLeaseResult> {
  if (!validHubExecutionLeaseCommand(c)) throw Error('hub_execution_lease_unavailable');
  preflight(db, c);
  let value: HubExecutionLeaseResult;
  switch (c.action) {
    case 'reserve': value = { action: c.action, lease: leases.reserve(c.proof,c.nodeId,c.issuerId,c.actions) }; break;
    case 'get': value = { action: c.action, lease: leases.get(c.id) ?? null }; break;
    case 'prepareIssue': value = { action: c.action, lease: leases.prepareIssue(c.id) }; break;
    case 'nextQueueActor': value = { action: c.action, lease: leases.nextQueueActor(c.target,c.afterIssuer) ?? null }; break;
    case 'authorized': value = { action: c.action, value: leases.authorized(c.proof,c.actions) }; break;
    case 'acknowledgeIssue': value = { action: c.action, value: leases.acknowledgeIssue(c.id,c.ref,c.expiresAt) }; break;
    case 'revoke': leases.revoke(c.id); value = { action: c.action, value: null }; break;
    case 'acknowledgeRevoke': value = { action: c.action, value: leases.acknowledgeRevoke(c.id,c.throughVersion) }; break;
    case 'revocations': value = { action: c.action, leases: leases.revocations(c.after,c.limit) }; break;
    case 'usageQuiet': value = { action: c.action, value: leases.usageQuiet(c.id,c.version) }; break;
    case 'usageDue': value = { action: c.action, page: await leases.usageDueAsync(c.limit, () => preflight(db,c), at => preflight(db,c,at)) }; break;
  }
  if (!validHubExecutionLeaseReply(c,value) || Buffer.byteLength(JSON.stringify(value)) > HUB_EXECUTION_LEASE_RESULT_BYTES) throw Error('hub_execution_lease_unavailable');
  return value;
}
export const executionLeaseOwnerSteps = Object.freeze({ reserve: 52, get: 53, prepareIssue: 54, acknowledgeIssue: 55,
  revoke: 56, acknowledgeRevoke: 57, revocations: 58, authorized: 59, usageDue: 60, usageQuiet: 61, nextQueueActor: 62 });
/** settled means the domain call ended, not that a remote ACK committed. */
export async function observeHubExecutionLeaseCommand(db: DatabaseSync, leases: HubExecutionLeases, c: HubExecutionLeaseCommand) {
  let trace: ReturnType<typeof performanceDiagnostics.start> | undefined, failed = true;
  const observe = (f: () => void) => { try { f(); } catch { /* Observation only. */ } };
  observe(() => { trace = performanceDiagnostics.start('hub-member-sqlite-owner'); trace.add('step',executionLeaseOwnerSteps[c.action]); });
  const warning = setTimeout(() => observe(() => trace?.reportPending({ pending: 1 })),30_000); warning.unref();
  try { const value = await executeHubExecutionLeaseCommand(db,leases,c); failed = false; observe(() => trace?.add('settled',1)); return value; }
  catch (error) { observe(() => trace?.add('unknown',1)); throw error; }
  finally { clearTimeout(warning); observe(() => trace?.finish(failed)); }
}
