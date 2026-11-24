export type IssueSourceView = { id: string; label: string; provider: 'github' | 'gitlab'; origin: string; project: string; kinds: ('issue' | 'work_item')[] };
export type IssuePageView = { items: { identity: { provider: string; origin: string; connection: string; project: string; kind: 'issue' | 'work_item'; remoteId: string }; sourceKey: string; title: string; state: string; url: string; body: string | null; updatedAt: number;
  number?: string; labels?: string[]; assignees?: string[]; typeName?: string; metadataPartial?: boolean }[]; nextCursor: string | null; observedAt: number; completeness: 'complete' | 'partial'; consistency: 'best_effort'; retryAfter: number | null };
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const safeUrl = (value: unknown, origin?: string) => { try { const u = new URL(String(value)); return u.protocol === 'https:' && !u.username && !u.password && (origin ? u.origin === origin : u.origin === value); } catch { return false; } };
export function validIssueSources(v: unknown): v is { readOnly: true; sources: IssueSourceView[] } {
  if (!v || typeof v !== 'object') return false;
  const value = v as { readOnly?: unknown; sources?: IssueSourceView[] };
  return value.readOnly === true && Array.isArray(value.sources) && value.sources.length <= 16 && new Set(value.sources.map(s => s?.id)).size === value.sources.length
    && value.sources.every(s => s && text(s.id, 80) && /^[a-zA-Z0-9_-]+$/.test(s.id) && text(s.label, 128) && ['github', 'gitlab'].includes(s.provider)
      && safeUrl(s.origin) && text(s.project, 256) && Array.isArray(s.kinds) && s.kinds[0] === 'issue'
      && (s.kinds.length === 1 || s.provider === 'gitlab' && s.kinds.length === 2 && s.kinds[1] === 'work_item'));
}
export function validIssuePage(v: unknown, source: IssueSourceView, kind: 'issue' | 'work_item' = 'issue'): v is IssuePageView {
  if (!v || typeof v !== 'object') return false;
  const value = v as IssuePageView;
  return Number.isSafeInteger(value.observedAt) && value.observedAt >= 0 && value.consistency === 'best_effort'
    && ['complete', 'partial'].includes(value.completeness) && (value.retryAfter === null || Number.isSafeInteger(value.retryAfter) && value.retryAfter >= 0 && value.retryAfter <= 86400)
    && (value.nextCursor === null || typeof value.nextCursor === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.nextCursor))
    && Array.isArray(value.items) && value.items.length <= 50 && new Set(value.items.map(i => i?.sourceKey)).size === value.items.length
    && new Set(value.items.map(i => i?.identity?.remoteId)).size === value.items.length
    && value.items.every(i => i && i.identity && i.identity.connection === source.id && i.identity.project === source.project && i.identity.provider === source.provider
      && i.identity.origin === source.origin && i.identity.kind === kind && source.kinds.includes(kind) && text(i.identity.remoteId, 256) && text(i.title, 2048) && text(i.state, 128)
      && (i.number === undefined || typeof i.number === 'string' && /^[1-9][0-9]{0,18}$/.test(i.number))
      && [i.labels, i.assignees].every(values => values === undefined || Array.isArray(values) && values.length <= 100 && values.every(v => text(v, 256)))
      && (i.typeName === undefined || text(i.typeName, 128)) && (i.metadataPartial === undefined || typeof i.metadataPartial === 'boolean')
      && typeof i.sourceKey === 'string' && /^[a-f0-9]{64}$/.test(i.sourceKey) && text(i.url, 4096) && safeUrl(i.url, source.origin)
      && (i.body === null || typeof i.body === 'string' && new TextEncoder().encode(i.body).length <= 65536) && Number.isSafeInteger(i.updatedAt) && i.updatedAt >= 0);
}
