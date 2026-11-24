import { createHash } from 'node:crypto';
import { isNodeId } from '../connector/node-identity.js';
import type { ExecutionLease } from './execution-leases.js';
import type { ExecutionIssuerSnapshot } from './execution-issuers.js';
import type { HubStore } from './hub-store.js';
import { validHubExecutionLeaseResult } from './member-execution-lease-domain.js';

export const EXECUTION_ISSUER_PATHS = ['/execution-grants', '/execution-grants/revoke', '/execution-grants/usage'] as const;
export type ExecutionIssuerPath = typeof EXECUTION_ISSUER_PATHS[number];
export type HubExecutionIssuerCommand = { action: 'open'; id: number; binding: string }
  | { action: 'check'; id: number; binding: string; fingerprint: string; path: ExecutionIssuerPath; method: 'POST' };
export type HubExecutionIssuerResult = { action: 'open'; id: number; binding: string; fingerprint: string; snapshot: ExecutionIssuerSnapshot }
  | { action: 'check'; id: number; binding: string; fingerprint: string; allowed: true };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && Object.keys(v).every(k => names.includes(k));
const hash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const text = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= max && !/[\x00-\x1f\x7f]/.test(v);
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** Stable across prepareIssue, ACK and revocation. Mutable generation is not credential identity. */
export function executionIssuerBinding(lease: ExecutionLease): string {
  if (!validHubExecutionLeaseResult({ action: 'get', lease })) throw new Error('Invalid execution issuer lease');
  const p = lease.proof;
  return digest([lease.id, lease.grantKey, lease.nodeId, lease.issuerId, p.ownerUserId, p.connectionId,
    p.userId, p.administrator ?? false, p.grantId, p.version, p.nodeVersion, p.action,
    p.resource.runtime, p.resource.sessionKey, [...lease.actions].sort()]);
}
export function validExecutionIssuerSnapshot(v: unknown): v is ExecutionIssuerSnapshot {
  if (!object(v) || !fields(v, ['origin','token','kind','connectionId','nodeId','issuerId','version'])
    || !text(v.origin) || !text(v.token) || !text(v.connectionId, 16384) || !isNodeId(v.nodeId)
    || typeof v.issuerId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(v.issuerId)
    || !positive(v.version) || !['local','remote'].includes(v.kind as string)) return false;
  // Original all-role connections persist this exact sentinel, not an HTTP
  // address. It can only select the private in-process transport; never allow
  // arbitrary local URLs or a remote row to acquire that transport.
  if (v.origin === 'local://aod-connector') return v.kind === 'local';
  try { const u = new URL(v.origin); return ['http:','https:'].includes(u.protocol) && !u.username && !u.password; }
  catch { return false; }
}
export function validHubExecutionIssuerCommand(v: unknown): v is HubExecutionIssuerCommand {
  if (!object(v) || !positive(v.id) || !hash(v.binding)) return false;
  if (v.action === 'open') return fields(v, ['action','id','binding']);
  return v.action === 'check' && fields(v, ['action','id','binding','fingerprint','path','method'])
    && hash(v.fingerprint) && v.method === 'POST' && EXECUTION_ISSUER_PATHS.includes(v.path as ExecutionIssuerPath);
}
export function validHubExecutionIssuerResult(v: unknown): v is HubExecutionIssuerResult {
  if (!object(v) || !positive(v.id) || !hash(v.binding) || !hash(v.fingerprint)) return false;
  if (v.action === 'open') return fields(v, ['action','id','binding','fingerprint','snapshot']) && validExecutionIssuerSnapshot(v.snapshot)
    && v.fingerprint === digest([v.binding, v.snapshot.origin, v.snapshot.token, v.snapshot.kind,
      v.snapshot.connectionId, v.snapshot.nodeId, v.snapshot.issuerId, v.snapshot.version]);
  return v.action === 'check' && fields(v, ['action','id','binding','fingerprint','allowed']) && v.allowed === true;
}
export function validHubExecutionIssuerReply(c: HubExecutionIssuerCommand, v: unknown): v is HubExecutionIssuerResult {
  return validHubExecutionIssuerResult(v) && v.action === c.action && v.id === c.id && v.binding === c.binding
    && (c.action === 'open' || v.fingerprint === c.fingerprint);
}
export async function executeHubExecutionIssuerCommand(owner: HubStore, c: HubExecutionIssuerCommand): Promise<HubExecutionIssuerResult> {
  if (!validHubExecutionIssuerCommand(c)) throw new Error('Invalid execution issuer command');
  // Reuse the same owner's persisted-byte preflight before SELECT / JSON.parse.
  // This is a fresh read, not cached authority for a later transaction.
  const result = await owner.executionLeaseCommand({ action: 'get', id: c.id });
  const lease = 'lease' in result ? result.lease : null;
  if (!lease || executionIssuerBinding(lease) !== c.binding) throw new Error('Execution issuer binding unavailable');
  const s = owner.executionIssuers.snapshotFor(lease);
  if (!validExecutionIssuerSnapshot(s)) throw new Error('Execution issuer snapshot unavailable');
  const fingerprint = digest([c.binding, s.origin, s.token, s.kind, s.connectionId, s.nodeId, s.issuerId, s.version]);
  if (c.action === 'open') return { action: c.action, id: c.id, binding: c.binding, fingerprint, snapshot: s };
  if (fingerprint !== c.fingerprint) throw new Error('Execution issuer binding changed');
  // Retired credentials remain usable only for original durable revocation.
  if (c.path !== '/execution-grants/revoke'
    && owner.executionIssuers.current(lease.proof.ownerUserId, lease.proof.connectionId)?.version !== s.version) {
    throw new Error('Execution issuer retired');
  }
  return { action: c.action, id: c.id, binding: c.binding, fingerprint, allowed: true };
}
