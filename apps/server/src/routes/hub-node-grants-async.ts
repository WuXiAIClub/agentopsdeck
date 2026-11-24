import { copyOriginalRequest } from '../hub/original-request-scope.js';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { AsyncHubMemberGrants, HubMemberGrantPolicyError } from '../hub/async-member-grants.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { parseNodeGrantPolicy } from '../hub/node-grants.js';
import { readJsonBody } from '../utils/http-body.js';

type Port = Pick<AsyncHubMemberGrants, 'begin'>;
type Scope = Awaited<ReturnType<Port['begin']>>;
const request = (c: Context) => copyOriginalRequest(c.req.raw);
const failure = (c: Context, error: unknown) => {
  if (error instanceof HubMemberGrantPolicyError) {
    const messages = { missing: 'grant not found', recipient: 'Invalid recipient', managed: 'Use Roles & environments for managed permissions',
      changed: 'Grant version or node authority changed; reload before continuing', unverified: 'Verified current node authority required', capacity: 'Grant could not be saved' };
    return c.json({ error: messages[error.reason] }, error.reason === 'missing' ? 404 : error.reason === 'recipient' ? 400 : 409);
  }
  if (error instanceof HubMemberRequestError && error.status !== 503) {
    if (error.status === 499) return new Response(null, { status: 499 });
    throw new HTTPException(error.status);
  }
  // Unknown may include a committed mutation. Do not present it as a conflict
  // or imply that retrying the original POST/PUT/DELETE is safe.
  return c.json({ error: 'Grant result is unavailable. Reload permissions to check the saved state before retrying.' }, 503);
};
const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const grantPolicy = (scope: Scope, body: Record<string, unknown>) => {
  if (!scope.authority.verified || body.nodeVersion !== scope.authority.nodeVersion) throw new HubMemberGrantPolicyError('unverified');
  try {
    const value = parseNodeGrantPolicy(body.policy);
    if (value.actions.includes('sessions:create') && (value.runtime !== 'codex' || value.agentId || value.sessionKey)) throw new Error('invalid');
    return value;
  } catch { throw new HubMemberRequestError(400); }
};

/** Owner grant routes only. Recipient discovery/sharing remain separate domains,
 * so this optional port must not be confused with full owner activation. */
export function registerAsyncHubNodeGrantRoutes(app: Hono, port: Port, path: string) {
  const input = async (c: Context, keys: string[]) => {
    c.header('Cache-Control', 'no-store');
    const scope = await port.begin(request(c), c.req.param('connectionId')!);
    const body = await readJsonBody(c.req.raw, 8 * 1024);
    await scope.check(); // Preserve pre/post-body node authority, even before invalid-field handling.
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key))
      || keys.some(key => !(key in body))) throw new HubMemberRequestError(400);
    return { scope, body: body as Record<string, unknown> };
  };
  app.get(path, async c => {
    c.header('Cache-Control', 'no-store');
    try {
      const scope = await port.begin(request(c), c.req.param('connectionId')!);
      const after = c.req.query('after') ?? '', limit = c.req.query('limit') === undefined ? 50 : Number(c.req.query('limit'));
      return c.json(await scope.list(after, limit));
    } catch (error) { return failure(c, error); }
  });
  app.post(path, async c => {
    try {
      const { scope, body } = await input(c, ['userId', 'nodeVersion', 'policy']), policy = grantPolicy(scope, body);
      if (typeof body.userId !== 'string' || !body.userId) throw new HubMemberGrantPolicyError('recipient');
      return c.json(await scope.create(body.userId, body.nodeVersion as number, policy), 201);
    } catch (error) { if (error instanceof HTTPException) throw error; return failure(c, error); }
  });
  app.put(`${path}/:grantId`, async c => {
    try {
      const { scope, body } = await input(c, ['version', 'nodeVersion', 'policy']), policy = grantPolicy(scope, body);
      if (!integer(body.version)) throw new HubMemberRequestError(400);
      if (body.version === Number.MAX_SAFE_INTEGER) throw new HubMemberGrantPolicyError('changed');
      return c.json(await scope.replace(c.req.param('grantId'), body.version as number, body.nodeVersion as number, policy));
    } catch (error) { if (error instanceof HTTPException) throw error; return failure(c, error); }
  });
  app.delete(`${path}/:grantId`, async c => {
    try {
      const { scope, body } = await input(c, ['version']);
      if (!integer(body.version)) throw new HubMemberRequestError(400);
      if (body.version === Number.MAX_SAFE_INTEGER) throw new HubMemberGrantPolicyError('changed');
      return c.json(await scope.revoke(c.req.param('grantId'), body.version as number));
    } catch (error) { if (error instanceof HTTPException) throw error; return failure(c, error); }
  });
}
