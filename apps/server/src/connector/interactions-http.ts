import type { Hono, Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { readInteractionSubmission, sessionRuntimeId } from '@agentopsdeck/shared';
import { InteractionConflict } from '../commands/agent-interaction.js';
import { InteractionDeliveryConflict } from '../commands/interaction-continuation.js';
import type { InteractionRuntime } from '../commands/interaction-runtime.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { resolveExecutionActor } from './execution-authority.js';
import { readJsonBody } from '../utils/http-body.js';
import { interactionCapabilitiesFor } from './sdk-interaction.js';

export function registerInteractions(app: Hono, deps: {
  runtime: InteractionRuntime; users: ConnectorUserStore; tokens: ConnectorTokenStore;
  exists(key: string): boolean; ready(key: string): boolean; changed(key: string): void;
}) {
  const base = '/api/connector/v1/sessions/:sessionKey';
  function scope(c: Context, write = false) {
    const key = c.req.param('sessionKey')!;
    const actor = resolveExecutionActor(c.req.raw, { tokens: deps.tokens, grants: deps.users.executionGrants, nodeId: deps.users.nodeId },
      { sessionKey: key, runtime: sessionRuntimeId(key) }, write ? 'messages:send' : undefined);
    if (actor.executionGrant || actor.principal.scopes.includes('execution:delegate')
      || !deps.tokens.hasScope(actor.actorId, 'messages:read') || write && !deps.tokens.hasScope(actor.actorId, 'messages:send')) {
      throw new HTTPException(403, { res: Response.json({ error: 'Interaction requires current owner authority' }, { status: 403 }) });
    }
    if (!['codex', 'claude-code', 'ghcp'].includes(sessionRuntimeId(key))) throw new HTTPException(409);
    if (!deps.exists(key) || deps.users.commands.sessionDeletion(key)) throw new HTTPException(404);
    return { ownerId: actor.actorId, nodeId: deps.users.nodeId, sessionKey: key };
  }
  function failure(c: Context, issue: unknown) {
    if (issue instanceof HTTPException) return issue.getResponse();
    if (issue instanceof InteractionConflict || issue instanceof InteractionDeliveryConflict) return c.json({ error: issue.message }, issue.code === 'permission' ? 403 : 409);
    return c.json({ error: 'Interaction unavailable; no answer was resent' }, 503);
  }
  app.get(`${base}/interactions`, c => {
    c.header('Cache-Control', 'no-store');
    try {
      const owner = scope(c);
      return c.json({ version: 1, mode: deps.runtime.store.mode(owner), requests: deps.runtime.list(owner),
        capabilities: deps.ready(owner.sessionKey) ? interactionCapabilitiesFor(sessionRuntimeId(owner.sessionKey)) : { version: 1, kinds: [], modes: ['automatic'] } });
    } catch (issue) { return failure(c, issue); }
  });
  app.patch(`${base}/interaction-mode`, async c => {
    c.header('Cache-Control', 'no-store');
    try {
      scope(c, true);
      const body = await readJsonBody(c.req.raw, 128), owner = scope(c, true);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1
        || !('mode' in body) || body.mode !== 'automatic' && body.mode !== 'interactive') return c.json({ error: 'Invalid interaction mode' }, 400);
      if (!deps.users.sdkCommandAdmissionOpen || !deps.ready(owner.sessionKey)) return c.json({ error: 'Agent is not ready' }, 503);
      deps.runtime.store.setMode(owner, body.mode); deps.changed(owner.sessionKey);
      return c.json({ mode: body.mode });
    } catch (issue) { return failure(c, issue); }
  });
  app.post(`${base}/interactions/:requestId/answer`, async c => {
    c.header('Cache-Control', 'no-store');
    try {
      scope(c, true);
      const body = readInteractionSubmission(await readJsonBody(c.req.raw, 40_000)), owner = scope(c, true);
      const requestId = c.req.param('requestId');
      if (!body || requestId.length > 256) return c.json({ error: 'Invalid interaction answer' }, 400);
      return c.json(await deps.runtime.answer({ ...body, scope: { ...owner, runId: body.runId }, requestId,
        authorize: () => { try { return scope(c, true).ownerId === owner.ownerId; } catch { return false; } } }));
    } catch (issue) { return failure(c, issue); }
  });
}
