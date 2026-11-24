import { ReadRequestOwner, ReadRequestError, type ReadRequestContext } from '../lifecycle/read-request-owner.js';
import { createHash, randomUUID } from 'node:crypto';
export type IssueQuery = { connection: string; project: string; kind: 'issue' | 'work_item'; filter: string; order: 'updated_desc'; limit: number };
export type IssueItem = { remoteId: string; title: string; state: string; url: string; body: string | null; updatedAt: number;
  number?: string; labels?: string[]; assignees?: string[]; typeName?: string; metadataPartial?: boolean };
export type IssuePage = { items: IssueItem[]; nextCursor: string | null; completeness: 'complete' | 'partial'; retryAfter: number | null };
export type ReadOnlyIssueAdapter = { list(query: IssueQuery, cursor: string | null, signal: AbortSignal): Promise<IssuePage> };
export class IssueReadError extends Error {}
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
type Cursor = { owner: string; epoch: string; queryHash: string; remote: string; seen: string[]; expiresAt: number };

/** I1 read-only normalized boundary. Network credentials stay entirely inside
 * a provider adapter. This service does not create/edit remote issues or local
 * tasks. sourceKey is the stable source_link deduplication key for later import. */
export class IssueCardReader {
  private readonly cursors = new Map<string, Cursor>();
  private readonly reads: ReadRequestOwner;
  private readonly busy = new Set<string>();
  constructor(private readonly adapter: ReadOnlyIssueAdapter,
    private readonly permission: (owner: string, query: IssueQuery) => { epoch: string; origin: string; provider?: string } | undefined | PromiseLike<{ epoch: string; origin: string; provider?: string } | undefined>,
    private readonly now = Date.now, timeoutMs = 10_000) {
    this.reads = new ReadRequestOwner('system-read-wait', { waitMs: timeoutMs, limit: 8 });
  }
  pendingFor(owner: string) { return this.busy.has(owner); }
  get pending() { return this.reads.pending; }
  close() { return this.reads.close(); }
  async list(owner: string, raw: IssueQuery, cursor?: string, request = new Request('http://issue-read.invalid')) {
    const input = { ...raw };
    try {
      return (await this.reads.run(request, async context => {
        if (this.busy.has(owner)) throw new IssueReadError('busy');
        this.busy.add(owner);
        try { return await this.read(owner, input, cursor, context); }
        finally { this.busy.delete(owner); }
      })).value;
    } catch (error) {
      if (error instanceof ReadRequestError) throw new IssueReadError(error.status === 408 ? 'cancelled' : 'timeout-or-unavailable');
      throw error;
    }
  }
  private async read(owner: string, raw: IssueQuery, cursor: string | undefined, context: ReadRequestContext) {
    if (!text(owner, 512) || !text(raw.connection, 128) || !text(raw.project, 512) || !['issue', 'work_item'].includes(raw.kind)
      || typeof raw.filter !== 'string' || raw.filter.length > 1024 || /[\u0000-\u001f\u007f]/.test(raw.filter)
      || raw.order !== 'updated_desc' || !Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > 100) throw new IssueReadError('query');
    const query: IssueQuery = Object.freeze({ connection: raw.connection, project: raw.project, kind: raw.kind, filter: raw.filter, order: raw.order, limit: raw.limit });
    const initial = (await context.stage(11, () => this.permission(owner, query))).value;
    if (!initial || !text(initial.epoch, 512)) throw new IssueReadError('forbidden');
    // Never retain a mutable permission DTO as the original authority proof.
    const authority = { epoch: initial.epoch, origin: initial.origin, provider: initial.provider };
    const origin = new URL(authority.origin); if (origin.protocol !== 'https:' || origin.username || origin.password || origin.origin !== authority.origin) throw new IssueReadError('origin');
    const queryHash = digest(query), at = this.now();
    for (const [key, entry] of this.cursors) if (at >= entry.expiresAt) this.cursors.delete(key);
    const previous = cursor ? this.cursors.get(cursor) : undefined;
    if (cursor && (!previous || previous.owner !== owner || previous.epoch !== authority.epoch || previous.queryHash !== queryHash || at < previous.expiresAt - 300_000)) throw new IssueReadError('cursor-expired-or-mismatched');
    const page = (await context.stage(12, () => this.adapter.list(query, previous?.remote ?? null, context.signal))).value;
    const current = (await context.stage(13, () => this.permission(owner, query))).value;
    if (!current || current.epoch !== authority.epoch || current.origin !== authority.origin || current.provider !== authority.provider) throw new IssueReadError('authority-changed');
    if (!page || !Array.isArray(page.items) || page.items.length > query.limit || !['complete', 'partial'].includes(page.completeness)
      || page.nextCursor !== null && !text(page.nextCursor, 2048)
      || page.retryAfter !== null && (!Number.isSafeInteger(page.retryAfter) || page.retryAfter < 0 || page.retryAfter > 86400)
      || Buffer.byteLength(JSON.stringify(page)) > 256 * 1024) throw new IssueReadError('response-budget');
    const seen = new Set(previous?.seen ?? []), pageSeen = new Set<string>(), items = [];
    for (const item of page.items) {
      if (!text(item.remoteId, 256) || !text(item.title, 2048) || !text(item.state, 128)
        || item.number !== undefined && (typeof item.number !== 'string' || !/^[1-9][0-9]{0,18}$/.test(item.number))
        || [item.labels, item.assignees].some(values => values !== undefined && (!Array.isArray(values) || values.length > 100 || values.some(v => !text(v, 256))))
        || item.typeName !== undefined && !text(item.typeName, 128) || item.metadataPartial !== undefined && typeof item.metadataPartial !== 'boolean'
        || item.body !== null && (typeof item.body !== 'string' || Buffer.byteLength(item.body) > 64 * 1024)
        || !Number.isSafeInteger(item.updatedAt) || item.updatedAt < 0 || !text(item.url, 4096)) throw new IssueReadError('item');
      const url = new URL(item.url); if (url.origin !== origin.origin || url.username || url.password) throw new IssueReadError('item-origin');
      const identity = { provider: authority.provider ?? 'custom', origin: authority.origin, connection: query.connection, project: query.project, kind: query.kind, remoteId: item.remoteId };
      const sourceKey = digest(identity);
      if (pageSeen.has(sourceKey)) throw new IssueReadError('duplicate-in-page');
      pageSeen.add(sourceKey);
      if (!seen.has(sourceKey)) items.push({ identity, sourceKey, title: item.title, state: item.state, url: url.href, body: item.body, updatedAt: item.updatedAt,
        ...(item.number !== undefined ? { number: item.number } : {}), ...(item.typeName !== undefined ? { typeName: item.typeName } : {}),
        ...(item.labels !== undefined ? { labels: [...item.labels] } : {}), ...(item.assignees !== undefined ? { assignees: [...item.assignees] } : {}),
        ...(item.metadataPartial !== undefined ? { metadataPartial: item.metadataPartial } : {}) });
      seen.add(sourceKey);
    }
    if (seen.size > 2000) throw new IssueReadError('pagination-budget');
    const observedAt = this.now(); context.check();
    let nextCursor: string | null = null;
    if (page.nextCursor !== null) {
      if (this.cursors.size >= 1024) throw new IssueReadError('cursor-capacity');
      nextCursor = randomUUID(); context.check(); this.cursors.set(nextCursor, { owner, epoch: authority.epoch, queryHash, remote: page.nextCursor, seen: [...seen], expiresAt: observedAt + 300_000 });
    }
    return { items, nextCursor, observedAt, completeness: page.completeness, consistency: 'best_effort' as const, retryAfter: page.retryAfter };
  }
}
