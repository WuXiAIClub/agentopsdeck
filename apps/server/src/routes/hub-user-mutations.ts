import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Awaitable } from '../auth/route-persistence.js';
import type { HubStore, HubUser } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { readJsonBody } from '../utils/http-body.js';
import { validHubUserAccessCommand, type HubUserAccess, type HubUserAccessCommand } from '../hub/user-access.js';

export type HubUserMutationAuthority = {
  principal: HubPrincipal;
  check(): Awaitable<void>;
  createUser(label: string): Awaitable<HubUser>;
  updateUser(userId: string, label: string): Awaitable<HubUser | undefined>;
  getUserAccess?(userId: string): Awaitable<HubUserAccess>;
  setUserAccess?(userId: string, status: HubUserAccess['status'], expectedVersion: number): Awaitable<HubUserAccess>;
};
/** The caller pins one original request across body consumption, mutation and
 * final delivery. An awaited owner must also prove authority with its effect
 * inside the original SQL transaction. No retry, cookie creation or activation. */
export function registerHubUserMutations(app: Hono, deps: {
  begin(c: Context): Awaitable<HubUserMutationAuthority>;
  normalizeError(error: unknown): string;
  diagnostics?: PerformanceDiagnostics;
  warningMs?: number;
}) {
  const diagnostics = deps.diagnostics ?? performanceDiagnostics, warningMs = deps.warningMs ?? 30_000;
  if (!Number.isSafeInteger(warningMs) || warningMs < 1 || warningMs > 2_147_483_647) throw new Error('Invalid user mutation warning interval');
  const run = async (c: Context, creating: boolean) => {
    c.header('Cache-Control', 'no-store');
    // Fixed phase IDs only: 1=authority, 2=body, 3=pre-effect proof,
    // 4=original effect, 5=delivery proof. This is not a COMMIT receipt.
    const trace = guardedTrace(diagnostics, 'hub-user-change');
    let step = 1, failed = true;
    const warning = setTimeout(() => trace.reportPending({ step, pending: 1 }), warningMs);
    warning.unref();
    try {
      const authority = await deps.begin(c);
      if (!authority.principal.admin) return c.json({ error: 'forbidden' }, 403);
      step = 2;
      const body = await c.req.json().catch(() => ({})) as { label?: unknown } | null;
      step = 3;
      await authority.check();
      // Preserve additive frontend payloads and the original error shape.
      const label = body?.label;
      if (typeof label !== 'string' || !label.trim()) return c.json({ error: 'label is required' }, 400);
      step = 4;
      const user = creating ? await authority.createUser(label) : await authority.updateUser(c.req.param('userId')!, label);
      trace.add('settled', 1);
      // A final denial neither undoes nor resends an admitted mutation.
      step = 5;
      await authority.check();
      if (!user) return c.json({ error: 'user not found' }, 404);
      failed = false;
      return creating ? c.json({ user, updatedAt: Date.now() }, 201) : c.json({ user, updatedAt: Date.now() });
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      if (error instanceof HubMemberRequestError) {
        if (step === 4 && error.status === 503) trace.add('unknown', 1);
        if (error.status === 404) return c.json({ error: 'user not found' }, 404);
        const message = error.status === 400 ? 'label is required' : error.status === 401 ? 'unauthorized'
          : error.status === 403 ? 'forbidden' : error.status === 499 ? 'request_cancelled' : 'hub_users_unavailable';
        return new Response(JSON.stringify({ error: message }), { status: error.status,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      }
      if (step === 4) trace.add('unknown', 1);
      return c.json({ error: deps.normalizeError(error) }, 400);
    } finally {
      clearTimeout(warning); trace.add('step', step); trace.finish(failed);
    }
  };
  app.post('/api/hub/v1/users', c => run(c, true));
  app.patch('/api/hub/v1/users/:userId', c => run(c, false));
  const access = async (c: Context, writing: boolean) => {
    c.header('Cache-Control', 'no-store');
    try {
      const authority = await deps.begin(c);
      if (!authority.principal.admin) return c.json({ error: 'forbidden' }, 403);
      const userId = c.req.param('userId')!;
      let command: HubUserAccessCommand = { action: 'accessRead', userId };
      if (writing) {
        const body = await readJsonBody(c.req.raw, 1024);
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).sort().join() !== 'expectedVersion,status') return c.json({ error: 'invalid_user_access' }, 400);
        const values = body as { status: HubUserAccess['status']; expectedVersion: number };
        command = { action: 'accessChange', userId, status: values.status, expectedVersion: values.expectedVersion };
      }
      await authority.check();
      if (!validHubUserAccessCommand(command)) return c.json({ error: 'invalid_user_access' }, 400);
      if (!authority.getUserAccess || !authority.setUserAccess) throw new HubMemberRequestError(503);
      const result = command.action === 'accessRead' ? await authority.getUserAccess(userId)
        : await authority.setUserAccess(userId, command.status, command.expectedVersion);
      await authority.check(); // A late denial does not undo or repeat the effect.
      return c.json({ access: result });
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      const status = error instanceof HubMemberRequestError ? error.status : 503;
      const message = status === 400 ? 'invalid_user_access' : status === 401 ? 'unauthorized'
        : status === 403 ? 'forbidden' : status === 404 ? 'user not found' : status === 409 ? 'user_access_conflict'
          : status === 499 ? 'request_cancelled' : 'hub_users_unavailable';
      return new Response(JSON.stringify({ error: message }), { status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
  };
  app.get('/api/hub/v1/users/:userId/access', c => access(c, false));
  app.patch('/api/hub/v1/users/:userId/access', c => access(c, true));
}

/** Default application facade keeps the original synchronous owner. Checks
 * immediately precede its effects in the same task, not across an await. */
export function registerSynchronousHubUserMutations(app: Hono, store: Pick<HubStore, 'createUser' | 'updateUser'> & Partial<Pick<HubStore, 'identities'>>,
  principal: (c: Context) => HubPrincipal, normalizeError: (error: unknown) => string) {
  registerHubUserMutations(app, { normalizeError, begin(c) {
    const { userId, admin } = principal(c);
    const scope = store.identities?.recoveryScope({ userId, admin });
    const check = () => {
      const current = principal(c);
      if (current.userId !== userId || current.admin !== admin
        || scope !== undefined && store.identities!.recoveryScope(current) !== scope) throw new HTTPException(401, { message: 'unauthorized' });
    };
    const access = (change: HubUserAccessCommand) => {
      check();
      if (!store.identities || scope === undefined) throw new HubMemberRequestError(503);
      const result = store.identities.administratorUserCommand(c.req.raw, scope, store as HubStore, change);
      if (result === null) throw new HubMemberRequestError(401);
      if ('error' in result) throw new HubMemberRequestError(result.error === 'missing' ? 404 : result.error === 'conflict' ? 409 : 403);
      if (!('access' in result)) throw new HubMemberRequestError(503);
      return result.access;
    };
    return { principal: Object.freeze({ userId, admin }), check,
      getUserAccess(id) { return access({ action: 'accessRead', userId: id }); },
      setUserAccess(id, status, expectedVersion) { return access({ action: 'accessChange', userId: id, status, expectedVersion }); },
      createUser(label) { check(); return store.createUser(label); },
      updateUser(id, label) { check(); return store.updateUser(id, label); } };
  } });
}
