import { randomUUID } from 'node:crypto';
import { researchQuery, type ResearchResult } from '@agentopsdeck/shared';
import { ResearchError, searchProvider, type ResearchProvider } from './workspace-search-provider.js';
import { ResearchAuthorization, ResearchWork, type ResearchAuthorize } from './research-execution.js';
export { ResearchError, projectResearchSources } from './workspace-search-provider.js';

export type ResearchSynthesisConfig = { url: string; model: string; token: string; users: string[] };
export type ResearchReaderConfig = { url: string; users: string[]; token?: string; sourceOrigins: string[] };
export type ResearchConfig = { provider?: ResearchProvider; searchUrl: string; users: string[]; token?: string; synthesis?: ResearchSynthesisConfig; reader?: ResearchReaderConfig };
export function parseResearchConfig(env: NodeJS.ProcessEnv): ResearchConfig | undefined {
  if (env.AOD_RESEARCH_ENABLED !== 'true') return undefined;
  // Fixed messages deliberately exclude both URL and credential input.
  const invalid = () => new Error('Invalid research configuration; configure a fixed search URL and explicit Hub user IDs');
  const provider = env.AOD_RESEARCH_PROVIDER ?? 'searxng';
  if (provider !== 'searxng' && provider !== 'tavily') throw invalid();
  const raw = env.AOD_RESEARCH_SEARCH_URL ?? (provider === 'tavily' ? 'https://api.tavily.com/search' : undefined);
  let url: URL;
  try { url = new URL(raw ?? ''); } catch { throw invalid(); }
  if (!raw || raw.length > 2048 || /[\x00-\x20\x7f]/.test(raw) || url.username || url.password || url.search || url.hash
    || !(url.protocol === 'https:' || (url.protocol === 'http:' && env.AOD_RESEARCH_ALLOW_HTTP === 'true'))) throw invalid();
  const users = [...new Set((env.AOD_RESEARCH_USERS ?? '').split(',').map(user => user.trim()).filter(Boolean))];
  if (!users.length || users.length > 128 || users.some(user => user.length > 128 || /[\s\x00-\x1f\x7f]/.test(user))) throw invalid();
  const token = env.AOD_RESEARCH_SEARCH_TOKEN;
  if (provider === 'tavily' && !token) throw invalid();
  if (token !== undefined && (!token || token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(token))) throw invalid();
  let synthesis: ResearchSynthesisConfig | undefined;
  if (env.AOD_RESEARCH_AI_ENABLED === 'true') {
    const fail = () => new Error('Invalid research AI configuration; configure Responses URL, model, dedicated token and explicit research user IDs');
    const rawUrl = env.AOD_RESEARCH_AI_RESPONSES_URL;
    let endpoint: URL;
    try { endpoint = new URL(rawUrl ?? ''); } catch { throw fail(); }
    const model = env.AOD_RESEARCH_AI_MODEL, key = env.AOD_RESEARCH_AI_TOKEN;
    const aiUsers = [...new Set((env.AOD_RESEARCH_AI_USERS ?? '').split(',').map(v => v.trim()).filter(Boolean))];
    if (!rawUrl || rawUrl.length > 2048 || /[\x00-\x20\x7f]/.test(rawUrl) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || !(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && env.AOD_RESEARCH_AI_ALLOW_HTTP === 'true'))
      || !model || model.length > 128 || /[\s\x00-\x1f\x7f]/.test(model)
      || !key || key.length > 4096 || /[\s\x00-\x1f\x7f]/.test(key)
      || !aiUsers.length || aiUsers.some(user => !users.includes(user))) throw fail();
    synthesis = { url: endpoint.href, model, token: key, users: aiUsers };
  }
  let reader: ResearchReaderConfig | undefined;
  if (env.AOD_RESEARCH_READER_ENABLED === 'true') {
    const fail = () => new Error('Invalid research reader configuration; configure a fixed extraction gateway, exact HTTPS source origins and research user IDs');
    const rawReader = env.AOD_RESEARCH_READER_URL;
    let endpoint: URL, origins: unknown;
    try { endpoint = new URL(rawReader ?? ''); origins = JSON.parse(env.AOD_RESEARCH_READER_SOURCE_ORIGINS ?? ''); } catch { throw fail(); }
    const readerUsers = [...new Set((env.AOD_RESEARCH_READER_USERS ?? '').split(',').map(v => v.trim()).filter(Boolean))];
    const key = env.AOD_RESEARCH_READER_TOKEN;
    if (!rawReader || rawReader.length > 2048 || /[\x00-\x20\x7f]/.test(rawReader) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || !(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && env.AOD_RESEARCH_READER_ALLOW_HTTP === 'true'))
      || !readerUsers.length || readerUsers.some(user => !users.includes(user))
      || (key !== undefined && (!key || key.length > 4096 || /[\s\x00-\x1f\x7f]/.test(key)))
      || !Array.isArray(origins) || !origins.length || origins.length > 64) throw fail();
    const sourceOrigins: string[] = [];
    for (const origin of origins) {
      let source: URL;
      try { source = new URL(origin); } catch { throw fail(); }
      // No wildcard, local hostname, literal IP, credentials, path or redirect authority.
      if (typeof origin !== 'string' || origin.length > 2048 || source.origin !== origin || source.protocol !== 'https:'
        || source.username || source.password || !source.hostname.includes('.') || /[:\[\]]/.test(source.hostname)
        || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(source.hostname)
        || /^[\d.]+$/.test(source.hostname) || /\.(localhost|local|internal|test|invalid)$/i.test(source.hostname)
        || source.hostname.endsWith('.')) throw fail();
      sourceOrigins.push(origin);
    }
    reader = { url: endpoint.href, users: readerUsers, sourceOrigins: [...new Set(sourceOrigins)], ...(key ? { token: key } : {}) };
  }
  return { ...(env.AOD_RESEARCH_PROVIDER !== undefined ? { provider } : {}), searchUrl: url.href, users, ...(token ? { token } : {}), ...(synthesis ? { synthesis } : {}), ...(reader ? { reader } : {}) };
}

export const RESEARCH_RESPONSE_BYTES = 256 * 1024;
export const RESEARCH_TIMEOUT_MS = 12_000;

/** Process-local budgets. AI-enabled users get one bounded ten-minute snapshot; no disk writes or I/O retries. */
export class WorkspaceResearch {
  private closed = false;
  private readonly work = new ResearchWork();
  private closing: Promise<void> | undefined;
  private active = new Map<string, AbortController>();
  private admissions = new Map<string, number[]>();
  private globalAdmissions: number[] = [];
  private snapshots = new Map<string, ResearchResult>();
  private snapshotTimers = new Map<string, NodeJS.Timeout>();
  private dropSnapshot(user: string) {
    this.snapshots.delete(user); clearTimeout(this.snapshotTimers.get(user)); this.snapshotTimers.delete(user);
  }
  constructor(private readonly config: ResearchConfig | undefined, private readonly transport: typeof fetch = fetch,
    private readonly now = Date.now, private readonly timeoutMs = RESEARCH_TIMEOUT_MS) {}
  enabled(user: string): boolean { return !this.closed && !!this.config?.users.includes(user); }
  synthesisEnabled(user: string): boolean { return this.enabled(user) && !!this.config?.synthesis?.users.includes(user); }
  readerEnabled(user: string): boolean { return this.enabled(user) && !!this.config?.reader?.users.includes(user); }
  snapshot(user: string, searchId: string): ResearchResult {
    const result = this.snapshots.get(user);
    if (!this.synthesisEnabled(user) && !this.readerEnabled(user)) throw new ResearchError(403, 'research_unavailable');
    if (!result || result.searchId !== searchId || this.now() - result.fetchedAt >= 600_000) {
      if (result && this.now() - result.fetchedAt >= 600_000) this.dropSnapshot(user);
      throw new ResearchError(400, 'search_expired');
    }
    return structuredClone(result);
  }
  close() { this.closed = true; for (const controller of this.active.values()) controller.abort(new ResearchError(503, 'search_stopped')); this.admissions.clear(); this.globalAdmissions = [];
    for (const user of this.snapshots.keys()) this.dropSnapshot(user);
    return this.closing ??= this.work.drain(); }
  search(user: string, query: string, signal: AbortSignal, authorized: ResearchAuthorize): Promise<ResearchResult> {
    return this.work.track(() => this.searchOriginal(user, query, signal, authorized));
  }
  private async searchOriginal(user: string, query: string, signal: AbortSignal, authorized: ResearchAuthorize): Promise<ResearchResult> {
    if (!this.enabled(user) || !this.config) throw new ResearchError(403, 'research_unavailable');
    if (!researchQuery(query) || query !== query.trim()) throw new ResearchError(400, 'invalid_query');
    if (signal.aborted) throw new ResearchError(503, 'search_stopped');
    const time = this.now(), recent = (this.admissions.get(user) ?? []).filter(at => time - at < 60_000);
    this.globalAdmissions = this.globalAdmissions.filter(at => time - at < 60_000);
    if (this.active.has(user) || this.active.size >= 4 || recent.length >= 10 || this.globalAdmissions.length >= 30) throw new ResearchError(429, 'search_budget_exceeded');
    const controller = new AbortController(); this.active.set(user, controller);
    const originals = new ResearchWork(), authority = new ResearchAuthorization(authorized, controller, originals);
    const abort = () => controller.abort(new ResearchError(503, 'search_stopped'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timeout = setTimeout(() => controller.abort(new ResearchError(504, 'search_timeout')), this.timeoutMs);
    timeout.unref(); authority.watch();
    let reject: (reason: unknown) => void = () => {};
    const interrupted = new Promise<never>((_, fail) => { reject = fail; });
    const onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
    const assertActive = () => authority.check();
    const execute = async () => {
      const initial = assertActive(); if (initial) await initial; authority.assertActive();
      const admitted = this.now(), current = (this.admissions.get(user) ?? []).filter(at => admitted - at < 60_000);
      this.globalAdmissions = this.globalAdmissions.filter(at => admitted - at < 60_000);
      if (current.length >= 10 || this.globalAdmissions.length >= 30) throw new ResearchError(429, 'search_budget_exceeded');
      this.admissions.set(user, [...current, admitted]); this.globalAdmissions.push(admitted);
      this.dropSnapshot(user);
      for (const [owner, snapshot] of this.snapshots) if (admitted - snapshot.fetchedAt >= 600_000) this.dropSnapshot(owner);
      const adapter = searchProvider(this.config!.provider);
      const response = await this.transport(this.config!.searchUrl, { method: 'POST', redirect: 'error', credentials: 'omit',
        signal: controller.signal, ...adapter.request(query, this.config!.token) });
      try { await assertActive(); authority.assertActive(); } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
      if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) {
        await response.body?.cancel().catch(() => {}); throw new ResearchError(502, 'search_provider_unavailable');
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
          if (bytes > RESEARCH_RESPONSE_BYTES) throw new ResearchError(502, 'provider_response_too_large');
          chunks.push(next.value);
        }
        let body: unknown;
        try { body = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); } catch { throw new ResearchError(502, 'invalid_provider_response'); }
        await assertActive(); authority.assertActive();
        return { searchId: randomUUID(), query, fetchedAt: this.now(), sources: adapter.project(body) };
      } finally {
        controller.signal.removeEventListener('abort', cancelRead);
        if (!finished) cancelRead();
        await cancellation;
        reader.releaseLock();
      }
    };
    try {
      const result = await Promise.race([originals.track(execute), interrupted]);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (this.synthesisEnabled(user) || this.readerEnabled(user)) {
        this.snapshots.set(user, structuredClone(result));
        const timer = setTimeout(() => this.dropSnapshot(user), 600_000); timer.unref(); this.snapshotTimers.set(user, timer);
      }
      return result;
    }
    catch (error) { throw error instanceof ResearchError ? error : new ResearchError(502, 'search_provider_unavailable'); }
    finally {
      controller.abort(new ResearchError(503, 'search_stopped'));
      clearTimeout(timeout); authority.stop();
      signal.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', onAbort);
      void this.work.track(async () => { await originals.drain(); if (this.active.get(user) === controller) this.active.delete(user); });
    }
  }
}
