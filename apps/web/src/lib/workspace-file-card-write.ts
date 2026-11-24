import { registerCacheCleaner } from './cache-cleaners.js';
import { validBoardUuid, validWorkspaceFileCardWrite, validWorkspaceFileCard, type WorkspaceFileCardKind, type WorkspaceFileCardWrite, type WorkspaceFileCard } from '@agentopsdeck/shared';

export type FileCardPending = { bindingId: string | null; input: WorkspaceFileCardWrite };
export function parseFileCardPending(text: string, kind: WorkspaceFileCardKind): FileCardPending | undefined {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'bindingId,input'
      || value.bindingId !== null && !validBoardUuid(value.bindingId) || !validWorkspaceFileCardWrite(value.input) || value.input.kind !== kind) return;
    return value;
  } catch { return; }
}
export function parseFileCardDocument(value: unknown): (WorkspaceFileCard & { revision: number }) | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('revision' in value)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) return;
  const { revision, ...card } = value;
  return validWorkspaceFileCard(card) ? { ...card, revision: revision as number } : undefined;
}

export type CachedReportState = {
  document: WorkspaceFileCard & { kind: 'report'; content: { title: string; text: string }; revision: number };
  bindingId: string | null;
};

const reportStateCache = new Map<string, CachedReportState>();
const MAX_CACHED_REPORTS = 64;

function reportCacheKey(scope: string, resourceId: string): string {
  return JSON.stringify([scope, resourceId]);
}

export function readCachedReportState(scope: string, resourceId: string): CachedReportState | undefined {
  if (!scope || !resourceId) return undefined;
  const cached = reportStateCache.get(reportCacheKey(scope, resourceId));
  return cached ? structuredClone(cached) : undefined;
}

export function writeCachedReportState(scope: string, resourceId: string, state: CachedReportState | undefined): void {
  if (!scope || !resourceId) return;
  const key = reportCacheKey(scope, resourceId);
  if (!state) {
    reportStateCache.delete(key);
    return;
  }
  reportStateCache.delete(key);
  reportStateCache.set(key, structuredClone(state));
  while (reportStateCache.size > MAX_CACHED_REPORTS) {
    const oldest = reportStateCache.keys().next().value;
    if (oldest === undefined) break;
    reportStateCache.delete(oldest);
  }
}

export function clearCachedReportStates(): void {
  reportStateCache.clear();
}
registerCacheCleaner(clearCachedReportStates);
