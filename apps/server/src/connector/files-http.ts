import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { FileBrowserScope } from '@agentopsdeck/shared';
import { fileAuthorityPending, registerFileRequestOwnership, type ConnectorFileAuthority } from './file-authority.js';
import { listDirectory, listSourceDirectory, previewFile, readWorkspaceFile, saveWorkspaceText } from '../routes/files.js';
import { registerGitTreeRoutes } from './git-tree-http.js';

export { localFileBrowserScopes } from './local-credential-plan.js';

/** Machine files are owner-only, explicit opt-in roots and an independent scope.
 * Session sharing / runtime development permissions never imply file access. */
export function registerConnectorFileRoutes(app: Hono, tokens: ConnectorFileAuthority, roots: Record<string, string> = {}) {
  const base = '/api/connector/v1/files';
  const requests = registerFileRequestOwnership(app, base);
  app.use(`${base}/*`, async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const authentication = tokens.authenticate(c.req.raw);
    if (!(fileAuthorityPending(authentication) ? await authentication : authentication)) return c.json({ error: 'unauthorized' }, 401);
    requests.check(c.req.raw);
    // A disabled workspace is not a missing user permission. Disclose no paths
    // and never silently grant file access to a session-reading credential.
    if (!Object.keys(roots).length) return c.json({ error: 'Workspace browsing is not configured on this Connector.' }, 409);
    const authorization = tokens.requireScope(c.req.raw, 'files:read');
    const actor = fileAuthorityPending(authorization) ? await authorization : authorization;
    requests.check(c.req.raw);
    if (!actor) return c.json({ error: 'Workspace browsing requires files:read on the Connector token.' }, 403);
    await next();
    if (await tokens.hasScope(actor.tokenId, 'files:read') !== true) {
      // next() already finalized the response: returning JSON alone does not
      // replace it. Remove download metadata before replacing the body as well.
      c.header('Content-Length', undefined);
      c.header('Content-Disposition', undefined);
      c.res = c.json({ error: 'File access was revoked' }, 403);
    }
  });
  const git = registerGitTreeRoutes(app, tokens, roots);
  app.get(`${base}/roots`, async c => {
    const writer = await tokens.requireScope(c.req.raw, 'files:write');
    return c.json({ roots: Object.keys(roots).map(agentId => ({ agentId, label: agentId, readOnly: !writer })) });
  });
  app.post(`${base}/agents/:agentId/text`, bodyLimit({ maxSize: 2 * 1024 * 1024, onError: c => c.json({ error: 'Text write too large' }, 413) }), async c => {
    const actor = await tokens.requireScope(c.req.raw, 'files:write');
    requests.check(c.req.raw);
    if (!actor) return c.json({ error: 'Text editing requires files:write on the Connector token.' }, 403);
    const agentId = c.req.param('agentId');
    const root = Object.hasOwn(roots, agentId) ? roots[agentId] : undefined;
    if (!root) return c.json({ error: 'No workspace is configured for this agent.' }, 404);
    if (Number(c.req.header('Content-Length')) > 2 * 1024 * 1024) return c.json({ error: 'Text write too large' }, 413);
    try {
      const raw = await c.req.text();
      if (Buffer.byteLength(raw) > 2 * 1024 * 1024) return c.json({ error: 'Text write too large' }, 413);
      let input: unknown;
      try { input = JSON.parse(raw); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
      return c.json(await saveWorkspaceText({ type: 'agent', agentId, rootLabel: agentId }, input, root,
        async () => {
          requests.check(c.req.raw);
          const writer = await tokens.requireScope(c.req.raw, 'files:write');
          requests.check(c.req.raw);
          return writer?.tokenId === actor.tokenId && writer.scopes.includes('files:read');
        }, () => requests.check(c.req.raw)));
    } catch (error) {
      const status = (error as { status?: number }).status;
      return c.json({ error: status ? (error as Error).message : 'Text save not confirmed; reload before retrying.' }, (status ?? 500) as 400);
    }
  });
  for (const operation of ['', '/preview', '/download']) app.get(`${base}/agents/:agentId${operation}`, async c => {
    const agentId = c.req.param('agentId');
    const root = Object.hasOwn(roots, agentId) ? roots[agentId] : undefined;
    if (!root) return c.json({ error: 'No workspace is configured for this agent. Configure AOD_FILE_ROOTS_JSON on this Connector.' }, 404);
    const scope: FileBrowserScope = { type: 'agent', agentId, rootLabel: agentId };
    const requestedPath = c.req.query('path') ?? '';
    try {
      if (operation === '/download') {
        const file = await readWorkspaceFile(scope, requestedPath, root);
        c.header('Content-Type', 'application/octet-stream');
        c.header('X-Content-Type-Options', 'nosniff');
        c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16)}`)}`);
        c.header('Content-Length', String(file.bytes.length));
        return c.body(file.bytes);
      }
      if (operation === '/preview') {
        const preview = await previewFile(scope, requestedPath, root);
        // No legacy/local download URLs or embedded remote HTML/PDF navigation.
        const { downloadUrl: _url, ...safe } = preview;
        return c.json({ ...safe, canEdit: !!safe.revision && !!await tokens.requireScope(c.req.raw, 'files:write'), kind: safe.kind === 'pdf' ? 'binary' : safe.kind });
      }
      const sourcePath = c.req.query('sourcePath');
      const result = sourcePath === undefined ? await listDirectory(scope, requestedPath, root) : await listSourceDirectory(scope, sourcePath, root);
      return c.json({ ...result, entries: result.entries.map(entry => ({ ...entry, canUpload: false, canRename: false, canDelete: false })) });
    } catch (error) {
      const status = (error as { status?: number }).status;
      return c.json({ error: status ? (error as Error).message : 'Workspace read failed' }, (status && status >= 400 && status <= 599 ? status : 500) as 400);
    }
  });
  return { close: () => Promise.all([requests.close(), git.close()]).then(() => undefined) };
}
