import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { normalizeConnectorUrl, type HubStore, type HubConnection } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';

type Action = 'create' | 'patch' | 'delete' | 'maintenance';
type Body = { id?: string; label?: string; connectorUrl?: string; token?: string;
  environmentId?: string; environmentLabel?: string; capabilities?: string[]; enabled?: boolean };

/** Keeps the one original synchronous writer. An awaited write owner must not
 * be substituted here: identity/epoch proof and effect belong to the same task.
 * Readonly display IO cannot authorize, undo or replay an admitted write. */
export function registerSynchronousHubConnectionMutations(app: Hono, deps: {
  store: HubStore;
  principal(c: Context): HubPrincipal;
  present(connection: HubConnection, users: Array<{ id: string; label: string }>): unknown;
  diagnostics?: PerformanceDiagnostics;
  warningMs?: number;
}) {
  const store = deps.store, diagnostics = deps.diagnostics ?? performanceDiagnostics;
  const warningMs = deps.warningMs ?? 30_000;
  if (!Number.isSafeInteger(warningMs) || warningMs < 1 || warningMs > 2_147_483_647) throw new Error('Invalid connection mutation warning interval');
  const run = async (c: Context, action: Action) => {
    c.header('Cache-Control', 'no-store');
    // 1=pin, 2=body, 3=effect proof, 4=original effect, 5=display, 6=delivery.
    const trace = guardedTrace(diagnostics, 'hub-connection-mutation');
    let step = 1, failed = true, effectStarted = false, current: (() => void) | undefined;
    const validEpoch = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1;
    const warning = setTimeout(() => trace.reportPending({ step, pending: 1 }), warningMs);
    warning.unref();
    try {
      const { userId, admin } = deps.principal(c);
      const id = action === 'maintenance' ? c.req.param('connectionId') : action === 'create' ? undefined : c.req.param('id');
      let target = id ? store.getConnection(id, userId) : undefined;
      if (action !== 'create' && !target) return c.json(action === 'delete' ? { ok: false } : { error: 'connection not found' }, 404);
      let targetId = target?.id, epoch = targetId ? store.connectionAuthority(targetId, userId) : undefined;
      if (targetId && !validEpoch(epoch)) throw new HTTPException(503, { message: 'hub_connections_unavailable' });
      current = () => {
        const actor = deps.principal(c);
        if (actor.userId !== userId || actor.admin !== admin) throw new HTTPException(401, { message: 'unauthorized' });
        if (c.req.raw.signal.aborted) throw new HTTPException(503, { message: 'hub_connections_unavailable' });
        if (targetId) {
          const latest = store.connectionAuthority(targetId, userId);
          if (!validEpoch(epoch)) throw new HTTPException(503, { message: 'hub_connections_unavailable' });
          if (latest !== epoch) throw new HTTPException(409, { message: 'Connection changed; reload before saving' });
        }
      };
      step = 2;
      const body = action === 'delete' ? {} : await c.req.json().catch(() => ({})) as Body | null;
      step = 3;
      current();
      if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'invalid connection configuration' }, 400);
      if (action === 'maintenance' && (typeof body.token !== 'string' || !body.token.trim())) return c.json({ error: 'token is required' }, 400);
      const connectorUrl = action === 'create' && typeof body.connectorUrl === 'string' ? normalizeConnectorUrl(body.connectorUrl) : undefined;
      if (action === 'create' && (!connectorUrl || connectorUrl === 'local://aod-connector')) return c.json({ error: 'valid remote connectorUrl is required' }, 400);
      if (action === 'create' && (body.label !== undefined && typeof body.label !== 'string'
        || body.capabilities !== undefined && !Array.isArray(body.capabilities)
        || body.id !== undefined && typeof body.id !== 'string'
        || body.token !== undefined && typeof body.token !== 'string'
        || body.environmentId !== undefined && typeof body.environmentId !== 'string'
        || body.environmentLabel !== undefined && typeof body.environmentLabel !== 'string')) {
        return c.json({ error: 'invalid connection configuration' }, 400);
      }
      // Display-only edits intentionally do not revoke an epoch. Merge absent
      // fields with the latest row, not the snapshot from before body await.
      if (targetId) target = store.getConnection(targetId, userId);
      step = 4;
      current(); // No await between proof and any synchronous effect below.
      trace.add('admitted', 1);
      effectStarted = true;
      let connection: HubConnection | undefined;
      if (action === 'create') connection = store.upsertConnection({
        id: body.id, ownerUserId: userId, kind: 'remote', label: body.label ?? 'Remote Connector',
        connectorUrl: connectorUrl!, status: body.enabled === false ? 'disabled' : 'enabled',
        environmentId: body.environmentId, environmentLabel: body.environmentLabel,
        capabilities: body.capabilities?.filter((item): item is string => typeof item === 'string') ?? ['sessions', 'messages', 'events', 'media'],
        credentialToken: body.token,
      });
      else if (action === 'patch') {
        const existing = target!;
        const label = typeof body.label === 'string' ? body.label.trim() : existing.label;
        const environmentLabel = typeof body.environmentLabel === 'string' ? body.environmentLabel.trim() : existing.environmentLabel;
        const environmentId = typeof body.environmentId === 'string' ? body.environmentId.trim() : existing.environmentId;
        if ((environmentId || existing.environmentId) === existing.environmentId
          && (typeof body.enabled !== 'boolean' || (body.enabled ? 'enabled' : 'disabled') === existing.status)) {
          connection = store.renameConnection(existing.id, { label: label || existing.label, environmentLabel }, userId);
        } else connection = store.upsertConnection({ id: existing.id, ownerUserId: userId, kind: existing.kind,
          label: label || existing.label, connectorUrl: existing.connectorUrl,
          status: typeof body.enabled === 'boolean' ? (body.enabled ? 'enabled' : 'disabled') : existing.status,
          environmentId, environmentLabel: environmentLabel || undefined, capabilities: existing.capabilities,
        }, { preserveCredential: true });
      } else if (action === 'maintenance') store.updateMaintenanceCredential(targetId!, body.token!.trim(), userId);
      else {
        const ok = store.deleteConnection(targetId!, userId);
        trace.add('settled', 1); failed = false;
        return c.json({ ok }, ok ? 200 : 404);
      }
      trace.add('settled', 1);
      step = 5;
      // Our own effect may have advanced authority. Capture its epoch in this
      // same task; a later change during readonly IO must still deny delivery.
      targetId = connection?.id ?? targetId;
      epoch = targetId ? store.connectionAuthority(targetId, userId) : undefined;
      if (action === 'maintenance') { current(); failed = false; return c.json({ ok: true, hasMaintenanceCredential: true, updatedAt: Date.now() }); }
      if (!connection) return c.json({ error: 'connection not found' }, 404);
      // The optional owner label is not part of the saved configuration. If
      // its readonly lookup fails, keep the successful write ACK and omit only
      // that decoration. Fresh delivery proof below is still mandatory. Never
      // turn a settled create into a save error that invites a duplicate retry.
      let users: Array<{ id: string; label: string }> = [], displayFailed = false;
      try { users = await store.listUsersAsync(userId, admin); }
      catch { displayFailed = true; trace.add('deferred', 1); }
      step = 6;
      current();
      failed = displayFailed;
      return c.json({ connection: deps.present(connection, users), updatedAt: Date.now() }, action === 'create' ? 201 : 200);
    } catch (error) {
      if (step === 4 && effectStarted) trace.add('unknown', 1);
      // A fresh authority denial outranks display or SQL failure. This never
      // compensates, retries, or interprets missing ACK as a missing effect.
      try { current?.(); } catch (denial) {
        if (denial instanceof HTTPException) throw denial;
        return c.json({ error: 'hub_connections_unavailable' }, 503);
      }
      if (error instanceof HTTPException) throw error;
      return c.json({ error: 'hub_connections_unavailable' }, 503);
    } finally { clearTimeout(warning); trace.add('step', step); trace.finish(failed); }
  };
  const base = '/api/hub/v1/connections';
  app.post(base, c => run(c, 'create'));
  app.patch(`${base}/:id`, c => run(c, 'patch'));
  app.delete(`${base}/:id`, c => run(c, 'delete'));
  app.put(`${base}/:connectionId/maintenance-credential`, c => run(c, 'maintenance'));
}
