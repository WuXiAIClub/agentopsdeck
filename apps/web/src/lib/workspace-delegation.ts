import type { BoardTask } from '@agentopsdeck/shared';
export type DelegationSelection = { groupId?: string; tags: string[]; tagMode: 'all' | 'any' };
export type DelegationInput = { batchId: string; selection: DelegationSelection; taskIds: string[];
  fields: ('status' | 'detail')[]; expiresAt: number };
export type DelegationBatch = { batchId: string; state: 'prepared' | 'confirmed' | 'cancelled'; grantExpiresAt: number;
  preview: { expiresAt: number; selection: DelegationSelection; resource: { resourceId: string; tasks: BoardTask[]; fields: ('status' | 'detail')[] } };
  members: { requestId: string; member: { sessionId: string; runtime: string }; state: 'prepared' | 'dispatching' | 'installed'
    | 'rejected' | 'unknown' | 'cancelled' | 'cleanup_pending' | 'revoked' }[] };
export function validDelegationBatch(value: DelegationBatch, id: string, resourceId: string): boolean {
  return !!value && value.batchId === id && ['prepared', 'confirmed', 'cancelled'].includes(value.state)
    && Number.isSafeInteger(value.grantExpiresAt) && !!value.preview && Number.isSafeInteger(value.preview.expiresAt)
    && value.preview.resource?.resourceId === resourceId && Array.isArray(value.preview.resource.tasks)
    && Array.isArray(value.preview.resource.fields) && value.preview.resource.fields.every(f => f === 'status' || f === 'detail')
    && Array.isArray(value.members) && value.members.length > 0 && value.members.length <= 32
    && new Set(value.members.map(m => m.requestId)).size === value.members.length
    && value.members.every(m => typeof m.requestId === 'string' && typeof m.member?.sessionId === 'string'
      && ['prepared', 'dispatching', 'installed', 'rejected', 'unknown', 'cancelled', 'cleanup_pending', 'revoked'].includes(m.state));
}
