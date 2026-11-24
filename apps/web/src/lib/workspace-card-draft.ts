import { validCardWrite, type CardContent, type CardDocument, type CardSummary, type CardWrite } from '@agentopsdeck/shared';
import { registerCacheCleaner } from './cache-cleaners.js';

export type CardDraft = { content: CardContent; revision: number; pending?: CardWrite };
export const cardDraftKey = (scope: string, id: string) => `agentopsdeck.card-draft.v1:${JSON.stringify([scope, id])}`;
export function parseCardDraft(raw: string | null): CardDraft | undefined {
  if (!raw || raw.length > 60000) return;
  try {
    const draft = JSON.parse(raw) as CardDraft;
    if (!draft || !draft.content || typeof draft.content.title !== 'string') return;
    const write = { ...draft.content, title: draft.content.title || ' ', revision: draft.revision, mutationId: '00000000-0000-4000-8000-000000000000' };
    // Empty titles are legitimate unfinished drafts, not valid writes.
    if (!validCardWrite({ ...write, title: draft.content.title.trim() ? draft.content.title : 'Untitled' }) || draft.content.title.length > 120) return;
    if (draft.pending && (!validCardWrite(draft.pending) || !cardContentEqual(draft.content, draft.pending) || draft.revision !== draft.pending.revision)) return;
    return draft;
  } catch { return; }
}
export function cardContentEqual(a: CardContent, b: CardContent) {
  return a.title === b.title && a.value === b.value && a.detail === b.detail && a.tone === b.tone && a.progress === b.progress;
}

const workspaceCardCache = new Map<string, CardDocument | null>();
const workspaceCardsCatalogCache = new Map<string, CardSummary[]>();
const MAX_CACHED_WORKSPACE_CARDS = 64;

function cardCacheKey(scope: string, resourceId: string): string {
  return JSON.stringify([scope, resourceId]);
}

function setBoundedCardMap<T>(map: Map<string, T>, key: string, value: T, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function readCachedWorkspaceCard(scope: string, resourceId: string): { hit: boolean; document: CardDocument | undefined } {
  if (!scope || !resourceId || resourceId === 'catalog') return { hit: false, document: undefined };
  const key = cardCacheKey(scope, resourceId);
  if (!workspaceCardCache.has(key)) return { hit: false, document: undefined };
  const cached = workspaceCardCache.get(key);
  return { hit: true, document: cached ? structuredClone(cached) : undefined };
}

export function writeCachedWorkspaceCard(scope: string, resourceId: string, document: CardDocument | undefined): void {
  if (!scope || !resourceId || resourceId === 'catalog') return;
  const key = cardCacheKey(scope, resourceId);
  setBoundedCardMap(workspaceCardCache, key, document ? structuredClone(document) : null, MAX_CACHED_WORKSPACE_CARDS);
  if (document && workspaceCardsCatalogCache.has(scope)) {
    const existing = workspaceCardsCatalogCache.get(scope)!;
    const summary: CardSummary = {
      resourceId: document.resourceId,
      title: document.title,
      tone: document.tone,
      revision: document.revision,
      updatedAt: document.updatedAt,
    };
    const index = existing.findIndex(item => item.resourceId === document.resourceId);
    const next = index >= 0 ? existing.map((item, i) => i === index ? summary : item) : [summary, ...existing];
    setBoundedCardMap(workspaceCardsCatalogCache, scope, next, MAX_CACHED_WORKSPACE_CARDS);
  }
}

export function readCachedWorkspaceCardsCatalog(scope: string): CardSummary[] | undefined {
  if (!scope) return undefined;
  const cached = workspaceCardsCatalogCache.get(scope);
  return cached ? structuredClone(cached) : undefined;
}

export function writeCachedWorkspaceCardsCatalog(scope: string, cards: CardSummary[]): void {
  if (!scope) return;
  setBoundedCardMap(workspaceCardsCatalogCache, scope, structuredClone(cards), MAX_CACHED_WORKSPACE_CARDS);
}

export function clearCachedWorkspaceCards(): void {
  workspaceCardCache.clear();
  workspaceCardsCatalogCache.clear();
}
registerCacheCleaner(clearCachedWorkspaceCards);
