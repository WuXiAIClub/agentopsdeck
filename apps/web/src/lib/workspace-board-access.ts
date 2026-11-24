/** Owner-facing metadata only. Never persist the once-only issuance token. */
export type BoardGrantInput = { taskIds: string[]; fields: ('status' | 'detail')[]; expiresAt: number };
export type BoardGrant = BoardGrantInput & { id: string; resourceId: string; createdAt: number; revokedAt: number | null };
export type BoardAuditEvent = {
  sequence: number; capabilityId: string; event: string; mutationId: string | null; revision: number | null; createdAt: number;
};
export function boardGrantState(grant: BoardGrant, now = Date.now()): 'active' | 'expired' | 'revoked' {
  return grant.revokedAt !== null ? 'revoked' : grant.expiresAt <= now ? 'expired' : 'active';
}
