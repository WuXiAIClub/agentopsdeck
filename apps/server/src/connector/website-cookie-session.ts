/** Deliberately narrower than a browser cookie jar: configured names, one
 * origin, root path only, memory only. Never serialize this into a receipt. */
export type WebsiteCookiePolicy = { cookieNames: string[]; csrf?: { cookie: string; header: 'x-csrf-token' | 'x-xsrf-token' } };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const namePattern = /^[A-Za-z0-9_-]{1,80}$/;
export function parseWebsiteCookiePolicy(value: unknown): WebsiteCookiePolicy | undefined {
  if (value === undefined) return;
  if (!record(value) || Object.keys(value).some(k => !['cookieNames', 'csrf'].includes(k))
    || !Array.isArray(value.cookieNames) || !value.cookieNames.length || value.cookieNames.length > 8
    || value.cookieNames.some(n => typeof n !== 'string' || !namePattern.test(n)) || new Set(value.cookieNames).size !== value.cookieNames.length
    || value.csrf !== undefined && (!record(value.csrf) || Object.keys(value.csrf).length !== 2
      || !value.cookieNames.includes(value.csrf.cookie) || !['x-csrf-token', 'x-xsrf-token'].includes(value.csrf.header as string))) throw Error('Invalid website cookie policy');
  return structuredClone(value) as WebsiteCookiePolicy;
}
type Cookie = { value: string; expiresAt: number; secure: boolean };
export class WebsiteCookieSession {
  private cookies = new Map<string, Cookie>();
  constructor(readonly origin: string, readonly policy: WebsiteCookiePolicy, readonly expiresAt: number, private now = Date.now) {}
  headers(url: URL, csrf = false): Record<string, string> {
    if (url.origin !== this.origin || this.now() >= this.expiresAt) throw Error('Website session unavailable');
    const live = [...this.cookies].filter(([, c]) => c.expiresAt > this.now() && (!c.secure || url.protocol === 'https:'));
    const output: Record<string, string> = {};
    if (live.length) output.cookie = live.map(([key, c]) => `${key}=${c.value}`).join('; ');
    if (csrf) {
      const policy = this.policy.csrf, value = policy && live.find(([key]) => key === policy.cookie)?.[1].value;
      if (!policy || !value) throw Error('Website CSRF token unavailable');
      const decoded = decodeURIComponent(value);
      if (!/^[\x21-\x7e]{1,2048}$/.test(decoded)) throw Error('Website CSRF token unavailable');
      output[policy.header] = decoded;
    }
    return output;
  }
  accept(url: URL, headers: Headers) {
    if (url.origin !== this.origin || this.now() >= this.expiresAt) throw Error('Website session unavailable');
    const values = headers.getSetCookie();
    if (values.length > 32 || values.reduce((n, s) => n + s.length, 0) > 16 * 1024) throw Error('Website cookie budget exceeded');
    const next = new Map(this.cookies);
    for (const raw of values) {
      const parts = raw.split(';'), pair = parts.shift()!, equal = pair.indexOf('='), name = pair.slice(0, equal).trim();
      if (equal < 1 || !this.policy.cookieNames.includes(name)) continue;
      const value = pair.slice(equal + 1).trim();
      if (value.length > 2048 || /[^\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]/.test(value)) throw Error('Invalid website cookie');
      const attrs = new Map<string, string>();
      for (const part of parts) {
        const at = part.indexOf('='), key = (at < 0 ? part : part.slice(0, at)).trim().toLowerCase();
        if (attrs.has(key)) throw Error('Ambiguous website cookie');
        attrs.set(key, at < 0 ? '' : part.slice(at + 1).trim());
      }
      // Root-only host cookies prevent cross-path or domain interpretation
      // differences between the private jar and the configured application.
      if (attrs.has('domain') || attrs.get('path') !== '/') throw Error('Website cookies require a host-only root path');
      const secure = attrs.has('secure');
      if ((secure || name.startsWith('__Secure-') || name.startsWith('__Host-')) && url.protocol !== 'https:') continue;
      if ((name.startsWith('__Secure-') || name.startsWith('__Host-')) && !secure) throw Error('Invalid secure website cookie');
      let expiresAt = this.expiresAt;
      if (attrs.has('max-age')) {
        const seconds = attrs.get('max-age')!;
        if (!/^-?\d{1,10}$/.test(seconds)) throw Error('Invalid website cookie lifetime');
        expiresAt = Math.min(expiresAt, this.now() + Number(seconds) * 1000);
      } else if (attrs.has('expires')) {
        const deadline = Date.parse(attrs.get('expires')!);
        if (!Number.isFinite(deadline)) throw Error('Invalid website cookie lifetime');
        expiresAt = Math.min(expiresAt, deadline);
      }
      if (expiresAt <= this.now()) next.delete(name); else next.set(name, { value, expiresAt, secure });
    }
    if ([...next].reduce((n, [k, v]) => n + k.length + v.value.length + 3, 0) > 8192) throw Error('Website cookie budget exceeded');
    this.cookies = next;
  }
}
