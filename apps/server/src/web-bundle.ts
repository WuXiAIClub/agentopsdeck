import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';

const IMMUTABLE_ASSET_PATH = /^\/assets\/([^/]+-[A-Za-z0-9_-]{8}\.(?:js|css))$/;

function findSiblingReleaseAsset(directory: string, fileName: string, fallbackRoots?: readonly string[]): string | undefined {
  const roots = fallbackRoots ? [...fallbackRoots] : (() => {
    const activeDir = resolve(directory);
    const releasesRoot = resolve(activeDir, '..', '..', '..', '..');
    if (basename(releasesRoot) !== 'releases' || !existsSync(releasesRoot)) return [];
    try {
      return readdirSync(releasesRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => {
          const assetsDir = join(releasesRoot, entry.name, 'apps', 'web', 'dist', 'assets');
          try {
            const stat = statSync(assetsDir);
            return stat.isDirectory() ? { assetsDir, mtimeMs: stat.mtimeMs } : undefined;
          } catch {
            return undefined;
          }
        })
        .filter((item): item is { assetsDir: string; mtimeMs: number } => item !== undefined)
        .sort((first, second) => second.mtimeMs - first.mtimeMs)
        .map(item => item.assetsDir);
    } catch {
      return [];
    }
  })();
  for (const assetsDir of roots) {
    const candidate = join(assetsDir, fileName);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return undefined;
}

export function registerWebBundle(app: Hono, directory: string, options?: { fallbackAssetDirectories?: readonly string[]; publicBaseUrl?: string | undefined }) {
  const index = join(directory, 'index.html');
  if (!existsSync(index)) return false;
  let resourceOrigin = '';
  try {
    const url = new URL(options?.publicBaseUrl ?? '');
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) resourceOrigin = url.origin;
  } catch {}
  const entryHtml = () => {
    const html = readFileSync(index, 'utf8');
    if (!resourceOrigin) return html;
    const content = resourceOrigin.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return html.replace(/<\/head\s*>/i, () => `<meta name="agentopsdeck-resource-origin" content="${content}"></head>`);
  };
  const fallbackCache = new Map<string, string>();
  app.use('/*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    // An entry page pins all lazy chunk names. Never reuse it after a release.
    if (c.res.headers.get('content-type')?.includes('text/html')) c.header('Cache-Control', 'no-store');
    // Vite content hashes change with the bundle; only successful build assets
    // get long-lived caching. Preserve explicit policies and missing chunks.
    else if ((c.req.method === 'GET' || c.req.method === 'HEAD') && c.res.status === 200
      && IMMUTABLE_ASSET_PATH.test(c.req.path)
      && /^(?:text\/javascript|application\/javascript|text\/css)(?:;|$)/.test(c.res.headers.get('content-type') ?? '')
      && !c.res.headers.has('Cache-Control')) {
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
    }
  });
  app.on(['GET', 'HEAD'], ['/', '/index.html'], c => c.html(entryHtml()));
  app.use('/*', serveStatic({ root: relative(process.cwd(), directory) || '.' }));
  app.on(['GET', 'HEAD'], '*', c => {
    const path = c.req.path;
    const match = IMMUTABLE_ASSET_PATH.exec(path);
    if (match) {
      const fileName = match[1]!;
      let resolved = fallbackCache.get(fileName);
      if (!resolved || !existsSync(resolved)) {
        resolved = findSiblingReleaseAsset(directory, fileName, options?.fallbackAssetDirectories);
        if (resolved) fallbackCache.set(fileName, resolved);
        else fallbackCache.delete(fileName);
      }
      if (resolved) {
        const content = readFileSync(resolved);
        const contentType = fileName.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
        return c.newResponse(c.req.method === 'HEAD' ? null : content, 200, {
          'Content-Type': contentType,
          'Content-Length': String(content.byteLength),
        });
      }
    }
    if (path === '/api' || path.startsWith('/api/') || path === '/assets' || path.startsWith('/assets/')
      || /\.(?:[cm]?js|tsx?|jsx|css|map|json|wasm|png|jpe?g|svg|ico|woff2?|webmanifest)$/i.test(path)) {
      // Old tabs can still request removed lazy chunks. HTML here produces an
      // opaque MIME error and may be cached by a CDN as a successful script.
      c.header('Cache-Control', 'no-store');
      return c.notFound();
    }
    return c.html(entryHtml());
  });
  return true;
}
