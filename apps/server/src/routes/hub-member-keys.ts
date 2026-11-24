import type { Context, Hono } from 'hono';
import { HubMemberRequestError, type AsyncHubMemberRequests } from '../hub/async-member-request.js';
import { fingerprintRequest } from '../auth/security.js';

/** Original wire responses, with request-pinned original transaction proof.
 * A missing ACK is not permission to retry issuance or revocation. */
export function registerAsyncHubMemberKeys(app: Hono, members: Pick<AsyncHubMemberRequests, 'begin'>,
  administratorKeyConfigured: boolean) {
  const path = '/api/hub/v1/users/:userId/login-keys';
  const failure = (c: Context, error: unknown, issuing = false) => {
    if (error instanceof HubMemberRequestError) {
      if (error.status === 499) return new Response(null, { status: 499, headers: { 'Cache-Control': 'no-store' } });
      if (error.status === 401 || error.status === 403) return c.json({ error: error.status === 401 ? 'unauthorized' : 'forbidden' }, error.status);
      if (issuing && error.status === 409) return c.json({ error: 'Configure an administrator access key before enabling member logins' }, 409);
      if (issuing && (error.status === 400 || error.status === 404)) return c.json({ error: 'Cannot issue login key' }, 400);
    }
    // No token/exception detail in the response or logs. Refetch the current
    // key list before deciding whether a new explicit user action is needed.
    return c.json({ error: 'Login key persistence is unavailable. Reload the key list before retrying.' }, 503);
  };
  const begin = (c: Context) => {
    c.header('Cache-Control', 'no-store');
    const raw = c.req.raw;
    return members.begin(new Request(raw.url, { headers: new Headers(raw.headers), signal: raw.signal }));
  };
  app.post(path, async c => {
    c.header('Cache-Control', 'no-store');
    if (!administratorKeyConfigured) return c.json({ error: 'Configure an administrator access key before enabling member logins' }, 409);
    try { return c.json(await (await begin(c)).issue(c.req.param('userId'), fingerprintRequest(c.req.raw)), 201); }
    catch (error) { return failure(c, error, true); }
  });
  app.get(path, async c => {
    try { return c.json(await (await begin(c)).keys(c.req.param('userId'))); }
    catch (error) { return failure(c, error); }
  });
  app.delete(`${path}/:keyId`, async c => {
    try { return c.json(await (await begin(c)).revoke(c.req.param('userId'), c.req.param('keyId'), fingerprintRequest(c.req.raw))); }
    catch (error) { return failure(c, error); }
  });
}
