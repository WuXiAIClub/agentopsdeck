import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { validBoardId, validBoardUuid } from '@agentopsdeck/shared';
import type { HubStore } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';
import type { ConnectorClientResolver } from '../hub/connector-client.js';
import { decodeHubSessionId } from '../hub/session-id.js';
import { validHubBoardBindingInput } from '../hub/workspace-board-bindings.js';
import { readJsonBody } from '../utils/http-body.js';
import type { AsyncHubBoardBindings } from '../hub/async-board-bindings.js';
import type { AsyncConnectorClientResolver } from '../hub/async-connector-client.js';
import { registerAsyncHubBoardBindings } from './hub-async-workspace-board-bindings.js';

type Remote = { binding: null | { id: string; runtime: string; sessionId: string; expiresAt: number; state: string }; runtime: string; sessionId: string };
const validRemote = (v: Remote) => v && ['claude-code', 'ghcp', 'codex'].includes(v.runtime) && validBoardUuid(v.sessionId)
  && (v.binding === null || v.binding && validBoardUuid(v.binding.id) && v.binding.runtime === v.runtime && v.binding.sessionId === v.sessionId
    && Number.isSafeInteger(v.binding.expiresAt) && ['installed', 'removed'].includes(v.binding.state));

/** An explicit grant transfer, never a token delivery to the browser. Recovery
 * performs GET only. One process admission plus durable intent guards lost
 * responses; revocation denies the Hub credential before any remote cleanup. */
export function registerHubBoardBindings(app: Hono, deps: { hubStore: HubStore; principal: (c: Context) => HubPrincipal;
  connectorClient: ConnectorClientResolver; endpoint?: string | undefined;
  access?: AsyncHubBoardBindings; asyncConnectorClient?: AsyncConnectorClientResolver }) {
  if (deps.access) return registerAsyncHubBoardBindings(app, { access: deps.access,
    ...(deps.asyncConnectorClient ? { asyncConnectorClient: deps.asyncConnectorClient } : {}),
    ...(deps.endpoint ? { endpoint: deps.endpoint } : {}) });
  const store = deps.hubStore, pending = new Set<string>(); let closed = false;
  const base = '/api/hub/v1/workspace/boards/:boardId/bindings';
  const resource = (c: Context) => {
    c.header('Cache-Control', 'no-store');
    const owner = deps.principal(c).userId, board = c.req.param('boardId')!;
    if (closed) throw new HTTPException(503);
    if (!validBoardId(board)) throw new HTTPException(404);
    return { owner, board };
  };
  const target = (c: Context, owner: string, sessionId: string) => {
    const decoded = decodeHubSessionId(sessionId);
    if (!decoded || !/^(claude-code|ghcp|codex):/.test(decoded.remoteSessionKey)) throw new HTTPException(400);
    const connection = store.getConnection(decoded.connectionId, owner), authority = store.connectionAuthority(decoded.connectionId, owner);
    if (!connection?.nodeId || connection.status === 'disabled' || authority === undefined) throw new HTTPException(404);
    const valid = () => {
      if (closed || deps.principal(c).userId !== owner || store.connectionAuthority(decoded.connectionId, owner) !== authority) throw new HTTPException(403);
    };
    valid();
    return { ...decoded, authority, valid, client: deps.connectorClient(decoded.connectionId, false, owner), path: `/sessions/${encodeURIComponent(decoded.remoteSessionKey)}/board-binding` };
  };
  const safe = (fn: (c: Context) => Promise<Response> | Response) => async (c: Context) => {
    try { return await fn(c); }
    catch (e) { return c.json({ error: 'Task binding unavailable. Inspect the original binding; no message was sent.' }, e instanceof HTTPException ? e.status : 502); }
  };
  const exclusive = async (key: string, fn: () => Promise<Response>) => {
    if (pending.has(key)) throw new HTTPException(409);
    if (pending.size >= 16) throw new HTTPException(429);
    pending.add(key); try { return await fn(); } finally { pending.delete(key); }
  };
  app.get(base, safe(c => {
    const { owner, board } = resource(c);
    return c.json({ enabled: !!deps.endpoint && store.boardBindings.enabled, bindings: store.boardBindings.list(owner, board) });
  }));
  app.post(base, safe(async c => {
    const { owner, board } = resource(c), input = await readJsonBody(c.req.raw, 16_384);
    if (deps.principal(c).userId !== owner) throw new HTTPException(401);
    if (!validHubBoardBindingInput(input)) throw new HTTPException(400);
    if (!deps.endpoint || !store.boardBindings.enabled) throw new HTTPException(503);
    const a = target(c, owner, input.sessionId);
    return exclusive(JSON.stringify([owner, input.sessionId]), async () => {
      // A repeated HTTP request only returns its durable receipt. It never
      // silently retries a PUT which may already have been admitted remotely.
      const previous = store.boardBindings.get(owner, board, input.requestId);
      if (previous) {
        const matched = store.boardBindings.prepare(owner, board, input, a.connectionId, a.authority, deps.endpoint!);
        if (!matched) throw new HTTPException(409);
        return c.json({ binding: matched, repeated: true });
      }
      const remote = await a.client.json<Remote>(a.path, { signal: c.req.raw.signal }); a.valid();
      if (!validRemote(remote) || !a.remoteSessionKey.startsWith(remote.runtime + ':')) throw new HTTPException(502);
      if (remote.binding?.state === 'installed') throw new HTTPException(409);
      const binding = store.boardBindings.prepare(owner, board, input, a.connectionId, a.authority, deps.endpoint!);
      if (!binding) throw new HTTPException(409);
      const credential = store.boardBindings.credential(owner, board, input.requestId);
      if (!credential) throw new HTTPException(409);
      // Mark uncertain BEFORE network dispatch so a Hub crash cannot leave an
      // apparently never-delivered receipt for a completed remote installation.
      store.boardBindings.outcome(owner, board, input.requestId, 'uncertain');
      try {
        const result = await a.client.json<{ binding: Remote['binding'] }>(a.path, { method: 'PUT', body: JSON.stringify({ id: input.requestId, credential }), signal: c.req.raw.signal });
        a.valid();
        if (!validRemote({ ...remote, binding: result?.binding }) || result.binding?.id !== input.requestId || result.binding.state !== 'installed'
          || result.binding.expiresAt !== binding.expiresAt) throw new HTTPException(502);
        return c.json({ binding: store.boardBindings.outcome(owner, board, input.requestId, 'installed') }, 201);
      } catch {
        a.valid();
        return c.json({ binding: store.boardBindings.get(owner, board, input.requestId) }, 202);
      }
    });
  }));
  app.get(`${base}/:id`, safe(async c => {
    const { owner, board } = resource(c), id = c.req.param('id')!;
    if (!validBoardUuid(id)) throw new HTTPException(404);
    const binding = store.boardBindings.get(owner, board, id); if (!binding) throw new HTTPException(404);
    if (['revoked', 'expired', 'unavailable'].includes(binding.state)) return c.json({ binding });
    const a = target(c, owner, binding.sessionId);
    const remote = await a.client.json<Remote>(a.path, { signal: c.req.raw.signal }); a.valid();
    if (!validRemote(remote) || !a.remoteSessionKey.startsWith(remote.runtime + ':')) throw new HTTPException(502);
    if (remote.binding?.id === id && remote.binding.expiresAt === binding.expiresAt && remote.binding.state === 'installed') {
      return c.json({ binding: store.boardBindings.outcome(owner, board, id, 'installed') });
    }
    // Missing may mean an in-flight install. Do not call PUT or assume revoke.
    return c.json({ binding: store.boardBindings.outcome(owner, board, id, 'uncertain') });
  }));
  app.post(`${base}/:id/cancel-intent`, safe(async c => {
    const { owner, board } = resource(c), id = c.req.param('id')!;
    if (!validBoardUuid(id) || c.req.url.includes('?')) throw new HTTPException(400);
    const body = await readJsonBody(c.req.raw, 64);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new HTTPException(400);
    if (deps.principal(c).userId !== owner) throw new HTTPException(401);
    const receipt = store.boardBindings.cancelIntent(owner, board, id);
    if (!receipt) throw new HTTPException(429);
    // No Connector retry here. Existing managed files are denied immediately;
    // their listed revoked binding retains the normal explicit cleanup action.
    return c.json(receipt);
  }));
  app.delete(`${base}/:id`, safe(async c => {
    const { owner, board } = resource(c), id = c.req.param('id')!;
    if (!validBoardUuid(id)) throw new HTTPException(404);
    const binding = store.boardBindings.revoke(owner, board, id); if (!binding) throw new HTTPException(404);
    let cleanup = 'pending';
    try {
      const a = target(c, owner, binding.sessionId);
      const result = await a.client.json<{ id: string; state: string }>(`${a.path}/${encodeURIComponent(id)}`, { method: 'DELETE', signal: c.req.raw.signal }); a.valid();
      if (result?.id === id && result.state === 'removed') cleanup = 'confirmed';
    } catch { /* Hub credential is already revoked, even if Connector offline. */ }
    if (deps.principal(c).userId !== owner) throw new HTTPException(401);
    return c.json({ binding, cleanup });
  }));
  return { close: () => { closed = true; } };
}
