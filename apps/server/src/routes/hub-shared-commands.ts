import type { Context, Hono } from 'hono';
import { MAX_MESSAGE_CHARS, MAX_TEXT_MESSAGE_BODY_BYTES, SHARED_MESSAGE_BODY_BYTES, copySharedMessageInput } from '@agentopsdeck/shared';
import { HTTPException } from 'hono/http-exception';
import { CommandCapacity, CommandConflict } from '../commands/receipts.js';
import { reply } from '../commands/http.js';
import type { Dispatch } from '../connector/transport.js';
import type { HubStore } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';
import type { HubExecutionSync } from '../hub/execution-sync.js';
import { sharedSessionAccess } from './hub-shared-access.js';
import { readJsonBody } from '../utils/http-body.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import type { AsyncSharedCommandPort, SharedCommandPort } from '../hub/shared-command-port.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { SHARED_MESSAGE_FLIGHT_BYTES } from '@agentopsdeck/shared';

/** An explicit owner namespace, not an exception to ordinary owner routes.
 * Admission supports plain messages and explicitly authorized original-route
 * OpenClaw mirror. Controls, files and broad reads remain separately guarded.
 */
type SharedCommandDeps = {
  mode: 'async'; asyncSharedCommands: AsyncSharedCommandPort;
} | {
  mode?: 'legacy';
  hubStore: HubStore; principal: (c: Context) => HubPrincipal;
  sync: HubExecutionSync | undefined; local: { connectionId: string; dispatch: Dispatch } | undefined;
  asyncSharedCommands?: AsyncSharedCommandPort;
};
export function registerHubSharedCommandRoutes(app: Hono, deps: SharedCommandDeps) {
  // The stream reader allocates its advertised maximum. Reserve BEFORE it
  // runs, independently of SQL metadata and downstream payload reservations.
  // Retain it through post-body authority waits and delivery: a parsed body is
  // still owned memory while waiting for metadata or an original send result.
  const bodies = new HubRequestWork(2, SHARED_MESSAGE_FLIGHT_BYTES);
  if (deps.mode === 'async' && typeof deps.asyncSharedCommands?.open !== 'function') throw Error('hub_shared_commands_required');
  const path = '/api/hub/v1/shared/:ownerUserId/sessions/:sessionId';
  const open = async (c: Context): Promise<SharedCommandPort> => {
    c.header('Cache-Control', 'no-store');
    if (deps.asyncSharedCommands) {
      const translate = (error: unknown): never => {
        if (error instanceof HubMemberRequestError) throw new HTTPException(error.status === 499 ? 503 : error.status, { message: error.message });
        if (error instanceof HTTPException) throw error;
        throw new HTTPException(503, { message: 'Shared command temporarily unavailable' });
      };
      try { const port = await deps.asyncSharedCommands.open(c.req.raw, {
        ownerUserId: c.req.param('ownerUserId')!, sessionId: c.req.param('sessionId')!,
      }); return { ...port, read: async () => { try { await port.read(); } catch (error) { translate(error); } } };
      } catch (error) { return translate(error); }
    }
    // Compatibility adapter owns the complete original chain. Never used as
    // fallback after an asynchronous admission/effect failure.
    if (deps.mode === 'async') throw Error('hub_shared_commands_required');
    const store = deps.hubStore;
    const auth = sharedSessionAccess(c, deps);
    const send = (mirror: boolean) => {
      auth.require('messages:send');
      if (mirror) auth.require('messages:mirror');
    };
    const acquire = (mirror: boolean) => {
      send(mirror);
      const proof = auth.require('messages:send');
      const issuer = store.executionIssuers.current(auth.target.ownerUserId, auth.connection.id);
      if (!deps.sync || !issuer || issuer.nodeId !== auth.ref.nodeId) throw new HTTPException(409, { message: 'Shared execution issuer is not configured' });
      return deps.sync.acquire(proof, issuer.nodeId, issuer.issuerId, mirror ? ['messages:send', 'messages:mirror'] : ['messages:send']);
    };
    return { ref: auth.ref, read: auth.read, authorizeSend: send,
      send: (key, payload, mirror) => store.executionCommands.send(auth.target, key, payload, () => acquire(mirror),
        { read: auth.read, send: () => send(mirror) }, deps.local, c.req.raw.signal),
      recover: key => store.executionCommands.recover(auth.target, key, auth.read, deps.local, c.req.raw.signal),
      queue: key => store.executionCommands.queue(auth.target, key, auth.ref.nodeId, auth.read, deps.local, c.req.raw.signal),
      queuePage: cursor => store.executionCommands.queuePage(auth.target, auth.ref.nodeId, cursor, auth.read, deps.local, c.req.raw.signal),
      recoverQueueMutation: (original, key) => store.executionCommands.recoverQueueMutation(auth.target, original, key, auth.ref.nodeId, auth.read, deps.local, c.req.raw.signal),
      mutateQueue: (original, key, change) => store.executionCommands.mutateQueue(auth.target, original, key, auth.ref.nodeId, change,
        { read: auth.read, write: () => { auth.require('queue:manage'); if (change.method === 'PATCH') auth.require('messages:send'); } }, deps.local, c.req.raw.signal),
    };
  };
  const failure = (c: Context, error: unknown): Response => {
    if (error instanceof HTTPException) throw error;
    if (error instanceof HubMemberRequestError) throw new HTTPException(error.status === 499 ? 503 : error.status, { message: error.message });
    if (error instanceof CommandConflict) return c.json({ error: 'Command identity conflicts with an existing request' }, 409);
    if (error instanceof CommandCapacity) return c.json({ error: 'Command capacity reached' }, 503);
    return c.json({ error: 'Shared command temporarily unavailable' }, 503);
  };
  app.post(`${path}/voice/admission`, async c => {
    try {
      const mode = c.req.query('deliveryMode');
      if (mode !== 'web-only' && mode !== 'mirror') return c.json({ error: 'Invalid delivery mode' }, 400);
      const auth = await open(c);
      if (!auth.authorizeSend) return c.json({ error: 'Shared voice admission unavailable' }, 503);
      if (mode === 'mirror' && auth.ref.runtimeId !== 'openclaw') return c.json({ error: 'Mirror requires OpenClaw' }, 409);
      await auth.read();
      await auth.authorizeSend(mode === 'mirror');
      return c.body(null, 204);
    } catch (error) { return failure(c, error); }
  });
  app.get(`${path}/queue`, async c => {
    const auth = await open(c), cursor = c.req.query('cursor');
    if (cursor !== undefined && (!/^[1-9]\d{0,15}:(0|[1-9]\d{0,15})$/.test(cursor) || !cursor.split(':').every(value => Number.isSafeInteger(Number(value))))) {
      return c.json({ error: 'Invalid queue cursor' }, 400);
    }
    try {
      const page = await auth.queuePage(cursor);
      await auth.read(); return c.json(page);
    } catch (error) { return failure(c, error); }
  });
  app.get(`${path}/commands/:commandKey`, async c => {
    const auth = await open(c), key = c.req.param('commandKey');
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return c.json({ error: 'Invalid command key' }, 400);
    try {
      const command = await auth.recover(key);
      await auth.read();
      return command ? c.json({ command }) : c.json({ error: 'Command not found' }, 404);
    } catch (error) { return failure(c, error); }
  });
  app.get(`${path}/commands/:commandKey/queue`, async c => {
    const auth = await open(c), key = c.req.param('commandKey');
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return c.json({ error: 'Invalid command key' }, 400);
    try {
      const queue = await auth.queue(key);
      await auth.read();
      return queue ? c.json({ commandKey: key, queue }) : c.json({ error: 'Command not found' }, 404);
    } catch (error) { return failure(c, error); }
  });
  app.get(`${path}/commands/:commandKey/queue/commands/:mutationKey`, async c => {
    const auth = await open(c), original = c.req.param('commandKey'), key = c.req.param('mutationKey');
    if (![original, key].every(value => /^[A-Za-z0-9._:-]{1,200}$/.test(value))) return c.json({ error: 'Invalid command key' }, 400);
    try {
      const command = await auth.recoverQueueMutation(original, key);
      await auth.read();
      return command ? c.json({ command }) : c.json({ error: 'Queue mutation not found' }, 404);
    } catch (error) { return failure(c, error); }
  });
  for (const method of ['PATCH', 'DELETE'] as const) app.on(method, `${path}/commands/:commandKey/queue`, async c => {
    const auth = await open(c), original = c.req.param('commandKey'), key = c.req.header('idempotency-key');
    if (![original, key].every(value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value))) return c.json({ error: 'Queue mutation key is required' }, 400);
    const match = c.req.header('if-match');
    if (match === undefined) return c.json({ error: 'Queue version is required' }, 428);
    if (!/^"[1-9]\d{0,15}:[1-9]\d{0,15}"$/.test(match)) return c.json({ error: 'Invalid queue version' }, 400);
    let text = '';
    if (method === 'PATCH') {
      const body = await readJsonBody(c.req.raw, MAX_TEXT_MESSAGE_BODY_BYTES);
      await auth.read();
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(name => name !== 'message')
        || typeof (body as any).message !== 'string' || !(body as any).message.trim() || (body as any).message.length > MAX_MESSAGE_CHARS) return c.json({ error: 'Invalid queued message' }, 400);
      text = (body as { message: string }).message.trim();
    }
    try {
      const command = await auth.mutateQueue(original, key!, { method, version: match.slice(1, -1), text });
      await auth.read(); c.header('X-AgentOpsDeck-Command-Key', key!);
      return reply(c, command);
    } catch (error) { return failure(c, error); }
  });
  app.post(`${path}/messages`, async c => {
    const auth = await open(c);
    try {
      return await bodies.run(async () => {
        const raw = await readJsonBody(c.req.raw, SHARED_MESSAGE_BODY_BYTES);
        await auth.read();
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)
          || Object.keys(raw).some(key => !['message', 'idempotencyKey', 'deliveryMode', 'media'].includes(key))) {
          return c.json({ error: 'Invalid shared message fields' }, 400);
        }
        const body = raw as Record<string, unknown>, header = c.req.header('idempotency-key'), key = header ?? body.idempotencyKey;
        // Required stable browser identity: a missing key cannot silently create a
        // second command when the first response is lost.
        if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)
          || (header !== undefined && body.idempotencyKey !== undefined && header !== body.idempotencyKey)) return c.json({ error: 'A consistent command key is required' }, 400);
        if (typeof body.message === 'string' && ['/stop', '/status', '/compact'].includes(body.message.trim())) return c.json({ error: 'Shared controls are not available on this route' }, 409);
        let payload: ReturnType<typeof copySharedMessageInput>;
        try {
          const { idempotencyKey: _key, ...input } = body;
          payload = copySharedMessageInput(input, auth.ref.runtimeId);
        } catch { return c.json({ error: 'Invalid shared message or attachment' }, 400); }
        const mirror = body.deliveryMode === 'mirror';
        if (mirror && auth.ref.runtimeId !== 'openclaw') return c.json({ error: 'Mirror requires OpenClaw' }, 409);
        // Preserve the original message for fingerprinting; normalize only defaults.
        const command = await auth.send(key, payload, mirror);
        await auth.read();
        c.header('X-AgentOpsDeck-Command-Key', key);
        const { result, ...metadata } = command;
        return result ? c.json({ ...result.body, command: metadata }, result.status as 200)
          : c.json({ ok: false, status: 'outcome_unknown', command }, 202);
      }, SHARED_MESSAGE_BODY_BYTES);
    } catch (error) { return failure(c, error); }
  });
}
