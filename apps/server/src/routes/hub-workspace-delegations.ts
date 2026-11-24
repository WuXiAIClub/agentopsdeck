import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { validBoardId, validBoardUuid } from '@agentopsdeck/shared';
import type { HubStore } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';
import type { ConnectorClientResolver } from '../hub/connector-client.js';
import { decodeHubSessionId } from '../hub/session-id.js';
import { delegationDirectory } from '../hub/workspace-delegation-directory.js';
import { readDelegationCatalog } from '../hub/workspace-delegation-catalog.js';
import { createDelegationPreview, type DelegationMember, type DelegationSelection, type DelegationPreviewInput } from '../hub/workspace-delegation-preview.js';
import { DelegationConflict } from '../hub/workspace-delegation-store.js';
import { DelegationRunner } from '../hub/workspace-delegation-runner.js';
import { delegationBindingAdapter } from '../hub/workspace-delegation-binding-adapter.js';
import { readJsonBody } from '../utils/http-body.js';
import type { AsyncHubDelegations } from '../hub/async-delegations.js';
import type { AsyncConnectorClientResolver } from '../hub/async-connector-client.js';
import { registerAsyncHubDelegations } from './hub-async-workspace-delegations.js';

type Remote = { runtime: string; sessionId: string; ready: boolean; binding: null | {
  id: string; runtime: string; sessionId: string; expiresAt: number; state: string } };
const remoteValid = (r: Remote, m: DelegationMember) => r && r.runtime === m.runtime && validBoardUuid(r.sessionId)
  && (r.binding === null || r.binding && validBoardUuid(r.binding.id) && r.binding.runtime === r.runtime
    && r.binding.sessionId === r.sessionId && Number.isSafeInteger(r.binding.expiresAt) && ['installed', 'removed'].includes(r.binding.state));

/** Explicit two-step batch binding. Browser selects filters, not authoritative
 * members; every confirmation rebuilds the trusted catalog. Receipt recovery
 * performs reads only. No chat, session creation or restart-driven replay. */
export function registerHubDelegations(app: Hono, deps: { hubStore: HubStore; principal: (c: Context) => HubPrincipal;
  connectorClient: ConnectorClientResolver; endpoint?: string | undefined; access?:AsyncHubDelegations;asyncConnectorClient?:AsyncConnectorClientResolver }) {
  if (deps.access) return registerAsyncHubDelegations(app,{access:deps.access,
    ...(deps.asyncConnectorClient ? {asyncConnectorClient:deps.asyncConnectorClient} : {}),...(deps.endpoint ? {endpoint:deps.endpoint} : {})});
  const store = deps.hubStore, directory = delegationDirectory(store, deps.connectorClient), active = new Set<string>();
  let closed = false;
  const base = '/api/hub/v1/workspace/boards/:boardId/delegations';
  const scope = (c: Context) => {
    c.header('Cache-Control', 'no-store');
    if (closed) throw new HTTPException(503);
    const owner = deps.principal(c).userId, board = c.req.param('boardId')!;
    if (!validBoardId(board) || c.req.url.includes('?')) throw new HTTPException(400);
    const check = () => { if (closed || deps.principal(c).userId !== owner) throw new HTTPException(403); };
    return { owner, board, check };
  };
  const safe = (handler: (c: Context) => Promise<Response>) => async (c: Context) => {
    try { return await handler(c); }
    catch (e) { return c.json({ error: 'Batch unavailable; inspect the original request. No message was sent.' },
      e instanceof HTTPException ? e.status : e instanceof DelegationConflict ? 409 : 502); }
  };
  const target = (m: DelegationMember, check: () => void) => {
    const decoded = decodeHubSessionId(m.sessionId);
    const valid = () => { check(); if (!directory.authorized(m.owner, m)) throw new HTTPException(403); };
    valid(); if (!decoded) throw new HTTPException(400);
    return { valid, client: deps.connectorClient(m.connectionId, false, m.owner), path: `/sessions/${encodeURIComponent(decoded.remoteSessionKey)}/board-binding` };
  };
  const readRemote = async (m: DelegationMember, check: () => void, signal: AbortSignal) => {
    const t = target(m, check), r = await t.client.json<Remote>(t.path, { signal }); t.valid();
    if (!remoteValid(r, m)) throw new HTTPException(502);
    return r;
  };
  const input = async (owner: string, board: string, selection: DelegationSelection, taskIds: string[], fields: ('status' | 'detail')[], check: () => void) => {
    const catalog = await readDelegationCatalog(owner, directory); check();
    const initial: DelegationPreviewInput = { owner, catalog, selection, board: store.boards.get(owner, board), taskIds, fields };
    const selected = createDelegationPreview(initial, Date.now()).members;
    const supported = new Set<string>();
    // Bounded sequential preflight avoids opening 32 concurrent upstream calls.
    const signal = AbortSignal.timeout(5000);
    for (const m of selected) {
      if (!['codex', 'claude-code', 'ghcp'].includes(m.runtime)) continue;
      const r = await readRemote(m, check, signal);
      if (r.ready === true && r.binding?.state !== 'installed') supported.add(m.sessionId);
    }
    check();
    const now = directory.fence(owner);
    if (now.generation !== catalog.generation || now.preferencesRevision !== catalog.preferencesRevision) throw new HTTPException(409);
    return { ...initial, board: store.boards.get(owner, board), catalog: { ...catalog,
      members: catalog.members.map(m => ({ ...m, taskBinding: supported.has(m.sessionId) ? 'supported' as const : 'unknown' as const })) } };
  };
  const runner = (check: () => void) => new DelegationRunner(store.delegations, delegationBindingAdapter(store.boardBindings, deps.endpoint ?? '', intent => {
    check(); if (!directory.authorized(intent.owner, intent.member)) return;
    const prefs = store.workspace.get(intent.owner), current = prefs.sessions[intent.member.sessionId];
    // Frozen targets only; a changed grouping may revoke admission, never expand it.
    if ((current?.groupId ?? null) !== intent.member.groupId || JSON.stringify([...(current?.tags ?? [])].sort()) !== JSON.stringify([...intent.member.tags].sort())) return;
    return { member: intent.member, board: store.boards.get(intent.owner, intent.boardId),
      canGrant: !!deps.endpoint && store.boardBindings.enabled && !store.boards.fileManaged(intent.owner, intent.boardId), fields: ['status', 'detail'] };
  }, {
    async install(intent, credential, beforeWrite) {
      const t = target(intent.member, check), signal = AbortSignal.timeout(5000);
      const before = await readRemote(intent.member, check, signal);
      if (!before.ready || before.binding?.state === 'installed' || !beforeWrite()) return 'unknown';
      // This is the last local fence before transport admission; remote endpoint
      // itself serializes installs and will not overwrite another live binding.
      t.valid();
      const result = await t.client.json<{ binding: Remote['binding'] }>(t.path, {
        method: 'PUT', body: JSON.stringify({ id: intent.requestId, credential }), signal }); t.valid();
      return remoteValid({ ...before, binding: result?.binding }, intent.member) && result.binding?.id === intent.requestId
        && result.binding.state === 'installed' && result.binding.expiresAt === intent.grant.expiresAt ? 'installed' : 'unknown';
    },
    async query(intent) {
      const r = await readRemote(intent.member, check, AbortSignal.timeout(5000));
      return r.binding?.id === intent.requestId && r.binding.state === 'installed' && r.binding.expiresAt === intent.grant.expiresAt ? 'installed' : 'unknown';
    },
    async cancel(intent) {
      const t = target(intent.member, check);
      const r = await t.client.json<{ id: string; state: string }>(`${t.path}/${intent.requestId}`, { method: 'DELETE', signal: AbortSignal.timeout(5000) }); t.valid();
      return r?.id === intent.requestId && r.state === 'removed' ? 'revoked' : 'cleanup_pending';
    },
  }));
  const exclusive = async (owner: string, id: string, work: () => Promise<Response>) => {
    const key = JSON.stringify([owner, id]); if (active.has(key)) throw new HTTPException(409);
    if (active.size >= 16) throw new HTTPException(429);
    active.add(key); try { return await work(); } finally { active.delete(key); }
  };
  app.post(base, safe(async c => {
    const { owner, board, check } = scope(c), b = await readJsonBody(c.req.raw, 16384) as {
      batchId: string; selection: DelegationSelection; taskIds: string[]; fields: ('status' | 'detail')[]; expiresAt: number };
    check();
    if (!b || !validBoardUuid(b.batchId) || Object.keys(b).some(k => !['batchId', 'selection', 'taskIds', 'fields', 'expiresAt'].includes(k))) throw new HTTPException(400);
    if (!deps.endpoint || !store.boardBindings.enabled) throw new HTTPException(503);
    if (store.boards.fileManaged(owner, board)) throw new HTTPException(409);
    return exclusive(owner, b.batchId, async () => {
      if (store.delegations.read(owner, b.batchId)) throw new HTTPException(409);
      const current = await input(owner, board, b.selection, b.taskIds, b.fields, check); check();
      return c.json({ batch: store.delegations.prepare(owner, b.batchId, current, b.expiresAt) }, 201);
    });
  }));
  const original = (c: Context, owner: string, board: string) => {
    const id = c.req.param('id')!; if (!validBoardUuid(id)) throw new HTTPException(404);
    const batch = store.delegations.read(owner, id);
    if (!batch || batch.preview.resource.resourceId !== board) throw new HTTPException(404);
    return batch;
  };
  app.get(`${base}/:id`, safe(async c => {
    const { owner, board, check } = scope(c), batch = original(c, owner, board);
    const result = await runner(check).reconcile(owner, batch.batchId); check(); return c.json({ batch: result });
  }));
  app.post(`${base}/:id/confirm`, safe(async c => {
    const { owner, board, check } = scope(c), batch = original(c, owner, board);
    const body = await readJsonBody(c.req.raw, 64); check();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new HTTPException(400);
    return exclusive(owner, batch.batchId, async () => {
      // Duplicate confirmations never resume undispatched members implicitly.
      if (batch.state !== 'prepared') return c.json({ batch: store.delegations.read(owner, batch.batchId) });
      const p = batch.preview, current = await input(owner, board, p.selection, p.resource.tasks.map(t => t.id), p.resource.fields as ('status' | 'detail')[], check);
      check(); store.delegations.confirm(owner, batch.batchId, current);
      const result = await runner(check).run(owner, batch.batchId); check(); return c.json({ batch: result });
    });
  }));
  app.delete(`${base}/:id`, safe(async c => {
    const { owner, board, check } = scope(c), id = c.req.param('id')!;
    if (!validBoardUuid(id)) throw new HTTPException(400);
    const batch = store.delegations.read(owner, id);
    if (batch && batch.preview.resource.resourceId !== board) throw new HTTPException(404);
    // Cancellation deliberately does not wait behind a pending install.
    // Even a lost preview response can be fenced: an absent request receives a
    // durable owner-scoped tombstone, blocking a late prepare with that UUID.
    const result = await runner(check).cancel(owner, id); check(); return c.json({ batch: result ?? null, cancelled: true, batchId: id });
  }));
  return { close() { closed = true; } };
}
