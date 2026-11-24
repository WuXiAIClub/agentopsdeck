import type { AccessConnection, ConnectorMembership, HubLoginKey, HubRoleState } from '../api.js';

/** A render identity includes account epoch, selected user and refresh generation.
 * Moving A -> B -> A must not publish the first A's result into the second A. */
export class AccessViewEpoch {
  private identity = '';
  private generation = 0;
  enter(identity: string) {
    if (identity !== this.identity) { this.identity = identity; this.generation++; }
    const generation = this.generation;
    return { generation, current: () => generation === this.generation };
  }
}

/** One write only. Discard late results without assuming the server rejected
 * the operation, and never retry a write whose acknowledgement is unknown. */
export async function writeCurrentAccess<T>(current: () => boolean, write: () => Promise<T>): Promise<T | null> {
  if (!current()) return null;
  const result = await write();
  return current() ? result : null;
}

/** Copy is an explicit action, never a side effect of key issuance. */
export async function copyCurrentAccessKey(current: () => boolean, token: string,
  clipboard: { writeText(value: string): Promise<void> } | undefined): Promise<boolean> {
  if (!current()) return false;
  if (!clipboard) throw new Error('Clipboard unavailable');
  await clipboard.writeText(token);
  return current();
}

export type AccessRevocationPort = {
  hubLoginKeys(userId: string): Promise<{ keys: HubLoginKey[] }>;
  hubRole(userId: string): Promise<HubRoleState>;
  connectorMembership(connection: AccessConnection, userId: string): Promise<ConnectorMembership>;
  hubRevokeLoginKey(userId: string, keyId: string): Promise<{ ok: boolean }>;
  saveHubRole(userId: string, payload: HubRoleState): Promise<HubRoleState>;
  saveConnectorMembership(connection: AccessConnection, userId: string, payload: {
    role: 'none'; environments: { codex: 'disabled'; openclaw: 'disabled' };
    version: number; nodeVersion: number; migrateLegacy: boolean; grantSetDigest: string;
  }): Promise<ConnectorMembership>;
};
export class ReviewedAccessFailure extends Error {
  constructor(readonly confirmed: number, readonly total: number, readonly pending: string, cause: unknown) {
    super(`Access changes stopped (${confirmed}/${total} confirmed); ${pending}: ${cause instanceof Error ? cause.message : 'result unavailable'}. Refresh and review before another change.`, { cause });
  }
}

/** This is explicitly a reviewed, non-atomic set of changes, NOT user deletion
 * or a global suspension. Reads fail closed before any write. No automatic retry,
 * no hiding the user, no assumption that unknown writes were rejected. */
export async function revokeReviewedAccess(port: AccessRevocationPort, userId: string,
  connections: readonly AccessConnection[], current: () => boolean,
  confirm: (summary: { keys: number; memberships: number; legacy: number; demote: boolean }) => Promise<boolean>) {
  const check = () => { if (!current()) throw new Error('Permission view or account changed'); };
  check();
  if (userId === 'default' || connections.some(c => c.ownerUserId === userId)) throw new Error('Owner access cannot be revoked here');
  const keys = await port.hubLoginKeys(userId); check();
  const role = await port.hubRole(userId); check();
  const reviewed: Array<{ connection: AccessConnection; membership: ConnectorMembership }> = [];
  for (const connection of connections) {
    const membership = await port.connectorMembership(connection, userId); check();
    if (membership.inherited === 'owner') throw new Error('Owner access cannot be revoked here');
    // Save none even if already none: exact-session grants/shares may still exist.
    if (!membership.editable || !/^[a-f0-9]{64}$/.test(membership.grantSetDigest ?? '')) {
      throw new Error('Reviewed membership unavailable or not editable');
    }
    reviewed.push({ connection, membership });
  }
  if (!await confirm({ keys: keys.keys.length, memberships: reviewed.length,
    legacy: reviewed.reduce((sum, m) => sum + m.membership.legacyCount, 0), demote: role.role === 'admin' })) return null;
  check();
  const total = keys.keys.length + reviewed.length + (role.role === 'admin' ? 1 : 0);
  let confirmed = 0, pending = '';
  try {
    for (const key of keys.keys) {
      pending = 'login key'; check();
      const result = await port.hubRevokeLoginKey(userId, key.id);
      if (result.ok !== true) throw new Error('Revocation not confirmed');
      confirmed++; check();
    }
    for (const { connection, membership } of reviewed) {
      pending = `Connector ${connection.label || connection.id}`; check();
      const result = await port.saveConnectorMembership(connection, userId, { role: 'none',
        environments: { codex: 'disabled', openclaw: 'disabled' }, version: membership.version,
        nodeVersion: connection.nodeVersion, migrateLegacy: membership.legacyCount > 0,
        grantSetDigest: membership.grantSetDigest! });
      if (result.role !== 'none' || result.environments.codex !== 'disabled' || result.environments.openclaw !== 'disabled') {
        throw new Error('Revocation not confirmed');
      }
      confirmed++; check();
    }
    if (role.role === 'admin') {
      pending = 'Hub role'; check();
      const result = await port.saveHubRole(userId, { role: 'member', version: role.version });
      if (result.role !== 'member') throw new Error('Demotion not confirmed');
      confirmed++; check();
    }
  } catch (cause) { throw new ReviewedAccessFailure(confirmed, total, pending, cause); }
  return { confirmed, total };
}
