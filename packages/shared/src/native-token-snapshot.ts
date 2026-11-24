import { tokenUsageRange } from './native-token-usage.js';
import { validateNativeTokenUsageExport, type NativeTokenUsageExport } from './native-token-export.js';

export type TokenKnowledgeSummary = { model: string | null; samples: number; inputTokens: number; outputTokens: number;
  cacheReadTokens: number | null; cacheWriteTokens: number | null };
export type NativeTokenSnapshot = { version: 1; kind: 'local-ledger-snapshot'; requestId: string; createdAt: number;
  memberDigest: string; modelsByKnowledge: TokenKnowledgeSummary[]; data: NativeTokenUsageExport };
export function tokenSnapshotRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) throw Error('Invalid snapshot request ID');
  return value.toLowerCase();
}
export function tokenSnapshotSelection(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Invalid selection');
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some(k => !['requestId', 'from', 'to', 'bucketMs'].includes(k))
    || !['from', 'to', 'bucketMs'].every(k => typeof input[k] === 'number')) throw Error('Invalid selection');
  return { requestId: tokenSnapshotRequestId(input.requestId),
    ...tokenUsageRange(String(input.from), String(input.to), String(input.bucketMs)) };
}
export function tokenKnowledgeSummary(data: NativeTokenUsageExport): TokenKnowledgeSummary[] {
  const groups = new Map<string, TokenKnowledgeSummary>();
  for (const row of data.observations) {
    const key = JSON.stringify([row.model, row.cacheReadTokens !== null, row.cacheWriteTokens !== null]);
    const group = groups.get(key) ?? { model: row.model, samples: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: row.cacheReadTokens === null ? null : 0, cacheWriteTokens: row.cacheWriteTokens === null ? null : 0 };
    group.samples++;
    for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
      if (group[field] !== null) {
        const sum = group[field]! + row[field]!;
        if (!Number.isSafeInteger(sum) || sum < 0) throw Error('Token precision exceeded');
        group[field] = sum;
      }
    }
    groups.set(key, group);
  }
  return [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value);
}
export function validateNativeTokenSnapshot(raw: unknown): NativeTokenSnapshot {
  if (!raw || typeof raw !== 'object') throw Error('Invalid token snapshot');
  const value = raw as NativeTokenSnapshot;
  const requestId = tokenSnapshotRequestId(value.requestId);
  if (value.version !== 1 || value.kind !== 'local-ledger-snapshot' || value.requestId !== requestId
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
    || typeof value.memberDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.memberDigest)) throw Error('Invalid token snapshot');
  const data = validateNativeTokenUsageExport(value.data), modelsByKnowledge = tokenKnowledgeSummary(data);
  if (JSON.stringify(value.modelsByKnowledge) !== JSON.stringify(modelsByKnowledge)) throw Error('Invalid token summary');
  return { version: 1, kind: 'local-ledger-snapshot', requestId, createdAt: value.createdAt,
    memberDigest: value.memberDigest, modelsByKnowledge, data };
}
