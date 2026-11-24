import { RESEARCH_ARTICLE_LIMIT, type ResearchArticle, type ResearchResult } from '@agentopsdeck/shared';
import { ResearchError, type ResearchReaderConfig } from './workspace-research.js';
import { ResearchAuthorization, ResearchWork, type ResearchAuthorize } from './research-execution.js';

const RESPONSE_BYTES = 512 * 1024;
/** Fetch only a fixed operator-owned extraction gateway, never the source URL itself.
 * The gateway must enforce public-address DNS/redirect policy and return plain text.
 * One active read/user, four total; no automatic reads, retries or persistent article cache. */
export class WorkspaceReader {
  private closed = false;
  private readonly work = new ResearchWork();
  private closing: Promise<void> | undefined;
  private active = new Map<string, AbortController>();
  private admissions = new Map<string, number[]>();
  private total: number[] = [];
  constructor(private readonly config?: ResearchReaderConfig, private readonly transport: typeof fetch = fetch,
    private readonly now = Date.now, private readonly timeoutMs = 15_000) {}
  enabled(user: string) { return !this.closed && !!this.config?.users.includes(user); }
  target(user: string) { return this.enabled(user) ? new URL(this.config!.url).origin : undefined; }
  origins(user: string): string[] { return this.enabled(user) ? [...this.config!.sourceOrigins] : []; }
  close() { this.closed = true; for (const controller of this.active.values()) controller.abort(new ResearchError(503, 'reader_stopped'));
    this.admissions.clear(); this.total = []; return this.closing ??= this.work.drain(); }
  read(user: string, result: ResearchResult, sourceId: string, signal: AbortSignal, authorized: ResearchAuthorize): Promise<ResearchArticle> {
    return this.work.track(() => this.readOriginal(user, structuredClone(result), sourceId, signal, authorized));
  }
  private async readOriginal(user: string, result: ResearchResult, sourceId: string, signal: AbortSignal, authorized: ResearchAuthorize): Promise<ResearchArticle> {
    if (!this.enabled(user)) throw new ResearchError(403, 'reader_unavailable');
    const source = result.sources.find(item => item.id === sourceId);
    if (!source || !this.config!.sourceOrigins.includes(new URL(source.url).origin)) throw new ResearchError(403, 'reader_source_not_allowed');
    if (signal.aborted) throw new ResearchError(503, 'reader_stopped');
    const time = this.now(), recent = (this.admissions.get(user) ?? []).filter(at => time - at < 60_000);
    this.total = this.total.filter(at => time - at < 60_000);
    if (this.active.has(user) || this.active.size >= 4 || recent.length >= 10 || this.total.length >= 30) throw new ResearchError(429, 'reader_budget_exceeded');
    const controller = new AbortController(); this.active.set(user, controller);
    const originals = new ResearchWork(), authority = new ResearchAuthorization(authorized, controller, originals);
    const abort = () => controller.abort(new ResearchError(503, 'reader_stopped'));
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new ResearchError(504, 'reader_timeout')), this.timeoutMs);
    timer.unref(); authority.watch();
    let reject: (reason: unknown) => void = () => {};
    const interrupted = new Promise<never>((_, fail) => { reject = fail; });
    const onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) abort();
    const assertActive = () => authority.check();
    const execute = async (): Promise<ResearchArticle> => {
      const initial = assertActive(); if (initial) await initial; authority.assertActive();
      const admitted = this.now(), current = (this.admissions.get(user) ?? []).filter(at => admitted - at < 60_000);
      this.total = this.total.filter(at => admitted - at < 60_000);
      if (current.length >= 10 || this.total.length >= 30) throw new ResearchError(429, 'reader_budget_exceeded');
      this.admissions.set(user, [...current, admitted]); this.total.push(admitted);
      const response = await this.transport(this.config!.url, { method: 'POST', redirect: 'error', credentials: 'omit',
        signal: controller.signal, headers: { 'content-type': 'application/json', accept: 'application/json',
          ...(this.config!.token ? { authorization: `Bearer ${this.config!.token}` } : {}) },
        // No user IDs, query, chat, files or model credentials leave Hub.
        body: JSON.stringify({ url: source.url, format: 'text', redirects: false, maxCharacters: RESEARCH_ARTICLE_LIMIT }) });
      try { await assertActive(); authority.assertActive(); } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
      if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) {
        await response.body?.cancel().catch(() => {}); throw new ResearchError(502, 'reader_provider_unavailable');
      }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0, finished = false;
      let cancellation: Promise<void> | undefined;
      const cancelRead = () => { cancellation ??= originals.track(() => reader.cancel()).catch(() => {}); };
      controller.signal.addEventListener('abort', cancelRead, { once: true });
      try {
        while (true) {
          await assertActive(); authority.assertActive(); const next = await reader.read(); await assertActive(); authority.assertActive();
          if (next.done) { finished = true; break; }
          bytes += next.value.byteLength;
          if (bytes > RESPONSE_BYTES) throw new ResearchError(502, 'reader_response_too_large');
          chunks.push(next.value);
        }
        const data: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ResearchError(502, 'invalid_reader_response');
        const row = data as Record<string, unknown>;
        // Exact URL prevents a redirected result being cited as the original page.
        if (row.url !== source.url || typeof row.text !== 'string' || !row.text.trim() || row.text.length > RESEARCH_ARTICLE_LIMIT
          || typeof row.truncated !== 'boolean') throw new ResearchError(502, 'invalid_reader_response');
        const text = row.text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').trim();
        if (!text) throw new ResearchError(502, 'invalid_reader_response');
        await assertActive(); authority.assertActive();
        return { searchId: result.searchId, sourceId: source.id, url: source.url, title: source.title, text, truncated: row.truncated, fetchedAt: this.now() };
      } finally {
        controller.signal.removeEventListener('abort', cancelRead);
        if (!finished) cancelRead();
        await cancellation;
        reader.releaseLock();
      }
    };
    try { return await Promise.race([originals.track(execute), interrupted]); }
    catch (error) { throw error instanceof ResearchError ? error : new ResearchError(502, 'reader_provider_unavailable'); }
    finally {
      controller.abort(new ResearchError(503, 'reader_stopped'));
      clearTimeout(timer); authority.stop();
      signal.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', onAbort);
      void this.work.track(async () => { await originals.drain(); if (this.active.get(user) === controller) this.active.delete(user); });
    }
  }
}
