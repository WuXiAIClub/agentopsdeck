import type { BoardGrantInput } from './workspace-board-access.js';
import type { TranslationKey } from './translations.js';
export type BoardSessionBinding = { requestId: string; boardId: string; sessionId: string; capabilityId: string;
  state: 'prepared' | 'installed' | 'uncertain' | 'revoked' | 'expired' | 'unavailable'; expiresAt: number; createdAt: number };
export type BoardSessionBindingInput = { requestId: string; sessionId: string; grant: BoardGrantInput };
export const bindingStateLabel: Record<BoardSessionBinding['state'], TranslationKey> = {
  prepared: 'Binding prepared', installed: 'Session bound', uncertain: 'Binding outcome unconfirmed',
  revoked: 'Revoked', expired: 'Expired grant', unavailable: 'Binding unavailable',
};
