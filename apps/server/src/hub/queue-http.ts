import type { Context, Hono } from 'hono';
import { MAX_MESSAGE_CHARS, MAX_TEXT_MESSAGE_BODY_BYTES } from '@agentopsdeck/shared';
import { HTTPException } from 'hono/http-exception';
import { reply } from '../commands/http.js';
import { CommandCapacity, CommandConflict, type CommandReceipt } from '../commands/receipts.js';
import { readJsonBody } from '../utils/http-body.js';
import { requestOwnerControl, type OwnerControlHttpDeps } from './owner-control.js';
import { StorageAdmissionDeferred } from '../storage/work-admission.js';

// Owner queue boundary. Shared actors use their original delegated command
// provenance, never this owner credential or an owner-wide queue enumeration.
export function registerHubQueueRoutes(app: Hono, path: string, deps: OwnerControlHttpDeps) {
  const fail = (c: Context, error: unknown) => error instanceof HTTPException
    ? c.json({ error: 'Queue request rejected', status: error.status }, error.status) : deps.error(c, error);
  app.get(`${path}/queue/:messageId/commands/:mutationKey`, async c => {
    c.header('Cache-Control', 'no-store');
    try {
      const t = await requestOwnerControl(c, deps, 'queue'), key = c.req.param('mutationKey');
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return c.json({ error: 'Invalid mutation key' }, 400);
      if (!await t.get(key)) return c.json({ error: 'Queue mutation not found' }, 404);
      return c.json({ command: await t.recover(key) });
    } catch (error) { return fail(c, error); }
  });
  for (const method of ['GET', 'PATCH', 'DELETE'] as const) app.on(method, `${path}/queue${method === 'GET' ? '' : '/:messageId'}`, async c => {
    c.header('Cache-Control', 'no-store');
    try {
      const t = await requestOwnerControl(c, deps, 'queue');
      const body = method === 'PATCH' ? await readJsonBody(c.req.raw, MAX_TEXT_MESSAGE_BODY_BYTES) : undefined;
      await t.check(); c.req.raw.signal.throwIfAborted();
      const key = method === 'GET' ? undefined : c.req.header('idempotency-key');
      const headers = new Headers();
      if (method === 'PATCH') headers.set('content-type', 'application/json');
      if (method !== 'GET' && c.req.header('if-match') !== undefined) headers.set('if-match', c.req.header('if-match')!);
      if (key === undefined) {
        const upstream = method === 'GET' ? `${t.upstream}?cursor=${encodeURIComponent(c.req.query('cursor') ?? '0')}` : t.upstream;
        const result = await (await t.client()).jsonResponse(upstream, { method, headers,
          ...(method === 'PATCH' ? { body: JSON.stringify(body) } : {}), signal: c.req.raw.signal });
        await t.check(); return c.json(result.body as any, result.status as any);
      }
      if (!t.nodeId) return c.json({ error: 'Verify the Connector identity before using mutation receipts' }, 409);
      const match = headers.get('if-match');
      if (match === null) return c.json({ error: 'Queue version is required' }, 428);
      if (!/^"[1-9]\d{0,15}:[1-9]\d{0,15}"$/.test(match)) return c.json({ error: 'Invalid queue version' }, 400);
      const message = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).message : undefined;
      if (method === 'PATCH' && (typeof message !== 'string' || !message.trim() || message.length > MAX_MESSAGE_CHARS)) return c.json({ error: 'Invalid queued message' }, 400);
      const text = method === 'PATCH' ? (message as string).trim() : '';
      let fresh: boolean;
      try {
        ({ fresh } = await t.claim(key, { method, version: match, text }));
        await t.check(); c.req.raw.signal.throwIfAborted();
      }
      catch (error) {
        if (error instanceof CommandConflict) return c.json({ error: 'Queue mutation identity conflicts' }, 409);
        if (error instanceof CommandCapacity) return c.json({ error: 'Command capacity reached' }, 503);
        if (error instanceof StorageAdmissionDeferred) return c.json({ error: 'Command storage admission unavailable' }, 503);
        throw error;
      }
      c.header('X-AgentOpsDeck-Command-Key', key);
      if (!fresh) return reply(c, await t.recover(key));
      headers.set('idempotency-key', await t.deliveryKey(key));
      try {
        const result = await (await t.client()).jsonResponse<{ ok?: boolean; command?: CommandReceipt }>(t.upstream, { method, headers,
          ...(method === 'PATCH' ? { body: JSON.stringify({ message: text }) } : {}), signal: c.req.raw.signal });
        await t.bound(key);
        if (result.body.command) await t.settle(key, { ...result.body.command, result: { status: result.status, body: { ok: result.body.ok } } });
      } catch {
        // Even a 4xx may be a local post-delivery authorization failure. Only a
        // matching durable Connector receipt proves acceptance or rejection.
        await t.bound(key);
      }
      return reply(c, await t.recover(key));
    } catch (error) { return fail(c, error); }
  });
}
