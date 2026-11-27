import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ConnectorClientError } from '../hub/connector-client.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { weixinRequestBinding } from '../hub/weixin-bridge.js';
import { legacyHubConnectionProxyDeps, resolveHubConnectionProxyClient, validateHubConnectionProxyRouteDeps,
  type HubConnectionProxyRouteDeps } from '../hub/connection-proxy-route-deps.js';
import { readJsonBody } from '../utils/http-body.js';

export function registerHubAhp(app: Hono, deps: HubConnectionProxyRouteDeps) {
  validateHubConnectionProxyRouteDeps(deps);
  const work = new HubRequestWork();
  const route = '/api/hub/v1/connections/:connectionId/ahp';
  async function request(c: Context, method: 'GET' | 'POST') {
    c.header('Cache-Control', 'no-store');
    try {
      return await work.run(async () => {
        const id = c.req.param('connectionId');
        if (!id || new URL(c.req.url).search) throw new HTTPException(400);
        if (weixinRequestBinding(c.req.raw)) throw new HTTPException(403);
        const access = deps.access ? await deps.access.begin(c.req.raw, id) : undefined;
        const legacy = () => legacyHubConnectionProxyDeps(deps);
        const user = access?.principal.userId ?? legacy().principal(c).userId;
        const connection = access?.connection ?? legacy().hubStore.getConnection(id, user);
        if (!connection || connection.status === 'disabled') throw new HTTPException(404);
        const version = access ? undefined : legacy().hubStore.connectionAuthority(id, user);
        const check = async () => {
          work.check();
          if (access) await access.check();
          else if (legacy().principal(c).userId !== user || legacy().hubStore.connectionAuthority(id, user) !== version) throw new HTTPException(403);
          work.check();
          if (c.req.raw.signal.aborted) throw new HTTPException(408);
        };
        const init: RequestInit = { method, signal: c.req.raw.signal };
        if (method === 'POST') {
          if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new HTTPException(415);
          const key = c.req.header('idempotency-key');
          if (!key || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) throw new HTTPException(400);
          const body = await readJsonBody(c.req.raw, 32 * 1024);
          if (!body || typeof body !== 'object' || Object.keys(body).length !== 1 || !('text' in body) || typeof body.text !== 'string'
            || !body.text.trim() || Buffer.byteLength(body.text) > 16_384) throw new HTTPException(400);
          init.headers = { 'content-type': 'application/json', 'idempotency-key': key };
          init.body = JSON.stringify({ text: body.text });
        }
        const client = await resolveHubConnectionProxyClient(deps, c.req.raw, id, user);
        await check();
        let response;
        try { response = await client.jsonResponseOriginal<unknown>('/ahp', init); }
        catch (error) { await check(); throw error; }
        await check();
        const body = response.body;
        if (!body || typeof body !== 'object') throw new HTTPException(502);
        if (method === 'POST') {
          if (!('id' in body) || typeof body.id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.id)) throw new HTTPException(502);
          return c.json({ id: body.id });
        }
        if (!('title' in body) || typeof body.title !== 'string' || !('canSend' in body) || typeof body.canSend !== 'boolean'
          || !('turns' in body) || !Array.isArray(body.turns) || body.turns.length > 40 || body.title.length > 512) throw new HTTPException(502);
        const turns = body.turns.map((turn: unknown) => {
          if (!turn || typeof turn !== 'object' || !('id' in turn) || typeof turn.id !== 'string' || turn.id.length > 256
            || !('prompt' in turn) || typeof turn.prompt !== 'string' || turn.prompt.length > 4096
            || !('response' in turn) || typeof turn.response !== 'string' || turn.response.length > 8192
            || !('active' in turn) || typeof turn.active !== 'boolean') throw new HTTPException(502);
          return { id: turn.id, prompt: turn.prompt, response: turn.response, active: turn.active };
        });
        return c.json({ title: body.title, canSend: body.canSend, turns });
      });
    } catch (error) {
      const source = error instanceof HubMemberRequestError || error instanceof HTTPException || error instanceof ConnectorClientError
        ? error.status : 502;
      const status = source === 401 && error instanceof ConnectorClientError ? 403 : source;
      const message = method === 'POST' && status >= 500
        ? 'Message may have been sent; check VS Code before sending again' : 'VS Code chat is unavailable';
      return new Response(JSON.stringify({ error: message }), {
        status: [400, 401, 403, 404, 408, 409, 413, 415, 499, 503].includes(status) ? status : 502,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
  }
  app.get(route, c => request(c, 'GET'));
  app.post(route, c => request(c, 'POST'));
  return { close: () => work.close().then(() => deps.access?.close()) };
}
