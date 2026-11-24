import type { AsyncConnectorClientResolver } from '../hub/async-connector-client.js';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { validBoardId, validBoardUuid } from '@agentopsdeck/shared';
import type { HubStore } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';
import type { ConnectorClientResolver } from '../hub/connector-client.js';
import type { CommandReceipt } from '../commands/receipts.js';
import type { TaskSessionReceipt } from '../hub/task-session-workflow.js';
import { ownerControl } from '../hub/owner-control.js';
import { decodeHubSessionId } from '../hub/session-id.js';
import { readJsonBody } from '../utils/http-body.js';
import { registerAsyncHubTaskSessions, type AsyncTaskSessionDeps } from './hub-task-sessions-async.js';

type Remote = { ready: boolean; runtime: string; sessionId: string; binding: null | {
  id: string; runtime: string; sessionId: string; state: string; expiresAt: number } };

/** A frozen selection followed by TWO explicit writes: create, then bind.
 * GET only reconciles original receipts. Neither recovery nor restart can send
 * a message, create another session, install a grant or delete a session. */
export function registerHubTaskSessions(app: Hono, deps: { hubStore: HubStore; principal: (c: Context) => HubPrincipal;
  mode?:never; asyncConnectorClient?: AsyncConnectorClientResolver; connectorClient: ConnectorClientResolver; bindingClient?: ConnectorClientResolver; endpoint?: string | undefined } | AsyncTaskSessionDeps) {
  if(deps.mode==='async')return registerAsyncHubTaskSessions(app,deps);
  const store = deps.hubStore, workflows = store.taskSessions, active = new Set<string>(); let closed = false;
  const base = '/api/hub/v1/workspace/boards/:boardId/task-sessions';
  const scope = (c: Context) => {
    c.header('Cache-Control', 'no-store');
    const owner = deps.principal(c).userId, board = c.req.param('boardId')!;
    if (closed) throw new HTTPException(503);
    if (!validBoardId(board) || c.req.url.includes('?')) throw new HTTPException(400);
    const check = () => { if (closed || deps.principal(c).userId !== owner) throw new HTTPException(403); };
    return { owner, board, check };
  };
  const safe = (fn: (c: Context) => Promise<Response>) => async (c: Context) => {
    try { return await fn(c); }
    catch (e) { return c.json({ error: 'Task session unavailable. Inspect the original request; no message was sent.' },
      e instanceof HTTPException ? e.status : 409); }
  };
  const exclusive = async (owner: string, id: string, fn: () => Promise<Response>) => {
    const key = JSON.stringify([owner, id]); if (active.has(key)) throw new HTTPException(409);
    if (active.size >= 16) throw new HTTPException(429);
    active.add(key); try { return await fn(); } finally { active.delete(key); }
  };
  const original = (c: Context) => {
    const s = scope(c), id = c.req.param('id')!;
    if (!validBoardUuid(id)) throw new HTTPException(400);
    const receipt = workflows.read(s.owner, id);
    if (!receipt || receipt.intent.boardId !== s.board) throw new HTTPException(404);
    return { ...s, receipt };
  };
  const currentSelection = (r: TaskSessionReceipt) => {
    const i = r.intent, board = store.boards.get(i.owner, i.boardId);
    if (!deps.endpoint || !store.boardBindings.enabled || store.boards.fileManaged(i.owner, i.boardId)
      || board.revision !== i.boardRevision || i.expiresAt <= Date.now()
      || i.tasks.some(task => JSON.stringify(board.tasks.find(t => t.id === task.id)) !== JSON.stringify(task))) throw new HTTPException(409);
  };
  const creation = (c: Context, r: TaskSessionReceipt) => {
    const i = r.intent;
    const target = ownerControl(c, { store, client: deps.connectorClient, ...(deps.asyncConnectorClient ? { asyncConnectorClient: deps.asyncConnectorClient } : {}), owner: c => deps.principal(c).userId }, 'create',
      { connectionId: i.connectionId, agentId: i.runtime });
    if (target.authority !== i.authorityEpoch || target.nodeId !== i.nodeId) throw new HTTPException(403);
    return target;
  };
  const modelAvailable = async (c: Context, r: TaskSessionReceipt) => {
    // Older receipts remain inspectable, but new previews must freeze a model.
    // Never substitute a changed environment default for the frozen choice.
    if (!r.intent.model) throw new HTTPException(409);
    const target = creation(c, r);
    const catalog = await (await target.client()).json<{models?: Array<{id?: unknown}>}>(`/models/${encodeURIComponent(r.intent.runtime)}`,
      { signal: AbortSignal.timeout(5000) });
    target.check(); workflows.read(r.intent.owner, r.intent.requestId);
    if (!Array.isArray(catalog.models) || catalog.models.length > 512
      || !catalog.models.some(m => m && m.id === r.intent.model)) throw new HTTPException(409);
  };
  const settleCreation = (r: TaskSessionReceipt, command: CommandReceipt) => {
    const i = r.intent, key = command.result?.body?.key;
    const decoded = typeof key === 'string' ? decodeHubSessionId(key) : undefined;
    if (command.state === 'accepted' && command.result?.status === 201 && decoded?.connectionId === i.connectionId
      && decoded.remoteSessionKey.startsWith(i.runtime + ':')) {
      return workflows.recordCreation(i.owner, i.requestId, { requestId: r.creationRequestId, state: 'created', sessionId: key as string });
    }
    if (command.state === 'rejected') return workflows.recordCreation(i.owner, i.requestId, { requestId: r.creationRequestId, state: 'rejected' });
    return r;
  };
  const binding = (r: TaskSessionReceipt, check: () => void) => {
    const i = r.intent, session = decodeHubSessionId(r.sessionId ?? '');
    if (!session || session.connectionId !== i.connectionId || !session.remoteSessionKey.startsWith(i.runtime + ':')) throw new HTTPException(409);
    const valid = () => { check(); workflows.read(i.owner, i.requestId); };
    valid();
    const client = (deps.bindingClient ?? deps.connectorClient)(i.connectionId, false, i.owner);
    const path = `/sessions/${encodeURIComponent(session.remoteSessionKey)}/board-binding`;
    const read = async () => {
      const remote = await client.json<Remote>(path, { signal: AbortSignal.timeout(5000) }); valid();
      if (!remote || remote.runtime !== i.runtime || !validBoardUuid(remote.sessionId)
        || remote.binding !== null && (!remote.binding || !validBoardUuid(remote.binding.id)
          || remote.binding.runtime !== remote.runtime || remote.binding.sessionId !== remote.sessionId
          || !Number.isSafeInteger(remote.binding.expiresAt))) throw new HTTPException(502);
      return remote;
    };
    const settle = (remote: Remote) => {
      valid(); const local = store.boardBindings.get(i.owner, i.boardId, r.bindingRequestId);
      if (remote.binding?.id === r.bindingRequestId && remote.binding.state === 'installed' && remote.binding.expiresAt === i.expiresAt
        && local && !['revoked', 'expired', 'unavailable'].includes(local.state)) {
        store.boardBindings.outcome(i.owner, i.boardId, r.bindingRequestId, 'installed', true);
        return workflows.recordBinding(i.owner, i.requestId, { requestId: r.bindingRequestId, state: 'bound', bindingId: r.bindingRequestId, sessionId: r.sessionId! });
      }
      return workflows.read(i.owner, i.requestId)!;
    };
    return { client, path, valid, read, settle };
  };
  app.post(base, safe(async c => {
    const { owner, board, check } = scope(c), b = await readJsonBody(c.req.raw, 16384) as Record<string, unknown>; check();
    if (!b || Array.isArray(b) || Object.keys(b).some(k => !['requestId','connectionId','runtime','title','model','taskIds','fields','expiresAt'].includes(k))
      || !validBoardUuid(b.requestId) || typeof b.connectionId !== 'string' || !['codex','claude-code','ghcp'].includes(String(b.runtime))
      || typeof b.title !== 'string' || !b.title.trim() || b.title !== b.title.trim() || b.title.length > 120 || /[\x00-\x1f\x7f]/.test(b.title)
      || typeof b.model !== 'string' || !b.model.trim() || b.model !== b.model.trim() || b.model.length > 256 || /[\x00-\x1f\x7f]/.test(b.model)
      || !Array.isArray(b.taskIds) || !b.taskIds.length || b.taskIds.length > 32 || new Set(b.taskIds).size !== b.taskIds.length
      || !Array.isArray(b.fields) || !b.fields.length || new Set(b.fields).size !== b.fields.length || b.fields.some(f => !['status','detail'].includes(f))
      || !Number.isSafeInteger(b.expiresAt) || Number(b.expiresAt) <= Date.now() || Number(b.expiresAt) > Date.now() + 86400000) throw new HTTPException(400);
    if (workflows.read(owner, b.requestId)) throw new HTTPException(409);
    const connection = store.getConnection(b.connectionId, owner), authority = store.connectionAuthority(b.connectionId, owner);
    if (!connection?.nodeId || connection.status === 'disabled' || authority === undefined) throw new HTTPException(404);
    const current = store.boards.get(owner, board), tasks = current.tasks.filter(t => (b.taskIds as unknown[]).includes(t.id));
    if (tasks.length !== b.taskIds.length || !deps.endpoint || !store.boardBindings.enabled || store.boards.fileManaged(owner, board)) throw new HTTPException(409);
    const receipt = workflows.prepare({ owner, requestId: b.requestId, connectionId: connection.id, nodeId: connection.nodeId,
      authorityEpoch: authority, runtime: b.runtime as string, title: b.title, model: b.model, boardId: board, boardRevision: current.revision,
      tasks, fields: b.fields as ('status'|'detail')[], expiresAt: Number(b.expiresAt) });
    return c.json({ receipt }, 201);
  }));
  app.get(`${base}/:id`, safe(async c => {
    const { receipt: r, check } = original(c); let receipt = r;
    if (r.state === 'creation_unknown') {
      const t = creation(c, r);
      if (store.commands.get(t.scope, r.creationRequestId)) { const command = await t.recover(r.creationRequestId); check(); receipt = settleCreation(r, command); }
    } else if (r.state === 'binding_unknown') {
      const t = binding(r, check); try { receipt = t.settle(await t.read()); } catch { t.valid(); }
    }
    check(); return c.json({ receipt });
  }));
  app.post(`${base}/:id/:phase`, safe(async c => {
    const { owner, receipt: r, check } = original(c), phase = c.req.param('phase');
    const body = await readJsonBody(c.req.raw, 64); check();
    if (!phase || !['create', 'bind', 'cancel'].includes(phase) || !body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new HTTPException(400);
    return exclusive(owner, r.intent.requestId, async () => {
      const i = r.intent, latest = workflows.read(owner, i.requestId)!;
      if (phase === 'cancel') return c.json({ receipt: workflows.cancelPrepared(owner, i.requestId) });
      if (latest.state !== (phase === 'create' ? 'prepared' : 'created')) return c.json({ receipt: latest });
      currentSelection(latest);
      if (phase === 'create') {
        await modelAvailable(c, latest); check(); currentSelection(latest);
        const t = creation(c, latest), payload = { label: i.title, model: i.model };
        // Durable local workflow claim precedes ANY external admission.
        const claimed = workflows.claim(owner, i.requestId, 'create');
        if (!claimed.claimed) return c.json({ receipt: claimed.receipt });
        const commandCheck = () => { check(); t.check(); currentSelection(latest); };
        const { fresh } = await store.commands.claimAsync(t.scope, r.creationRequestId, payload, true, t.authority,
          undefined, undefined, false, commandCheck, commandCheck);
        if (fresh) try {
          check(); t.check(); currentSelection(latest);
          const result = await (await t.client()).jsonResponse<{ command?: CommandReceipt; key?: string }>(t.upstream, { method: 'POST',
            headers: { 'content-type': 'application/json', 'idempotency-key': store.commands.deliveryKey(t.scope, r.creationRequestId) },
            body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
          check(); t.bound(r.creationRequestId);
          if (result.body.command) t.settle(r.creationRequestId, { ...result.body.command, result: { status: result.status, body: { key: result.body.key } } });
        } catch { check(); t.bound(r.creationRequestId); }
        // Do not convert a lost ACK into automatic binding, even if GET recovers.
        const command = await t.recover(r.creationRequestId); check();
        return c.json({ receipt: settleCreation(claimed.receipt, command) });
      }
      const t = binding(latest, check), remote = await t.read(); currentSelection(latest);
      if (remote.ready !== true || remote.binding?.state === 'installed') throw new HTTPException(409);
      const claimed = workflows.claim(owner, i.requestId, 'bind'); if (!claimed.claimed) return c.json({ receipt: claimed.receipt });
      const local = store.boardBindings.prepare(owner, i.boardId, { requestId: r.bindingRequestId, sessionId: latest.sessionId!,
        grant: { taskIds: i.tasks.map(t => t.id), fields: i.fields, expiresAt: i.expiresAt } }, i.connectionId, i.authorityEpoch, deps.endpoint!);
      const credential = local && store.boardBindings.credential(owner, i.boardId, r.bindingRequestId);
      if (!credential) return c.json({ receipt: workflows.recordBinding(owner, i.requestId, { requestId: r.bindingRequestId, state: 'rejected' }) });
      try {
        t.valid(); currentSelection(latest);
        await t.client.json(t.path, { method: 'PUT', body: JSON.stringify({ id: r.bindingRequestId, credential }), signal: AbortSignal.timeout(5000) });
        return c.json({ receipt: t.settle(await t.read()) });
      } catch {
        t.valid(); store.boardBindings.outcome(owner, i.boardId, r.bindingRequestId, 'uncertain', true);
        return c.json({ receipt: workflows.read(owner, i.requestId) });
      }
    });
  }));
  app.delete(`${base}/:id`, safe(async c => {
    const { owner, board } = scope(c), id = c.req.param('id')!;
    if (!validBoardUuid(id)) throw new HTTPException(400);
    const old = workflows.read(owner,id); if(old && old.intent.boardId !== board)throw new HTTPException(404);
    return c.json({ receipt: workflows.cancel(owner,id), cancelled: true, requestId: id });
  }));
  return { close() { closed = true; } };
}
