import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ConnectorMachineAuthority } from './machine-authority.js';
import { settleMachineWork } from './machine-authority.js';
import { registerFileRequestOwnership } from './file-authority.js';
import { createTaskDrain } from '../lifecycle/task-drain.js';
import { readJsonBody } from '../utils/http-body.js';
import { WebsiteAccessStore } from './website-access.js';
import type { WebsiteService } from './websites.js';
import { WebsiteSocket, validWebsiteSocketFrame } from './website-sockets.js';

export function registerConnectorWebsiteSockets(app: Hono, tokens: ConnectorMachineAuthority, parents: WebsiteAccessStore<WebsiteService>) {
  const sockets = new WebsiteAccessStore<{ parent: string; socket?: WebsiteSocket }>(Date.now, { total: 8, perOwner: 2 });
  const base = '/api/connector/v1/website-access/:accessId/sockets';
  const requests = registerFileRequestOwnership(app, base, undefined, 'connector-machine-services');
  const background = createTaskDrain();
  const authorize = async (c: Context) => {
    requests.check(c.req.raw);
    if (!await tokens.authenticate(c.req.raw)) throw new HTTPException(401);
    const actor = await tokens.requireScope(c.req.raw, 'websites:connect');
    if (!actor || await tokens.hasScope(actor.tokenId, 'websites:browse') !== true) throw new HTTPException(403);
    requests.check(c.req.raw);
    if (c.req.url.includes('?')) throw new HTTPException(400);
    c.header('Cache-Control', 'no-store');
    return { actor, parent: parents.get(c.req.param('accessId')!, actor.tokenId) };
  };
  const lookup = async (c: Context) => {
    const context = await authorize(c), entry = sockets.get(c.req.param('socketId')!, context.actor.tokenId);
    if (entry.value.parent !== context.parent.id || !entry.value.socket) throw new HTTPException(404);
    return { ...context, entry, socket: entry.value.socket };
  };
  app.post(base, async c => {
    await authorize(c);
    const input = await readJsonBody(c.req.raw, 8192) as { path?: unknown; protocols?: unknown };
    const { actor, parent } = await authorize(c);
    if (!input || Object.keys(input).length !== 2 || typeof input.path !== 'string' || !Array.isArray(input.protocols)
      || !input.protocols.every(v => typeof v === 'string')) throw new HTTPException(400);
    const entry = sockets.create(actor.tokenId, { parent: parent.id }, parent.expiresAt);
    const signal = AbortSignal.any([parent.controller.signal, entry.controller.signal]);
    try {
      const socket = new WebsiteSocket(parent.value, input.path, input.protocols, signal, entry.expiresAt);
      entry.value.socket = socket;
      socket.signal.addEventListener('abort', () => sockets.remove(entry.id), { once: true });
      void background.run(async () => {
        try {
          while (!socket.signal.aborted) {
            const revision = tokens.changes.revision;
            if (await tokens.hasScope(actor.tokenId, 'websites:browse') !== true || await tokens.hasScope(actor.tokenId, 'websites:connect') !== true) { socket.close(); break; }
            await tokens.changes.wait(revision, socket.signal);
          }
        } catch { socket.close(); }
        finally { await socket.settled; }
      }).catch(() => socket.close());
      const abort = () => socket.close(); c.req.raw.signal.addEventListener('abort', abort, { once: true });
      try {
        const protocol = await socket.ready;
        c.req.raw.signal.throwIfAborted(); await authorize(c); sockets.get(entry.id, actor.tokenId);
        return c.json({ socketId: entry.id, protocol });
      } finally { c.req.raw.signal.removeEventListener('abort', abort); }
    } catch (error) {
      sockets.remove(entry.id);
      if (error instanceof HTTPException) throw error;
      throw new HTTPException(502, { message: 'Website channel unavailable' });
    }
  });
  app.get(`${base}/:socketId/output`, async c => {
    const { socket } = await lookup(c);
    const result = await socket.read(c.req.raw.signal);
    await lookup(c); return c.json(result);
  });
  app.post(`${base}/:socketId/input`, async c => {
    const { socket } = await lookup(c), frame = await readJsonBody(c.req.raw, 90 * 1024);
    await lookup(c);
    if (!validWebsiteSocketFrame(frame)) throw new HTTPException(400);
    await socket.send(frame, c.req.raw.signal); await lookup(c);
    return c.json({ sent: true });
  });
  app.delete(`${base}/:socketId`, async c => { const { entry } = await lookup(c); sockets.remove(entry.id); return c.json({ closed: true }); });
  let closing: Promise<void> | undefined;
  return { close: () => {
    if (closing) return closing;
    const drained = requests.close(); sockets.close();
    return closing = settleMachineWork([drained, background.close()]);
  } };
}
