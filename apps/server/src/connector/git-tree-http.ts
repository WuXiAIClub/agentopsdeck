import type { Hono } from 'hono';
import { registerFileRequestOwnership, type ConnectorFileAuthority } from './file-authority.js';
import { GitTreeReader, GitTreeReadError } from './git-tree-reader.js';
import { basename } from 'node:path';

/** Explicitly configured workspace roots only. Token identity fences every
 * opaque path and cursor; session sharing never implies machine-file access. */
export function registerGitTreeRoutes(app: Hono, tokens: ConnectorFileAuthority, roots: Record<string, string> = {}) {
  const base = '/api/connector/v1/files/git';
  const requests = registerFileRequestOwnership(app, base);
  const reader = new GitTreeReader(async (owner, ref) => {
    requests.check();
    const allowed = await tokens.hasScope(owner, 'files:read');
    requests.check();
    return allowed === true && Object.hasOwn(roots, ref) ? owner : undefined;
  });
  const registrations = new Map<string, Promise<void>>();
  const busy = new Set<string>();
  app.get(`${base}/roots`, async c => {
    if (!await tokens.authenticate(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
    const actor = await tokens.requireScope(c.req.raw, 'files:read');
    if (!actor) return c.json({ error: 'File access required' }, 403);
    if (await tokens.hasScope(actor.tokenId, 'files:read') !== true) return c.json({ error: 'File access revoked' }, 403);
    c.header('Cache-Control', 'no-store');
    return c.json({ roots: Object.keys(roots).map(repositoryRef => ({ repositoryRef,
      label: basename(roots[repositoryRef]!).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 256) || repositoryRef })), readOnly: true });
  });
  for (const operation of ['tree', 'preview']) app.get(`${base}/:repositoryRef/${operation}`, async c => {
    c.header('Cache-Control', 'no-store');
    if (!await tokens.authenticate(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
    const actor = await tokens.requireScope(c.req.raw, 'files:read');
    requests.check(c.req.raw);
    if (!actor) return c.json({ error: 'File access required' }, 403);
    const ref = c.req.param('repositoryRef');
    if (!ref || !Object.hasOwn(roots, ref)) return c.json({ error: 'Repository unavailable' }, 404);
    const query = c.req.queries();
    const preview = c.req.path.endsWith('/preview');
    if (preview && !query.pathToken || Object.keys(query).some(key => !(preview ? ['pathToken'] : ['pathToken', 'cursor']).includes(key))
      || Object.values(query).some(values => values.length !== 1 || !/^[a-f0-9-]{36}$/.test(values[0]!))) return c.json({ error: 'Invalid tree query' }, 400);
    const key = JSON.stringify([actor.tokenId, ref]);
    if (busy.has(actor.tokenId) || busy.size >= 8) return c.json({ error: 'Tree read already active' }, 429);
    busy.add(actor.tokenId);
    try {
      await reader.pruneRevoked();
      for (const registered of registrations.keys()) {
        const [owner] = JSON.parse(registered) as [string, string];
        if (await tokens.hasScope(owner, 'files:read') !== true) registrations.delete(registered);
      }
      let ready = registrations.get(key);
      if (!ready) {
        if (registrations.size >= 64) return c.json({ error: 'Repository capacity reached' }, 429);
        ready = reader.register(actor.tokenId, ref, actor.tokenId, roots[ref]!, () => requests.check(c.req.raw));
        registrations.set(key, ready);
        void ready.catch(() => { if (registrations.get(key) === ready) registrations.delete(key); });
      }
      await ready;
      requests.check(c.req.raw);
      const result = preview ? await reader.preview(actor.tokenId, ref, c.req.query('pathToken')!, () => requests.check(c.req.raw))
        : await reader.list(actor.tokenId, ref, c.req.query('pathToken'), c.req.query('cursor'), 200, () => requests.check(c.req.raw));
      if (await tokens.hasScope(actor.tokenId, 'files:read') !== true) return c.json({ error: 'File access revoked' }, 403);
      requests.check(c.req.raw);
      return c.json(result);
    } catch (error) {
      if (await tokens.hasScope(actor.tokenId, 'files:read') !== true) return c.json({ error: 'File access revoked' }, 403);
      requests.check(c.req.raw);
      // Never expose filesystem paths or OS errors through this boundary.
      return c.json({ error: error instanceof GitTreeReadError ? 'Tree changed or reference expired; refresh explicitly' : 'Tree read unavailable' }, 409);
    } finally { busy.delete(actor.tokenId); }
  });
  return { close: () => requests.close() };
}
