import { createHash } from 'node:crypto';
import type { ModelChoice } from './model-catalog.js';

const unavailable = () => new Error('Provider model discovery unavailable');
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
type Provider = { url: string; headers: Record<string, string>; fingerprint: string };

/** Only the runtime's effective configuration and its own environment may select
 * an endpoint/credential. Nothing from a browser request enters this resolver. */
export function configuredModelProvider(raw: unknown, explicit?: string, env: NodeJS.ProcessEnv = process.env): Provider | undefined {
  const config = record(record(raw).config), name = explicit || config.model_provider;
  if (!name || name === 'openai') return undefined;
  if (typeof name !== 'string') throw unavailable();
  const provider = record(record(config.model_providers)[name]);
  if (typeof provider.base_url !== 'string') throw unavailable();
  let url: URL;
  try { url = new URL(provider.base_url); } catch { throw unavailable(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw unavailable();
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`;
  const headers: Record<string, string> = { accept: 'application/json' };
  const set = (key: string, value: unknown) => {
    if (typeof value !== 'string' || !value || value.length > 8192 || /[\r\n\0]/.test(value)
      || !/^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/.test(key) || ['host', 'cookie', 'connection', 'content-length'].includes(key.toLowerCase())) throw unavailable();
    headers[key.toLowerCase()] = value;
  };
  for (const [key, value] of Object.entries(record(provider.http_headers))) set(key, value);
  for (const [key, variable] of Object.entries(record(provider.env_http_headers))) {
    if (typeof variable !== 'string') throw unavailable();
    set(key, env[variable]);
  }
  if (typeof provider.env_key === 'string') set('authorization', env[provider.env_key] ? `Bearer ${env[provider.env_key]}` : undefined);
  else if (typeof provider.experimental_bearer_token === 'string') set('authorization', `Bearer ${provider.experimental_bearer_token}`);
  // Native login/auth.json credentials are intentionally not repurposed. A
  // login-backed provider needs its own supported catalog adapter.
  else if (provider.requires_openai_auth === true && !headers.authorization) throw unavailable();
  const fingerprint = createHash('sha256').update(JSON.stringify([name, url.href, Object.entries(headers).sort()])).digest('hex');
  return { url: url.href, headers, fingerprint };
}

/** Bounded, coalesced and credential-scoped. Errors never expose provider URLs,
 * response bodies or secrets, and never substitute a configured default. */
export class ProviderModelCatalog {
  private cached: { key: string; until: number; models?: ModelChoice[] } | undefined;
  private work: { key: string; promise: Promise<ModelChoice[]>; controller: AbortController } | undefined;
  private closed = false;
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly timeoutMs = 5000) {}
  read(provider: Provider): Promise<ModelChoice[]> {
    if (this.closed) return Promise.reject(unavailable());
    if (this.work?.key === provider.fingerprint) return this.work.promise.then(models => structuredClone(models));
    if (this.cached?.key === provider.fingerprint && this.cached.until > Date.now()) {
      return this.cached.models ? Promise.resolve(structuredClone(this.cached.models)) : Promise.reject(unavailable());
    }
    this.work?.controller.abort(); this.cached = undefined;
    const controller = new AbortController(), key = provider.fingerprint;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs); timer.unref();
    const promise = (async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await this.fetcher(provider.url, { headers: provider.headers, signal: controller.signal, redirect: 'error', credentials: 'omit' });
        if (!response.ok || !response.body) throw unavailable();
        reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length; if (size > 131072) throw unavailable();
          chunks.push(next.value);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!Array.isArray(body?.data) || body.data.length > 512) throw unavailable();
        const ids = new Set<string>();
        for (const row of body.data) {
          const id = row?.id;
          if (typeof id !== 'string' || !id || id.length > 128 || id.trim() !== id || /[\x00-\x20\x7f]/.test(id)) throw unavailable();
          ids.add(id);
        }
        if (this.closed || controller.signal.aborted) throw unavailable();
        const models = [...ids].map(id => ({ id, label: id }));
        if (this.work?.key === key) this.cached = { key, until: Date.now() + 60_000, models };
        return models;
      } catch {
        if (!this.closed && this.work?.key === key) this.cached = { key, until: Date.now() + 5000 };
        throw unavailable();
      } finally {
        clearTimeout(timer); await reader?.cancel().catch(() => {});
        if (this.work?.key === key) this.work = undefined;
      }
    })();
    this.work = { key, promise, controller };
    return promise.then(models => structuredClone(models));
  }
  async close() { this.closed = true; this.cached = undefined; this.work?.controller.abort(); await this.work?.promise.catch(() => {}); }
}
