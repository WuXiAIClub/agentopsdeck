import type { Context, Hono } from 'hono';
import { sessionRuntimeId, MAX_MESSAGE_CHARS, MAX_TEXT_MESSAGE_BODY_BYTES, type QueuedCommandPage } from '@agentopsdeck/shared';
import type { HermesRuntime } from '../hermes/runtime.js';
import { HTTPException } from 'hono/http-exception';
import { commandQueueId, reply as commandReply } from '../commands/http.js';
import { CommandCapacity, CommandConflict } from '../commands/receipts.js';
import type { CodexAppServer } from '../codex/app-server.js';
import type { OpenClawTurnQueue } from '../openclaw/turn-queue.js';
import type { DeckStore } from '../projection/deck-store.js';
import { readJsonBody } from '../utils/http-body.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import type { resolveExecutionActor } from './execution-authority.js';
import type { ExecutionAction } from './execution-grants.js';
import type { ClaudeConnectorRuntime } from '../claude/connector-runtime.js';
import type { CopilotConnectorRuntime } from '../copilot/connector-runtime.js';
import type { AntigravityConnectorRuntime } from '../antigravity/sdk-runtime.js';
import { SdkUnsupportedTextCommand } from './sdk-text-command.js';

// One durable queue and the existing receipt table. Versioned legacy callers
// may omit a key; keyed mutations additionally survive a lost response/restart.
export function registerQueueRoutes(app: Hono, path: string, deps: {
  actor: (c: Context, action?: ExecutionAction) => ReturnType<typeof resolveExecutionActor>;
  users: ConnectorUserStore; store: DeckStore; codex?: CodexAppServer | undefined; openclaw?: OpenClawTurnQueue | undefined;
  hermes?: HermesRuntime | undefined;
  claude?: ClaudeConnectorRuntime | undefined;
  copilot?: CopilotConnectorRuntime | undefined;
  antigravity?: AntigravityConnectorRuntime | undefined;
}) {
  const { turns, commands } = deps.users;
  const scope = (actorId: string, c: Context, id: string) => JSON.stringify(['queue-mutation-v1', actorId, c.req.param('sessionKey'), id]);
  // Shared callers address their original command, never an arbitrary runtime
  // ID. Only the actor's persisted accepted admission binds the queue target.
  const target = (actorId: string, c: Context) => {
    const key = c.req.param('commandKey');
    if (key === undefined) return c.req.param('messageId')!;
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) throw new HTTPException(400, { message: 'Invalid command key' });
    const receipt = commands.get(JSON.stringify([actorId, c.req.param('sessionKey')]), key);
    if (!receipt) throw new HTTPException(404, { message: 'Command not found' });
    const id = commandQueueId(receipt);
    if (!id) throw new HTTPException(409, { message: 'Command queue target is not confirmed' });
    return id;
  };
  const canRead = (actor: ReturnType<typeof deps.actor>) => actor.principal.scopes.includes('messages:read')
    || (!actor.executionGrant && actor.principal.scopes.includes('queue:manage'));
  app.get(`${path}/queue/commands`, c => {
    c.header('Cache-Control', 'no-store');
    const actor = deps.actor(c);
    if (!canRead(actor)) return c.json({ error: 'missing queue read scope' }, 403);
    const cursor = c.req.query('cursor') ?? '0';
    if (!/^\d{1,16}$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) return c.json({ error: 'invalid queue cursor' }, 400);
    const sessionKey = c.req.param('sessionKey')!;
    // Even an issuer with queue:manage may only enumerate its current actor.
    const page = turns.summaryPage(sessionRuntimeId(sessionKey), sessionKey, actor.actorId, false, Number(cursor));
    const keys = commands.queueCommandKeys(JSON.stringify([actor.actorId, sessionKey]), page.items.map(item => item.id));
    const result: QueuedCommandPage = { items: page.items.map(({ id: _, ...item }, index) => ({ ...item, commandKey: keys[index]! })), nextCursor: page.nextCursor };
    return c.json(result);
  });
  app.get(`${path}/queue`, c => {
    c.header('Cache-Control', 'no-store');
    const actor = deps.actor(c), manager = !actor.executionGrant && actor.principal.scopes.includes('queue:manage');
    if (!canRead(actor)) return c.json({ error: 'missing queue read scope' }, 403);
    const cursor = c.req.query('cursor') ?? '0';
    if (!/^\d{1,16}$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) return c.json({ error: 'invalid queue cursor' }, 400);
    const sessionKey = c.req.param('sessionKey')!;
    return c.json(turns.summaryPage(sessionRuntimeId(sessionKey), sessionKey, actor.actorId, manager, Number(cursor)));
  });
  app.on('GET', [`${path}/queue/:messageId/commands/:mutationKey`, `${path}/commands/:commandKey/queue/commands/:mutationKey`], c => {
    c.header('Cache-Control', 'no-store');
    const actor = deps.actor(c);
    if (!canRead(actor)) return c.json({ error: 'missing queue read scope' }, 403);
    const key = c.req.param('mutationKey')!;
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return c.json({ error: 'invalid mutation key' }, 400);
    // Actor-scoped receipt remains readable after cancellation removed the row,
    // or grant expiry/revoke. Issuer-token/session binding still must validate.
    const command = commands.get(scope(actor.actorId, c, target(actor.actorId, c)), key);
    return command ? c.json({ command }) : c.json({ error: 'Queue mutation not found' }, 404);
  });
  for (const method of ['PATCH', 'DELETE'] as const) app.on(method, [`${path}/queue/:messageId`, `${path}/commands/:commandKey/queue`], async c => {
    c.header('Cache-Control', 'no-store');
    const authorized = () => {
      const actor = deps.actor(c, method === 'PATCH' ? 'messages:send' : undefined);
      const manager = !actor.executionGrant && actor.principal.scopes.includes('queue:manage');
      // SDK commands currently support the sending actor only. Do not claim
      // a mutation receipt which can only fail at the deeper owner boundary.
      if (['claude-code', 'ghcp', 'antigravity'].includes(sessionRuntimeId(c.req.param('sessionKey')!))
        && !actor.principal.scopes.includes('messages:send')) return undefined;
      return actor.principal.scopes.includes('messages:send') || (method === 'DELETE' && manager) ? actor : undefined;
    };
    const initial = authorized();
    if (!initial) return c.json({ error: 'missing queue write scope' }, 403);
    let text = '';
    if (method === 'PATCH') {
      const body = await readJsonBody(c.req.raw, MAX_TEXT_MESSAGE_BODY_BYTES) as { message?: unknown } | null;
      if (!body || typeof body.message !== 'string' || !body.message.trim() || body.message.length > MAX_MESSAGE_CHARS) return c.json({ error: `message must contain 1–${MAX_MESSAGE_CHARS} characters` }, 400);
      text = body.message.trim();
    }
    let actor = authorized();
    if (!actor || actor.actorId !== initial.actorId) return c.json({ error: 'queue authorization revoked' }, 403);
    c.req.raw.signal.throwIfAborted();
    const sessionKey = c.req.param('sessionKey')!, id = target(actor.actorId, c);
    const runtime = sessionRuntimeId(sessionKey);
    const manager = () => !['claude-code', 'ghcp', 'antigravity'].includes(runtime) && method === 'DELETE' && !actor!.executionGrant && actor!.principal.scopes.includes('queue:manage');
    const key = c.req.header('idempotency-key'), receiptScope = scope(actor.actorId, c, id);
    if (c.req.param('commandKey') !== undefined && key === undefined) return c.json({ error: 'Queue mutation key is required' }, 400);
    let entry = turns.ownedEntry(runtime, sessionKey, id, actor.actorId, manager());
    // Preserve non-enumeration for unkeyed callers; keyed repeats may have
    // already deleted their row, so consult their own receipt before existence.
    if (!entry && key === undefined) return c.json({ error: 'queued message not found' }, 404);
    const match = c.req.header('if-match');
    if (match === undefined) return c.json({ error: 'queue version is required' }, 428);
    if (!/^"[1-9]\d{0,15}:[1-9]\d{0,15}"$/.test(match)) return c.json({ error: 'invalid queue version' }, 400);
    const version = match.slice(1, -1);
    if (key !== undefined) {
      const actorId = actor.actorId;
      const check = () => {
        c.req.raw.signal.throwIfAborted();
        const current = authorized();
        if (!current || current.actorId !== actorId) throw new HTTPException(403, { message: 'queue authorization revoked' });
        // The original accepted command, not a newly supplied target, remains
        // the authority for shared queue mutations after each admission wait.
        if (target(actorId, c) !== id) throw new HTTPException(409, { message: 'Command queue target changed' });
        actor = current;
      };
      try {
        const claim = await commands.claimAsync(receiptScope, key, { method, version, text }, false, undefined,
          undefined, undefined, false, check, check);
        c.header('X-AgentOpsDeck-Command-Key', key);
        if (!claim.fresh) return commandReply(c, claim.receipt); // never redispatch unknown
        // No authority/entry snapshot made before waiting grants queue access.
        // The runtime's original queueCommit transaction still performs CAS.
        entry = turns.ownedEntry(runtime, sessionKey, id, actor.actorId, manager());
      } catch (error) {
        if (error instanceof HTTPException) throw error;
        if (error instanceof CommandConflict) return c.json({ error: 'Queue mutation identity conflicts' }, 409);
        if (error instanceof CommandCapacity) return c.json({ error: 'Command capacity reached' }, 503);
        return c.json({ error: 'Queue mutation unavailable' }, 503);
      }
    }
    const result = (status: number, body: Record<string, unknown>) => key === undefined ? c.json(body, status as 200)
      : commandReply(c, commands.settle(receiptScope, key, { status, body }));
    if (!entry) return result(404, { error: 'queued message not found' });
    if (turns.version(runtime, sessionKey, id) !== version) return result(412, { error: 'queue version changed; refresh before retrying' });
    if (entry.state !== 'queued' && !(method === 'DELETE' && entry.state === 'blocked')) return result(409, { error: 'queued message is not editable or cancelable in its current state' });
    const sdk = runtime === 'ghcp' ? deps.copilot : runtime === 'claude-code' ? deps.claude : runtime === 'antigravity' ? deps.antigravity : undefined;
    if (['ghcp', 'claude-code', 'antigravity'].includes(runtime) ? !sdk : runtime === 'hermes' ? !deps.hermes : runtime === 'codex' ? !deps.codex : !deps.openclaw) return result(503, { error: 'runtime queue is unavailable' });
    try {
      const commit = key === undefined ? undefined : commands.queueCommit(receiptScope, key, { status: 200, body: { ok: true } });
      const changed = sdk
        ? method === 'PATCH' ? sdk.commands.editQueued(sessionKey, id, text, version, actor, commit)
          : sdk.commands.cancelQueued(sessionKey, id, version, actor, commit)
        : runtime === 'hermes'
        ? method === 'PATCH' ? deps.hermes!.editQueued(sessionKey, id, text, version, commit) : deps.hermes!.cancelQueued(sessionKey, id, version, commit)
        : runtime === 'codex'
        ? method === 'PATCH' ? deps.codex!.editQueued(sessionKey, id, text, version, commit) : deps.codex!.cancelQueued(sessionKey, id, version, commit)
        : method === 'PATCH' ? deps.openclaw!.edit(sessionKey, id, text, version, commit) : deps.openclaw!.cancel(sessionKey, id, version, commit);
      if (!changed) return result(409, { error: 'queue state changed' });
      deps.store.append(method === 'PATCH' ? 'queued_message.created' : 'queued_message.failed',
        { sessionKey, idempotencyKey: id, ...(method === 'PATCH' ? { edited: true } : { canceled: true }) }, { sessionKey });
      return result(200, { ok: true });
    } catch (error) {
      // This validation happens before any queue mutation or commit callback.
      // Unlike an uncertain write failure, it is a definitive rejection.
      if (error instanceof SdkUnsupportedTextCommand) return result(409, { error: error.message });
      // The atomic queue commit may have succeeded before projection failed.
      // Return its durable receipt; otherwise leave the outcome unknown.
      return key === undefined ? c.json({ error: 'queue mutation unavailable' }, 503)
        : commandReply(c, commands.get(receiptScope, key)!);
    }
  });
}
