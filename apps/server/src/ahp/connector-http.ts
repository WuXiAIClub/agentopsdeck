import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ConnectorOwnerCommands } from '../connector/connector-owner-domain.js';
import { createTaskDrain } from '../lifecycle/task-drain.js';
import { readJsonBody } from '../utils/http-body.js';
import type { AhpConfig } from './config.js';
import { AhpSession } from './session.js';
import { openVsCodeTransport } from './vscode-transport.js';

export function registerConnectorAhp(app: Hono, config: AhpConfig, deps: {
  command: <K extends 'tokenAuthenticate' | 'ahpClaim' | 'ahpSettle' | 'ahpAdmission'>(kind: K,
    input: ConnectorOwnerCommands[K]['input']) => Promise<ConnectorOwnerCommands[K]['output']>;
  available?: () => boolean;
  attach?: () => Promise<Pick<AhpSession, 'view' | 'sendText' | 'close'>>;
}) {
  const route = '/api/connector/v1/ahp';
  const resource = config.sessionUri;
  const attach = deps.attach ?? (async () => AhpSession.attach(await openVsCodeTransport(config.cli, config.instanceId), config));
  let closing = false;
  const work = createTaskDrain();
  let attached: ReturnType<typeof attach> | undefined;
  const assertOwner = async (request: Request, write = false) => {
    const authorization = request.headers.get('authorization');
    if (!authorization || authorization.length > 4096 || request.headers.has('x-agentopsdeck-execution-grant')) throw new HTTPException(403);
    const principal = await deps.command('tokenAuthenticate', { authorization });
    if (!principal?.scopes.includes(write ? 'messages:send' : 'messages:read') || principal.scopes.includes('execution:delegate')) {
      throw new HTTPException(403, { message: 'AHP requires Connector owner authority' });
    }
    if (request.signal.aborted) throw new HTTPException(408);
    if (closing || deps.available?.() === false) throw new HTTPException(503);
    return { authorization, principal };
  };
  app.use(route, async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (new URL(c.req.url).search) return c.json({ error: 'Unexpected query' }, 400);
    if (closing || deps.available?.() === false) return c.json({ error: 'Connector unavailable' }, 503);
    await work.run(next);
  });
  app.get(route, async c => {
    const actor = await assertOwner(c.req.raw);
    attached ??= attach();
    const attempt = attached;
    let session;
    try { session = await attempt; }
    catch {
      if (attached === attempt) attached = undefined;
      return c.json({ error: 'VS Code Agent Host is unavailable' }, 503);
    }
    const admission = await deps.command('ahpAdmission', { authorization: actor.authorization, tokenId: actor.principal.tokenId });
    const current = (await assertOwner(c.req.raw)).principal;
    if (current.tokenId !== actor.principal.tokenId) throw new HTTPException(403);
    try {
      const { title, turns, canSend } = session.view();
      return c.json({ title: title.slice(0, 512), turns: turns.slice(-40).map(turn => ({
        ...turn, prompt: turn.prompt.slice(0, 4096), response: turn.response.slice(0, 8192),
      })), canSend: canSend && admission && current.scopes.includes('messages:send') });
    } catch { return c.json({ error: 'VS Code Agent Host is unavailable' }, 503); }
  });
  app.post(route, async c => {
    const actor = await assertOwner(c.req.raw, true);
    if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new HTTPException(415);
    const body = await readJsonBody(c.req.raw, 32 * 1024);
    if (!body || typeof body !== 'object' || Object.keys(body).length !== 1 || !('text' in body) || typeof body.text !== 'string'
      || !body.text.trim() || Buffer.byteLength(body.text) > 16_384) return c.json({ error: 'Invalid AHP message' }, 400);
    const key = c.req.header('idempotency-key');
    if (!key || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return c.json({ error: 'Command key required' }, 400);
    const check = async () => { if ((await assertOwner(c.req.raw, true)).principal.tokenId !== actor.principal.tokenId) throw new HTTPException(403); };
    const session = await attached?.catch(() => undefined);
    await check();
    if (!session) return c.json({ error: 'Open the VS Code chat before sending' }, 409);
    const claim = await deps.command('ahpClaim', { authorization: actor.authorization, tokenId: actor.principal.tokenId,
      resource, key, digest: createHash('sha256').update(body.text).digest('hex') });
    await check();
    if (claim.state === 'denied') return c.json({ error: 'AHP message not authorized' }, 403);
    if (claim.state === 'unavailable') return c.json({ error: 'AHP command admission unavailable' }, 503);
    if (claim.state === 'conflict' || claim.state === 'busy') return c.json({ error: 'AHP command conflicts with current state' }, 409);
    if (claim.state === 'accepted') return c.json({ id: claim.id });
    if (claim.state === 'fresh') {
      if (!await deps.command('ahpAdmission', { authorization: actor.authorization, tokenId: actor.principal.tokenId })) {
        return c.json({ error: 'AHP command admission unavailable' }, 503);
      }
      if (closing || deps.available?.() === false || c.req.raw.signal.aborted) throw new HTTPException(503);
      let id: string;
      try {
        if (!session.view().canSend) {
          await deps.command('ahpSettle', { resource, key, id: null });
          return c.json({ error: 'VS Code chat is not accepting a turn' }, 409);
        }
        id = await session.sendText(body.text);
      } catch { return c.json({ error: 'Message outcome unknown; check VS Code before sending again' }, 502); }
      const settled = await deps.command('ahpSettle', { resource, key, id });
      await check();
      if (settled) return c.json({ id });
    }
    return c.json({ error: 'Message outcome unknown; check VS Code before sending again' }, 502);
  });
  return { close: async () => {
    closing = true;
    const drained = work.close();
    const session = await attached?.catch(() => undefined);
    try { await session?.close(); } finally { await drained; }
  } };
}
