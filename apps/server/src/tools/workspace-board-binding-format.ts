import { validBoardUuid } from '@agentopsdeck/shared';
import { createHash } from 'node:crypto';
import type { BoardToolCredential } from './workspace-board-cli.js';

export function boardBindingFingerprint(runtime: string, sessionId: string, credential: BoardToolCredential): string {
  return createHash('sha256').update(JSON.stringify({ runtime, sessionId, endpoint: credential.endpoint,
    token: credential.token, expiresAt: credential.expiresAt })).digest('hex');
}

export type ManagedBoardBinding = { id: string; owner: string; fingerprint: string };
export function validManagedBoardBinding(value: unknown): value is ManagedBoardBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 3 && validBoardUuid(v.id)
    && typeof v.owner === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(v.owner)
    && typeof v.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(v.fingerprint);
}
