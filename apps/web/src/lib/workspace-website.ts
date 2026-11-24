import { WEBSITE_MAX_BYTES, validWebsiteId } from '@agentopsdeck/shared';

/** Validate server-issued capability without persisting it or accepting a Hub
 * same-origin iframe. Lifetime is relative, not dependent on server clock. */
export function websiteBrowserVisit(value: unknown, hubOrigin: string): { url: string; expiresInMs: number } {
  const v = value as { url?: unknown; expiresInMs?: unknown } | null;
  if (!v || typeof v.url !== 'string' || typeof v.expiresInMs !== 'number' || !Number.isSafeInteger(v.expiresInMs)
    || v.expiresInMs <= 0 || v.expiresInMs > 300_000) throw Error('Invalid website visit');
  const url = new URL(v.url), hub = new URL(hubOrigin);
  const local = (name: string) => name === '127.0.0.1' || name === '[::1]' || name === 'localhost' || name.endsWith('.localhost');
  if (url.href !== v.url || url.pathname !== '/' || url.search || url.hash || url.username || url.password
    || !/^[a-f0-9]{48}\./.test(url.hostname) || url.hostname === hub.hostname
    || url.hostname.endsWith(`.${hub.hostname}`) || hub.hostname.endsWith(`.${url.hostname.split('.').slice(1).join('.')}`)
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local(url.hostname) && local(hub.hostname)))) throw Error('Invalid website visit');
  return { url: v.url, expiresInMs: v.expiresInMs };
}

export function websitePaneTarget(resourceId: string): [string, string] | undefined {
  try {
    const v = JSON.parse(resourceId);
    return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(v[0])
      && validWebsiteId(v[1]) && JSON.stringify(v) === resourceId ? v as [string, string] : undefined;
  } catch { return undefined; }
}

const tags = new Set(['P', 'DIV', 'SPAN', 'MAIN', 'ARTICLE', 'SECTION', 'HEADER', 'FOOTER', 'NAV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'UL', 'OL', 'LI', 'PRE', 'CODE', 'BLOCKQUOTE', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'SMALL', 'BR', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'DL', 'DT', 'DD', 'A']);
const drop = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'NOSCRIPT', 'HEAD']);
/** Template contents remain inert. Copy only semantic HTML elements/text into a
 * new inert tree; never copy attributes, URLs, CSS or SVG. Iterative bounded walk
 * avoids recursion overflow/DOM explosion from an untrusted local service. */
export function websiteSnapshotTree(content: string, format: 'html' | 'text', doc: Document): HTMLTemplateElement {
  if (new TextEncoder().encode(content).length > WEBSITE_MAX_BYTES) throw Error('Snapshot too large');
  const clean = doc.createElement('template');
  if (format === 'text') { const pre = doc.createElement('pre'); pre.textContent = content; clean.content.append(pre); }
  else {
    const source = doc.createElement('template'); source.innerHTML = content;
    const pending: { from: Node; to: Node; depth: number }[] = [{ from: source.content, to: clean.content, depth: 0 }];
    let budget = 12_000;
    while (pending.length) {
      const { from, to, depth } = pending.pop()!;
      if (depth > 80) throw Error('Snapshot too complex');
      const nested: typeof pending = [];
      for (const child of from.childNodes) {
        if (--budget < 0) throw Error('Snapshot too complex');
        if (child.nodeType === 3) { to.appendChild(doc.createTextNode(child.textContent ?? '')); continue; }
        if (child.nodeType !== 1) continue;
        const element = child as Element;
        if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || drop.has(element.tagName)) continue;
        const target = doc.createElement(tags.has(element.tagName) ? element.tagName.toLowerCase() : 'span');
        to.appendChild(target); nested.push({ from: child, to: target, depth: depth + 1 });
      }
      pending.push(...nested.reverse());
    }
  }
  return clean;
}

export function websiteSnapshotDocument(content: string, format: 'html' | 'text', doc: Document): string {
  const clean = websiteSnapshotTree(content, format, doc);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><style>html{color-scheme:light;color:#172334;background:#fffefa;font:15px/1.55 system-ui}body{margin:20px;overflow-wrap:anywhere}pre{white-space:pre-wrap}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #8888;padding:6px}blockquote{border-left:3px solid #8888;margin-left:0;padding-left:1em}</style></head><body>${clean.innerHTML}</body></html>`;
}
