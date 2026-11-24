import type { DatabaseSync } from 'node:sqlite';
import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import type { NodeGrantTarget } from './node-grants.js';
import { RoleAccessConflict, type Membership, type MembershipChange } from './role-access.js';
import { connectionRecoverySnapshot } from '../storage/connection-recovery.js';

/** Fixed original membership transaction. Management never grants execution.
 * Input contains only target/data; credentials remain in the outer owner. */
export type HubMembershipCommand = { action: 'authorize'; target: NodeGrantTarget }
  | { action: 'read'; target: NodeGrantTarget }
  | { action: 'set'; target: NodeGrantTarget; membership: MembershipChange };
export type HubMembershipSnapshot = ReturnType<HubStore['roles']['snapshot']>;
export type HubMembershipResult = { target: NodeGrantTarget; snapshot: HubMembershipSnapshot }
  | { target: NodeGrantTarget; authorized: true }
  | { error: 'denied' | 'missing' | 'conflict' } | null;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const id = (v: unknown): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= 16_384 && !/[\x00-\x1f\x7f]/.test(v);
const version = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const target = (v: unknown): v is NodeGrantTarget => object(v) && fields(v, ['ownerUserId', 'connectionId', 'userId']) && Object.values(v).every(id);
const environments = (v: unknown): v is Membership['environments'] => object(v) && fields(v, ['codex', 'openclaw'])
  && ['disabled', 'developer', 'observer'].includes(v.codex as string) && ['disabled', 'observer'].includes(v.openclaw as string);
const membership = (v: unknown): v is Membership => object(v) && ['none', 'admin', 'developer', 'observer'].includes(v.role as string)
  && version(v.version) && version(v.nodeVersion) && environments(v.environments);
export function validHubMembershipCommand(v: unknown): v is HubMembershipCommand {
  if (!object(v) || !target(v.target)) return false;
  if (v.action === 'authorize' || v.action === 'read') return fields(v, ['action', 'target']);
  return v.action === 'set' && fields(v, ['action', 'target', 'membership']) && membership(v.membership)
    && fields(v.membership as unknown as Record<string, unknown>, ['role', 'version', 'nodeVersion', 'environments', 'migrateLegacy',
      ...(Object.hasOwn(v.membership, 'grantSetDigest') ? ['grantSetDigest'] : [])])
    && (!Object.hasOwn(v.membership, 'grantSetDigest') || digest((v.membership as MembershipChange).grantSetDigest))
    && v.membership.version < Number.MAX_SAFE_INTEGER && typeof (v.membership as Membership & { migrateLegacy: unknown }).migrateLegacy === 'boolean';
}
export function validHubMembershipResult(v: unknown): v is HubMembershipResult {
  if (v === null) return true;
  if (!object(v)) return false;
  if (fields(v, ['error'])) return ['denied', 'missing', 'conflict'].includes(v.error as string);
  if (!target(v.target)) return false;
  if (fields(v, ['target', 'authorized'])) return v.authorized === true;
  const s = v.snapshot;
  return fields(v, ['target', 'snapshot']) && membership(s)
    && fields(s as unknown as Record<string, unknown>, ['role', 'version', 'nodeVersion', 'environments', 'editable', 'legacyCount', 'legacyBroad', 'inherited', 'grantSetDigest'])
    && digest((s as HubMembershipSnapshot).grantSetDigest)
    && typeof (s as HubMembershipSnapshot).editable === 'boolean'
    && version((s as HubMembershipSnapshot).legacyCount) && version((s as HubMembershipSnapshot).legacyBroad)
    && (s as HubMembershipSnapshot).legacyBroad <= (s as HubMembershipSnapshot).legacyCount
    && [null, 'owner', 'hub-admin'].includes((s as HubMembershipSnapshot).inherited);
}
/** Minimal expected data, no principal/credentials/labels retained in waiters. */
export function hubMembershipReplyExpectation(v: HubMembershipCommand): HubMembershipCommand {
  return v.action === 'set' ? { action: v.action, target: { ...v.target }, membership: { ...v.membership, environments: { ...v.membership.environments } } }
    : { action: v.action, target: { ...v.target } };
}
export function validHubMembershipReply(expected: HubMembershipCommand, v: unknown): v is HubMembershipResult {
  if (!validHubMembershipResult(v)) return false;
  if (v === null) return true;
  // An ACK must belong to this exact command, including negative outcomes.
  // A missing recipient is a read result; set returns a typed policy conflict.
  // Never classify an impossible mutation ACK as a definite missing resource.
  if ('error' in v) return v.error === 'denied'
    || (v.error === 'conflict' ? expected.action === 'set' : expected.action === 'read');
  if (Object.keys(expected.target).some(k => expected.target[k as keyof NodeGrantTarget] !== v.target[k as keyof NodeGrantTarget])) return false;
  if (expected.action === 'authorize') return 'authorized' in v;
  if (!('snapshot' in v)) return false;
  if (expected.action === 'read') return true;
  const s = v.snapshot, m = expected.membership;
  return s.role === m.role && s.version === m.version + 1 && s.nodeVersion === m.nodeVersion
    && s.environments.codex === (m.role === 'none' ? 'disabled' : m.environments.codex)
    && s.environments.openclaw === (m.role === 'none' ? 'disabled' : m.environments.openclaw);
}
/** Bound original target-specific scans before decoding untrusted old TEXT.
 * Refusal is whole-command; no grant/membership truncation or SQL supplied by RPC. */
function boundMembership(db: DatabaseSync, t: NodeGrantTarget) {
  const args = [t.ownerUserId, t.connectionId, t.userId];
  const member = db.prepare('SELECT length(CAST(environments AS BLOB)) AS n FROM connector_memberships WHERE node_owner=? AND connection_id=? AND user_id=?').get(...args);
  if (member && (!version(member.n) || member.n > 16_384)) throw new Error('hub_membership_unavailable');
  const statement = db.prepare(`SELECT length(CAST(id AS BLOB)) AS i, length(CAST(actions AS BLOB)) AS a,
    coalesce(length(CAST(runtime AS BLOB)),0) AS r, coalesce(length(CAST(agent_id AS BLOB)),0) AS g,
    coalesce(length(CAST(session_key AS BLOB)),0) AS s FROM node_grants
    WHERE node_owner=? AND connection_id=? AND user_id=? AND revoked=0 LIMIT 4097`);
  let count = 0, bytes = 0;
  for (const row of statement.iterate(...args)) {
    if (++count > 4096) throw new Error('hub_membership_unavailable');
    for (const n of Object.values(row)) {
      if (!version(n) || n > 16_384 || (bytes += n) > 16 * 1024 * 1024) throw new Error('hub_membership_unavailable');
    }
  }
}
function boundConnection(db: DatabaseSync, t: NodeGrantTarget) {
  const columns = ['id', 'owner_user_id', 'label', 'connector_url', 'capabilities_json', 'node_id', 'environment_id', 'environment_label'];
  const row = db.prepare(`SELECT ${columns.map((c, i) => `coalesce(length(CAST(${c} AS BLOB)),0) AS n${i}`).join(',')}
    FROM env_connections WHERE id=? AND owner_user_id=?`).get(t.connectionId, t.ownerUserId);
  if (!row) return;
  for (const [i, column] of columns.entries()) {
    const n = row['n' + i];
    if (!version(n) || n > (column === 'capabilities_json' ? 65_536 : 16_384)) throw new Error('hub_membership_unavailable');
  }
}
/** Called inside fresh identity/scope savepoint on the complete original store. */
export function executeHubMembershipCommand(db: DatabaseSync, store: HubStore, actor: HubPrincipal, command: HubMembershipCommand): Exclude<HubMembershipResult, null> {
  if (!validHubMembershipCommand(command)) throw new Error('hub_membership_unavailable');
  const t = command.target;
  boundConnection(db, t);
  // Check the actor's legacy membership size before the original canManage parse.
  boundMembership(db, { ...t, userId: actor.userId });
  if (!store.roles.canManage(actor, t) || !store.getConnection(t.connectionId, t.ownerUserId)) return { error: 'denied' };
  if (command.action === 'authorize') return { target: { ...t }, authorized: true };
  if (!store.getUser(t.userId)) return { error: command.action === 'set' ? 'conflict' : 'missing' };
  boundMembership(db, t);
  try {
    const snapshot = command.action === 'read' ? store.roles.snapshot(actor, t) : store.roles.save(actor, t, command.membership);
    const result = { target: { ...t }, snapshot };
    if (!validHubMembershipReply(command, result)) throw new Error('hub_membership_unavailable');
    return result;
  } catch (error) {
    // A typed policy failure is definite only after original cleanup succeeded.
    // Nested rollback failure must reach the outer identity owner as unknown.
    if (command.action !== 'set' || !(error instanceof RoleAccessConflict) || connectionRecoverySnapshot(db).state !== 'ready') throw error;
    return { error: 'conflict' };
  }
}
