import type { ResearchSynthesisConfig } from './workspace-research.js';
import { ResearchWork } from './research-execution.js';

export type ModelCatalogOptions = { discoverModels?: boolean; defaultModel?: string; catalogTimeoutMs?: number };
export const validStandaloneModel = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 128 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

/** Discovery is credential-scoped and uses only the fixed inference endpoint.
 * No Agent login capabilities or browser-supplied endpoint/credentials. */
export class StandaloneModelCatalog {
  private models: Array<{ id: string; label: string }>;
  private state: 'ready' | 'unavailable' = 'unavailable';
  private expires = 0;
  private pending: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private closed = false;
  private readonly originals = new ResearchWork();
  private originalPending = false;
  private closing: Promise<void> | undefined;
  constructor(private readonly config: ResearchSynthesisConfig, private readonly transport: typeof fetch,
    private readonly now: () => number, private readonly options: ModelCatalogOptions = {}) {
    this.models = [{ id: config.model, label: config.model }];
  }
  target() {
    const model = this.models.some(m => m.id === this.options.defaultModel) ? this.options.defaultModel!
      : this.models.some(m => m.id === this.config.model) ? this.config.model : this.models[0]!.id;
    return { model, provider: new URL(this.config.url).origin, models: this.models.map(m => ({ ...m })), catalogState: this.state };
  }
  async read() {
    if (!this.closed && this.options.discoverModels && this.now() >= this.expires && !this.pending && !this.originalPending)
      this.pending = this.discover().finally(() => { this.pending = undefined; });
    await this.pending;
    return this.target();
  }
  close() { this.closed = true; this.controller?.abort(); return this.closing ??= this.originals.drain(); }
  private async discover() {
    const controller = new AbortController(); this.controller = controller;
    const timer = setTimeout(() => controller.abort(), this.options.catalogTimeoutMs ?? 5000); timer.unref?.();
    const interrupted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(Error('catalog-stopped')), { once: true });
    });
    const execute = async () => {
      const url = new URL(this.config.url);
      if (!url.pathname.endsWith('/responses')) throw Error('catalog-unavailable');
      url.pathname = url.pathname.slice(0, -'responses'.length) + 'models';
      const response = await this.transport(url.href, { method: 'GET', redirect: 'error', credentials: 'omit', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.config.token}`, Accept: 'application/json' } });
      if (controller.signal.aborted || !response.ok || !response.body
        || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel(); throw Error('catalog-unavailable');
      }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0, finished = false;
      let cancellation: Promise<void> | undefined;
      const abort = () => { cancellation ??= this.originals.track(() => reader.cancel()).catch(() => {}); };
      controller.signal.addEventListener('abort', abort, { once: true });
      try {
        while (true) {
          if (controller.signal.aborted) throw Error('catalog-stopped');
          const part = await reader.read();
          if (controller.signal.aborted) throw Error('catalog-stopped');
          if (part.done) { finished = true; break; }
          bytes += part.value.byteLength;
          if (bytes > 128 * 1024) throw Error('catalog-oversize');
          chunks.push(part.value);
        }
      } finally {
        controller.signal.removeEventListener('abort', abort);
        if (!finished) abort();
        await cancellation;
        reader.releaseLock();
      }
      const data = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
      if (!Array.isArray(data.data) || !data.data.length || data.data.length > 512
        || data.data.some((m: { id?: unknown }) => !m || !validStandaloneModel(m.id))) throw Error('catalog-shape');
      if (controller.signal.aborted || this.closed) throw Error('catalog-stopped');
      return [...new Set<string>(data.data.map((m: { id: string }) => m.id))].map(id => ({ id, label: id }));
    };
    this.originalPending = true;
    const original = this.originals.track(execute);
    void original.then(() => { this.originalPending = false; }, () => { this.originalPending = false; });
    try { this.models = await Promise.race([original, interrupted]); this.state = 'ready'; }
    catch { this.models = [{ id: this.config.model, label: this.config.model }]; this.state = 'unavailable'; }
    finally { clearTimeout(timer); this.controller = undefined; this.expires = this.now() + (this.state === 'ready' ? 60_000 : 5000); }
  }
}
