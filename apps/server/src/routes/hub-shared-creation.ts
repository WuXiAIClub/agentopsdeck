import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { CommandCapacity, CommandConflict, type CommandReceipt } from '../commands/receipts.js';
import { reply } from '../commands/http.js';
import type { Dispatch } from '../connector/transport.js';
import type { HubStore } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';
import { encodeHubSessionId } from '../hub/session-id.js';
import { sessionRef } from '../hub/session-ref.js';
import { readJsonBody } from '../utils/http-body.js';
import type { AsyncHubCreationDiscovery } from '../hub/async-creation-discovery.js';
import type { AsyncHubSharedCreationPort } from '../hub/async-shared-creation.js';
import { registerSharedCreationCommands, registerSharedCreationDiscovery } from './hub-shared-creation-async.js';

export function registerHubSharedCreationRoutes(app: Hono, deps: {
  hubStore: HubStore; principal: (context: Context) => HubPrincipal;
  local?: { connectionId: string; dispatch: Dispatch } | undefined;
  asyncCreation?: AsyncHubSharedCreationPort | undefined;
  asyncDiscovery?:Pick<AsyncHubCreationDiscovery,'environments'> | undefined;
}) {
  const store = deps.hubStore;
  const path = '/api/hub/v1/shared/:ownerUserId/connections/:connectionId/agents/:agentId/sessions';
  const permissions = (userId: string, ownerUserId: string, connectionId: string) => {
    const target = { userId, ownerUserId, connectionId }, resource = { runtime: 'codex' as const };
    const proof = store.grants.authorize(target, 'sessions:create', resource);
    return proof ? [proof] : undefined;
  };
  const access = (context: Context) => {
    context.header('Cache-Control', 'no-store');
    const userId = deps.principal(context).userId, ownerUserId = context.req.param('ownerUserId')!;
    const connectionId = context.req.param('connectionId')!, connection = store.getConnection(connectionId, ownerUserId);
    const proofs = permissions(userId, ownerUserId, connectionId);
    if (context.req.param('agentId') !== 'codex' || !connection?.nodeId || !proofs) throw new HTTPException(403, { message: 'Shared session creation is not authorized' });
    const issuer = store.executionIssuers.current(ownerUserId, connectionId);
    if (!issuer?.creationAllowed || issuer.nodeId !== connection.nodeId) throw new HTTPException(409, { message: 'Member session creation must be enabled by the environment owner' });
    const check = () => {
      if (deps.principal(context).userId !== userId || proofs.some(proof => !store.grants.revalidate(proof))) {
        throw new HTTPException(403, { message: 'Session creation authorization changed' });
      }
      if (store.executionIssuers.current(ownerUserId, connectionId)?.version !== issuer.version) throw new HTTPException(409, { message: 'Creation issuer changed' });
    };
    const scope = JSON.stringify(['shared-session-create-v1', userId, ownerUserId, connectionId, 'codex']);
    const client = store.executionIssuers.creationClient(ownerUserId, connectionId, issuer.version, check, deps.local);
    const bound = (key: string) => {
      check();
      if (receipts.authorityId(scope, key) !== issuer.version) throw new HTTPException(409, { message: 'Creation receipt belongs to an earlier node authority; do not recreate' });
    };
    const settle = (key: string, receipt: CommandReceipt | undefined) => {
      if (receipt?.key !== receipts.deliveryKey(scope, key)) return;
      if (receipt?.state === 'accepted' && receipt.result?.status === 201) {
        const nativeKey = receipt.result.body?.key;
        try {
          if (typeof nativeKey !== 'string' || sessionRef(connection.nodeId, nativeKey)?.runtimeId !== 'codex') return;
          store.grants.acceptCreatedSession(proofs[0]!, nativeKey, scope, key, () => {
            const settled = receipts.settleFromReceipt(scope, key, { ...receipt, result: { status: 201, body: {
              key: encodeHubSessionId(connectionId, nativeKey), ownerUserId,
            } } });
            if (settled.state !== 'accepted') throw new Error('Creation ownership requires a settled receipt');
          });
        } catch {}
      } else if (receipt?.state === 'rejected' && receipt.result && receipt.result.status >= 400 && receipt.result.status < 500) {
        receipts.settleFromReceipt(scope, key, { ...receipt, result: { status: receipt.result.status, body: { error: 'Shared creation rejected' } } });
      }
    };
    const recover = async (key: string) => {
      bound(key);
      if (receipts.get(scope, key)?.state === 'outcome_unknown') {
        try {
          const result = await client.json<{ command: CommandReceipt }>(`/agents/codex/sessions/creation-commands/${receipts.deliveryKey(scope, key)}`, { signal: context.req.raw.signal });
          bound(key); settle(key, result.command);
        } catch { bound(key); }
      }
      check(); return receipts.get(scope, key)!;
    };
    return { check, scope, client, bound, settle, recover, version: issuer.version };
  };
  const failure = (context: Context, error: unknown) => {
    if (error instanceof HTTPException) return context.json({ error: error.message }, error.status);
    if (error instanceof CommandConflict) return context.json({ error: 'Creation command identity conflicts' }, 409);
    return context.json({ error: error instanceof CommandCapacity ? 'Creation capacity reached' : 'Shared creation temporarily unavailable' }, 503);
  };
  if(deps.asyncDiscovery) registerSharedCreationDiscovery(app, deps.asyncDiscovery);
  else app.get('/api/hub/v1/shared/creation-environments', context => {
    context.header('Cache-Control', 'no-store');
    const userId = deps.principal(context).userId;
    let page;
    try { page = store.grants.received(userId, context.req.query('after'), 50); }
    catch { return context.json({ error: 'Invalid creation environment page' }, 400); }
    const seen = new Set<string>();
    let environments;
    try { environments = page.grants.flatMap(grant => {
      const identity = JSON.stringify([grant.ownerUserId, grant.connectionId]);
      if (seen.has(identity) || !permissions(userId, grant.ownerUserId, grant.connectionId)) return [];
      const connection = store.getConnection(grant.connectionId, grant.ownerUserId);
      const issuer = store.executionIssuers.current(grant.ownerUserId, grant.connectionId);
      if (!connection || !issuer?.creationAllowed || issuer.nodeId !== connection.nodeId) return [];
      seen.add(identity);
      return [{ ownerUserId: grant.ownerUserId, connectionId: connection.id,
        label: connection.environmentLabel ?? connection.label, kind: connection.kind, status: connection.status }];
    }); } catch {
      // Corrupt issuer bindings must remain fail-closed. Match the awaited
      // discovery path without leaking an exception or reporting an empty,
      // apparently healthy permission projection to the existing frontend.
      return context.json({ error: 'Creation environments are temporarily unavailable. Reload to refresh permissions.' }, 503);
    }
    return context.json({ environments, nextCursor: page.nextCursor });
  });
  if (deps.asyncCreation) {
    registerSharedCreationCommands(app, deps.asyncCreation);
    return; // Never fall through to the synchronous authority on failure.
  }
  const receipts = store.commands;
  app.get(`${path}/creation-commands/:commandKey`, async context => {
    try {
      const target = access(context), key = context.req.param('commandKey');
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return context.json({ error: 'Invalid creation command key' }, 400);
      if (!receipts.get(target.scope, key)) return context.json({ error: 'Creation command not found' }, 404);
      return context.json({ command: await target.recover(key) });
    } catch (error) { return failure(context, error); }
  });
  app.post(path, async context => {
    try {
      const target = access(context), raw = await readJsonBody(context.req.raw, 8 * 1024);
      target.check(); context.req.raw.signal.throwIfAborted();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['label', 'idempotencyKey'].includes(key))) return context.json({ error: 'Invalid creation payload' }, 400);
      const body = raw as Record<string, unknown>, header = context.req.header('idempotency-key'), key = header ?? body.idempotencyKey;
      if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)
        || (header !== undefined && body.idempotencyKey !== undefined && body.idempotencyKey !== header)) return context.json({ error: 'Consistent creation command key required' }, 400);
      if (typeof body.label !== 'string' || !body.label.trim() || body.label.length > 256) return context.json({ error: 'Session name must contain 1–256 characters' }, 400);
      const payload = { label: body.label };
      const check = () => { context.req.raw.signal.throwIfAborted(); target.check(); };
      const claimed = await receipts.claimAsync(target.scope, key, payload, true, target.version,
        undefined, undefined, false, check, check);
      context.header('X-AgentOpsDeck-Command-Key', key);
      if (claimed.fresh) {
        try {
          const result = await target.client.jsonResponse<{ key?: string; command?: CommandReceipt }>('/agents/codex/sessions', {
            method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': receipts.deliveryKey(target.scope, key) },
            body: JSON.stringify(payload), signal: context.req.raw.signal,
          });
          target.bound(key);
          if (result.body.command) target.settle(key, { ...result.body.command,
            result: { status: result.status, body: { key: result.body.key } } });
        } catch {
          // A proxy/auth HTTP failure can follow a committed native effect.
          // Only the original Connector receipt may resolve this command.
          target.bound(key);
        }
      }
      return reply(context, await target.recover(key));
    } catch (error) { return failure(context, error); }
  });
}
