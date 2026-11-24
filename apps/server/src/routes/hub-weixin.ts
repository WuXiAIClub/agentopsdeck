import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HubStore } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';
import type { WeixinService } from '../hub/weixin-service.js';
import { WeixinError, type WeixinTransport } from '../hub/weixin-transport.js';
import { AuthBodyError, AuthBodyReader } from '../auth/request-body.js';
import type { AsyncHubWeixinAccess } from '../hub/async-weixin-access.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { validHubWeixinCommand, type HubWeixinCommand } from '../hub/member-weixin-domain.js';

/** Exact four-entry production package. No fallback to synchronous request
 * identity, store reads or audit, including failures and final delivery. */
function registerAsyncWeixin(app: Hono, access: AsyncHubWeixinAccess, service: WeixinService, transport: WeixinTransport) {
  const base = '/api/hub/v1/weixin', bodies = new AuthBodyReader(4, 5000), pending = new Set<Promise<Response>>();
  let closed = false, closing: Promise<void> | undefined;
  const safe = (run: (c: Context) => Promise<Response>) => (c: Context) => {
    c.header('Cache-Control', 'no-store');
    const original = (async () => {
      try { if (closed) throw new WeixinError('busy'); return await run(c); }
      catch (error) {
        if (error instanceof HubMemberRequestError && error.status === 499) return Response.json({error: 'weixin_denied'}, {status: 499});
        if (error instanceof HubMemberRequestError || error instanceof HTTPException) return c.json({error: 'weixin_denied'}, error.status as Exclude<typeof error.status, 499>);
        if (error instanceof AuthBodyError) return c.json({error: 'weixin_invalid_request'}, error.status);
        const code = error instanceof WeixinError ? error.code : 'unavailable';
        return c.json({error: `weixin_${code}`}, code === 'denied' ? 403 : code === 'busy' ? 429 : code === 'expired' ? 410 : 503);
      }
    })();
    pending.add(original); void original.finally(() => pending.delete(original)).catch(() => {});
    return original;
  };
  const read = async (c: Context) => {
    const value = await bodies.read(c.req.raw, 1024);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuthBodyError(400, 'invalid');
    return value as Record<string, unknown>;
  };
  const execute = async (c: Context, command: HubWeixinCommand, proof: Awaited<ReturnType<AsyncHubWeixinAccess['begin']>>) => {
    if (!validHubWeixinCommand(command)) throw new AuthBodyError(400, 'invalid');
    const result = await proof.command(command);
    if (result.action === 'remove') {
      if (command.action !== 'remove') throw new WeixinError('unavailable');
      service.cancelBinding(command.id); await proof.check(); return c.json({removed: true});
    }
    let state = 'state' in result ? result.state : undefined;
    if ('work' in result && result.work) {
      const reference = result.work;
      let entered = false;
      try {
        state = await service.runBindingEffect('id' in command ? command.id : '', c.req.raw.signal, async signal => {
          entered = true;
          try { return await access.effect(reference, signal, transport); }
          finally { await access.release(reference); }
        }) as typeof state;
      } finally { if (!entered) await access.release(reference); }
    }
    const current = await proof.command({action: 'status'});
    if (current.action !== 'status') throw new WeixinError('unavailable');
    await proof.check();
    return c.json(command.action === 'poll' ? {state, status: current.status} : current.status);
  };
  app.get(base, safe(async c => execute(c, {action: 'status'}, await access.begin(c.req.raw))));
  app.post(`${base}/bindings`, safe(async c => {
    const proof = await access.begin(c.req.raw), value = await read(c);
    if (Object.keys(value).length !== 1) throw new AuthBodyError(400, 'invalid');
    return execute(c, {action: 'start', id: value.id as string}, proof);
  }));
  app.post(`${base}/bindings/:id/poll`, safe(async c => {
    const proof = await access.begin(c.req.raw), value = await read(c);
    if (Object.keys(value).some(k => k !== 'verify')) throw new AuthBodyError(400, 'invalid');
    return execute(c, {action: 'poll', id: c.req.param('id')!, ...(value.verify === undefined ? {} : {verify: value.verify as string})}, proof);
  }));
  app.delete(`${base}/bindings/:id`, safe(async c => execute(c, {action: 'remove', id: c.req.param('id')!}, await access.begin(c.req.raw))));
  return {close: () => {
    if (closing) return closing;
    closed = true;
    // Freeze effects immediately, but keep the private SQL lane open until
    // admitted requests have released their ORIGINAL references and ACKs.
    const effects = service.close();
    closing = (async () => {
      await Promise.all([effects, ...pending]);
      await access.close();
    })();
    return closing;
  }};
}

export function registerHubWeixin(app: Hono, deps: { service: WeixinService } & (
  { access: AsyncHubWeixinAccess; transport: WeixinTransport; store?: HubStore; principal?: (c: Context) => HubPrincipal; administrator?: (request: Request) => boolean }
  | { store: HubStore; principal: (c: Context) => HubPrincipal; administrator?: (request: Request) => boolean; access?: undefined; transport?: undefined })) {
  if (deps.access) {
    if (!deps.transport) throw new WeixinError('not_configured');
    return registerAsyncWeixin(app, deps.access, deps.service, deps.transport);
  }
  if (!deps.store || typeof deps.principal !== 'function') throw new WeixinError('not_configured');
  const base = '/api/hub/v1/weixin', bodies = new AuthBodyReader(4, 5000);
  const identity = (c: Context) => {
    const actor = deps.principal(c), key = deps.store.identities.requestIdentity(c.req.raw);
    const personalKey = key?.userId === actor.userId;
    const administratorKey = actor.userId === 'default' && actor.admin && deps.administrator?.(c.req.raw) === true
      ? deps.store.weixinAdministratorKeyId : undefined;
    const row = deps.store.weixin.get(actor.userId);
    // A personal default-member Key is not bootstrap administrator access.
    if (row && deps.store.weixin.principal(row)?.admin && !actor.admin) throw new WeixinError('denied');
    return { actor, personalKey, administratorKey: !!administratorKey, keyId: personalKey ? key.keyId : administratorKey };
  };
  const status = (c: Context) => {
    const { actor, personalKey, administratorKey } = identity(c);
    return { ...deps.service.status(actor.userId, personalKey), administratorKey };
  };
  const safe = (run: (c: Context) => Promise<Response> | Response) => async (c: Context) => {
    c.header('Cache-Control', 'no-store');
    try { return await run(c); }
    catch (e) {
      if (e instanceof HTTPException) return c.json({ error: 'weixin_denied' }, e.status);
      if (e instanceof AuthBodyError) return c.json({ error: 'weixin_invalid_request' }, e.status);
      const code = e instanceof WeixinError ? e.code : 'unavailable';
      return c.json({ error: `weixin_${code}` }, code === 'denied' ? 403 : code === 'busy' ? 429 : code === 'expired' ? 410 : 503);
    }
  };
  const body = async (c: Context, user: string) => {
    const value = await bodies.read(c.req.raw, 1024);
    if (deps.principal(c).userId !== user) throw new WeixinError('denied');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuthBodyError(400, 'invalid');
    return value as Record<string, unknown>;
  };
  app.get(base, safe(c => c.json(status(c))));
  app.post(`${base}/bindings`, safe(async c => {
    const { actor, keyId } = identity(c); if (!keyId) throw new WeixinError('denied');
    const value = await body(c, actor.userId);
    if (Object.keys(value).length !== 1 || typeof value.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.id)) throw new AuthBodyError(400, 'invalid');
    const authorize = () => { if (identity(c).keyId !== keyId) throw new WeixinError('denied'); };
    await deps.service.start(actor.userId, keyId, value.id, c.req.raw.signal, authorize);
    return c.json(status(c));
  }));
  app.post(`${base}/bindings/:id/poll`, safe(async c => {
    const { actor, keyId } = identity(c); if (!keyId) throw new WeixinError('denied');
    const value = await body(c, actor.userId);
    if (Object.keys(value).some(k => k !== 'verify') || value.verify !== undefined && (typeof value.verify !== 'string' || !/^\d{4,8}$/.test(value.verify))) throw new AuthBodyError(400, 'invalid');
    const authorize = () => { if (identity(c).keyId !== keyId) throw new WeixinError('denied'); };
    const result = await deps.service.poll(actor.userId, c.req.param('id')!, value.verify as string | undefined, c.req.raw.signal, authorize);
    return c.json({ ...result, status: status(c) });
  }));
  app.delete(`${base}/bindings/:id`, safe(c => {
    const { actor } = identity(c); deps.service.remove(actor.userId, c.req.param('id')!);
    return c.json({ removed: true });
  }));
  return {close: () => deps.service.close()};
}
