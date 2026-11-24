import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createHash } from 'node:crypto';
import { isAgentRuntimeId } from '@agentopsdeck/shared';
import { stableGatewayRowsRevision } from '../refresh/signature.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from '../hub/async-member-request.js';
import type { AsyncConnectorClientResolver } from '../hub/async-connector-client.js';
import type { AsyncHubSessionPreferences } from '../hub/async-session-preferences.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { copyOriginalRequest, pinOriginalRequestScope } from '../hub/original-request-scope.js';
import { weixinRequestBinding } from '../hub/weixin-bridge.js';
import { ConnectorClientError } from '../hub/connector-client.js';
import { ConnectorResponseBudgetPool, ConnectorResponseBudgetExceeded } from '../hub/response-budget.js';
import { observeSessionState } from '../hub/session-state-diagnostics.js';
import { decodeHubSessionId, encodeHubSessionId } from '../hub/session-id.js';
import { legacySessionKey } from '../hub/session-ref.js';
import { publicConnectionWithUser, publicConnectionsWithUsers, wrapSession,
  mergeSessionGroups, filterHiddenSessionGroups } from './hub-session-presentation.js';

const base = '/api/hub/v1';
/** Exact delegation only. Unknown paths and noncanonical session keys retain
 * the parent's normal authentication/compatibility routing. */
export function isAsyncHubDiscoveryRequest(method: string, path: string) {
  if (['GET', 'HEAD'].includes(method) && ['me', 'info', 'users', 'connections', 'sessions/state', 'session-reference']
    .some(suffix => path === `${base}/${suffix}`)) return true;
  if (method !== 'PATCH') return false;
  const match = /^\/api\/sessions\/([^/]+)\/(?:visibility|archive|pin)$/.exec(path);
  if (!match) return false;
  try {
    const key = decodeURIComponent(match[1]!);
    const decoded = decodeHubSessionId(key);
    return !!decoded && encodeHubSessionId(decoded.connectionId, decoded.remoteSessionKey) === key;
  } catch { return false; }
}

export interface HubDiscoveryAccess {
  requests: Pick<AsyncHubMemberRequests, 'begin'>;
  preferences: Pick<AsyncHubSessionPreferences, 'set'>;
  close(): Promise<void>;
}
type Proof = Awaited<ReturnType<HubDiscoveryAccess['requests']['begin']>>;

/** A complete async-only read/display + preference entry. Owns original HTTP
 * work until resolver/transport/body settles; authority owns original SQL ACKs.
 * Neither cancellation nor closing can authorize a retry or new writer. */
export function registerAsyncHubDiscovery(app: Hono, deps: {
  mode: 'async'; access: HubDiscoveryAccess; asyncConnectorClient: AsyncConnectorClientResolver;
  info: Readonly<Record<string, unknown>>;
  responseLimits?: { requestBytes?: number; retainedBytes?: number };
}) {
  if (deps.mode !== 'async' || typeof deps.access?.requests?.begin !== 'function'
    || typeof deps.access?.preferences?.set !== 'function' || typeof deps.access?.close !== 'function'
    || typeof deps.asyncConnectorClient !== 'function' || !deps.info) throw new Error('hub_discovery_ports_required');
  const work = new HubRequestWork();
  const requestBytes = deps.responseLimits?.requestBytes ?? 32 * 1024 * 1024;
  const budget = new ConnectorResponseBudgetPool(deps.responseLimits?.retainedBytes ?? 128 * 1024 * 1024);
  budget.acquire(requestBytes).close();
  let stateReads = 0, closing: Promise<void> | undefined;
  const begin = async (c: Context) => {
    // Only the bridge's exact Request carries its private binding. Never
    // synthesize a transferable HTTP credential for this internal identity.
    const request = weixinRequestBinding(c.req.raw) ? c.req.raw : copyOriginalRequest(c.req.raw);
    const proof = await deps.access.requests.begin(request);
    // HTTP scope is a correlation fence, never authentication. The private pin
    // also survives independent service begins and connector resolution.
    const expected = request.headers.get('x-agentopsdeck-recovery-scope');
    if (expected !== null && expected !== proof.recoveryScope) throw new HubMemberRequestError(409);
    pinOriginalRequestScope(request, proof.recoveryScope);
    work.check();
    return { request, proof };
  };
  const check = async (proof: Proof) => { work.check(); await proof.check(); work.check(); };
  const route = (handler: (c: Context) => Promise<Response>, unavailable = 'hub_discovery_unavailable') => async (c: Context) => {
    c.header('Cache-Control', 'no-store');
    try { return await work.run(() => handler(c)); }
    catch (error) {
      if (error instanceof HubMemberRequestError && error.status === 409)
        return c.json({ error: 'Authenticated account or Hub changed; reload before continuing' }, 409);
      if (error instanceof HubMemberRequestError) return c.json({ error: unavailable }, error.status === 499 ? 503 : error.status);
      if (error instanceof HTTPException) throw error;
      return c.json({ error: unavailable }, 503);
    }
  };
  for (const kind of ['me', 'info', 'users', 'connections', 'session-reference'] as const) {
    app.get(`${base}/${kind}`, route(async c => {
      const { proof } = await begin(c);
      work.check();
      if (kind === 'me' || kind === 'info') {
        await check(proof);
        return c.json(kind === 'me' ? proof.principal : deps.info);
      }
      if (kind === 'users') {
        const result = await proof.users();
        await check(proof);
        return c.json({ users: result.users, updatedAt: Date.now() });
      }
      const directory = await proof.connectionDirectory();
      work.check();
      if (kind === 'connections') {
        // Atomic identity + generation is the final SQL wait.
        await directory.check(); work.check();
        return c.json({ connections: publicConnectionsWithUsers(directory.connections, directory.users), updatedAt: Date.now() });
      }
      const ref = { nodeId: c.req.query('nodeId') ?? '', runtimeId: c.req.query('runtimeId') ?? '', nativeSessionKey: c.req.query('nativeSessionKey') ?? '' };
      let remoteSessionKey: string;
      try {
        if (!isAgentRuntimeId(ref.runtimeId)) throw new Error('invalid');
        remoteSessionKey = legacySessionKey({ ...ref, runtimeId: ref.runtimeId });
      } catch {
        await check(proof);
        return c.json({ error: 'invalid session reference' }, 400);
      }
      const candidates = directory.connections.filter(row => row.nodeId === ref.nodeId && row.status !== 'disabled');
      await directory.check(); work.check();
      if (candidates.length !== 1) return c.json({ error: 'session reference unavailable or ambiguous' }, 404);
      return c.json({ sessionRef: ref, sessionKey: encodeHubSessionId(candidates[0]!.id, remoteSessionKey) });
    }, `hub_${kind}_unavailable`));
  }

  app.get(`${base}/sessions/state`, route(async c => {
    const observation = observeSessionState(c.req.raw.signal);
    let buffered = false, records = 0, reserved = false;
    let collector: ReturnType<ConnectorResponseBudgetPool['acquire']> | undefined;
    try {
      const { request, proof } = await begin(c);
      await check(proof);
      if (stateReads >= 8) { observation.admission(stateReads, false); return c.json({ error: 'hub_session_reads_busy' }, 503); }
      observation.admission(stateReads, true); stateReads++; reserved = true;
      collector = budget.acquire(requestBytes);
      const includeHidden = ['1', 'true'].includes(c.req.query('includeHidden') ?? '');
      const includeArchived = ['1', 'true'].includes(c.req.query('includeArchived') ?? '');
      const initial = await proof.sessionState(); work.check(); observation.stage(2);
      const connections = initial.connections.filter(row => row.status !== 'disabled');
      const read = async (connection: typeof connections[number]) => {
        try {
          const client = await Promise.resolve().then(() => deps.asyncConnectorClient(request, connection.id,
            { expectedUserId: proof.principal.userId })).finally(() => check(proof));
          const state = await client.sessions(request.signal, collector).finally(() => check(proof));
          return { connectionId: connection.id, state: 'ready' as const, sourceCursor: state.sourceCursor,
            groups: state.groups.map(group => ({ ...group, sessions: group.sessions.map(session => wrapSession(session, connection)) })) };
        } catch (error) {
          await check(proof); // Revocation outranks resolver/transport failures.
          if (error instanceof ConnectorResponseBudgetExceeded) throw error;
          return { connectionId: connection.id, state: error instanceof ConnectorClientError && [401, 403, 404].includes(error.status)
            ? 'denied' as const : 'unavailable' as const, groups: [],
            error: error instanceof ConnectorClientError ? error.message : 'Connector unavailable' };
        }
      };
      const rows = new Array<Awaited<ReturnType<typeof read>>>(connections.length);
      let next = 0, refused = false;
      const lane = async () => {
        try {
          while (!refused && !collector!.snapshot().refused && next < connections.length) {
            // Reserve synchronously: another lane can advance next while this
            // lane is awaiting the current authority proof.
            const index = next++;
            await check(proof);
            if (request.signal.aborted) throw new HubMemberRequestError(503);
            if (refused || collector!.snapshot().refused) return;
            rows[index] = await read(connections[index]!);
          }
        } catch (error) { refused = true; throw error; }
      };
      const settled = await Promise.allSettled(Array.from({ length: Math.min(4, connections.length) }, lane));
      await check(proof);
      if (collector.snapshot().refused) return c.json({ error: 'hub_session_response_busy' }, 503);
      const failed = settled.find(row => row.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      observation.stage(3);
      const final = await proof.sessionState(); work.check(); observation.stage(4);
      const byId = new Map(rows.map(row => [row.connectionId, row]));
      const results = final.connections.map(connection => {
        const authority = final.authority(connection.id);
        if (connection.status === 'disabled') return { connectionId: connection.id, authority, state: 'disabled' as const, sourceCursor: undefined, groups: [] };
        const row = byId.get(connection.id);
        if (!row || authority !== initial.authority(connection.id)) return { connectionId: connection.id, authority, state: 'changed' as const,
          sourceCursor: undefined, groups: [], error: 'Connector authorization changed; refresh required' };
        return { ...row, authority };
      }).map(row => ({ ...row, ...filterHiddenSessionGroups(mergeSessionGroups(row.groups), final.preferences, includeHidden, includeArchived) }));
      const groups = mergeSessionGroups(results.flatMap(row => row.groups));
      const counts = { hiddenCount: results.reduce((n, row) => n + row.hiddenCount, 0), archivedCount: results.reduce((n, row) => n + row.archivedCount, 0),
        pinnedCount: results.reduce((n, row) => n + row.pinnedCount, 0) };
      const finalById = new Map(results.map(row => [row.connectionId, row]));
      const publicConnections = final.connections.map(connection => {
        const row = finalById.get(connection.id), presented = publicConnectionWithUser(connection, final.users);
        return row?.error ? { ...presented, status: 'degraded' as const, error: row.error } : presented;
      });
      const viewKey = createHash('sha256').update(JSON.stringify([includeHidden, includeArchived,
        [...final.preferences].sort(([a], [b]) => a.localeCompare(b))])).digest('hex');
      const body = { groups, sources: results.flatMap(row => row.sourceCursor ? [{ connectionId: row.connectionId, cursor: row.sourceCursor }] : []),
        sourceStates: results.map(row => ({ connectionId: row.connectionId, authority: row.authority, state: row.state,
          hiddenCount: row.hiddenCount, archivedCount: row.archivedCount, pinnedCount: row.pinnedCount, ...(row.sourceCursor ? { cursor: row.sourceCursor } : {}) })),
        viewKey, connections: publicConnections, ...counts, updatedAt: Date.now(), revision: stableGatewayRowsRevision([
          { id: 'snapshot-view', text: [viewKey, results.map(({ connectionId, authority, state, hiddenCount, archivedCount, pinnedCount }) =>
            ({ connectionId, authority, state, hiddenCount, archivedCount, pinnedCount }))] }, ...groups,
          ...publicConnections.map(connection => ({ id: `connection:${connection.id}`, status: connection.status,
            label: connection.environmentLabel ?? connection.label, source: connection.environmentId, hasActiveRun: connection.hasCredential,
            text: 'error' in connection ? connection.error : undefined }))]) };
      // One final combined identity/directory/privacy proof; no SQL await after.
      await final.check(); work.check();
      if (request.signal.aborted) throw new HubMemberRequestError(503);
      observation.stage(5); buffered = true; records = groups.reduce((n, group) => n + group.sessions.length, 0);
      return c.json(body);
    } finally {
      if (collector) { const value = collector.snapshot(); observation.responseBudget(value.retainedBytes, value.refused); collector.close(); }
      if (reserved) stateReads--;
      observation.finish(buffered, records);
    }
  }, 'hub_sessions_unavailable'));

  for (const [suffix, field] of [['visibility', 'hidden'], ['archive', 'archived'], ['pin', 'pinned']] as const) {
    app.patch('/api/sessions/:hubSessionId/' + suffix, async (c, next) => {
      if (!isAsyncHubDiscoveryRequest(c.req.method, c.req.path)) return next();
      return route(async context => {
        const { request, proof } = await begin(context);
        const body = await context.req.json().catch(() => ({})).finally(() => check(proof)) as Record<string, unknown> | null;
        const sessionKey = context.req.param('hubSessionId')!, value = body?.[field] !== false;
        await check(proof);
        await deps.access.preferences.set(request, proof.principal.userId, { sessionKey, field, value }).finally(() => check(proof));
        return context.json({ ok: true, sessionKey, [field]: value, updatedAt: Date.now() });
      })(c);
    });
  }
  return { close: () => closing ??= work.close().then(() => deps.access.close()) };
}
