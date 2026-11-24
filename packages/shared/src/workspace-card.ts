import { validBoardUuid } from './workspace-board.js';

export const CARD_TONES = ['neutral', 'blue', 'green', 'yellow', 'red', 'purple'] as const;
export type CardTone = typeof CARD_TONES[number];
export type CardContent = { title: string; value: string; detail: string; tone: CardTone; progress: number | null };
export type CardDocument = CardContent & { resourceId: string; revision: number; updatedAt: number | null };
export type CardWrite = CardContent & { revision: number; mutationId: string };
export type CardSummary = Pick<CardDocument, 'resourceId' | 'title' | 'tone' | 'revision' | 'updatedAt'>;
export function validCardWrite(value: unknown): value is CardWrite {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 7 && typeof v.title === 'string' && !!v.title.trim() && v.title.length <= 120
    && typeof v.value === 'string' && v.value.length <= 160 && typeof v.detail === 'string' && v.detail.length <= 4000
    && CARD_TONES.includes(v.tone as CardTone) && (v.progress === null || (typeof v.progress === 'number' && Number.isFinite(v.progress) && v.progress >= 0 && v.progress <= 100))
    && Number.isSafeInteger(v.revision) && Number(v.revision) >= 0 && Number(v.revision) < Number.MAX_SAFE_INTEGER && validBoardUuid(v.mutationId);
}
