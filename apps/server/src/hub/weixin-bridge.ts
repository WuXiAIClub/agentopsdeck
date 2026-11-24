import type { Hono } from 'hono';
import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import type { WeixinBinding } from './weixin-store.js';
import { WeixinError } from './weixin-transport.js';
import { weixinOriginalEffect } from './weixin-original-effect.js';
import type { AsyncWeixinBackgroundAccess } from './async-weixin-background-access.js';
import { weixinActionFor, type WeixinAction, type WeixinActionResult } from './weixin-action-contract.js';

export type WeixinRequestBinding = Pick<WeixinBinding, 'id' | 'user' | 'keyId'>;
// No header, body or query can enroll a request. Only the bridge below writes
// this map; the private owner protocol receives a reference, never a grant.
const requestBindings = new WeakMap<Request, Readonly<WeixinRequestBinding>>();
export function weixinRequestBinding(request: Request) { return requestBindings.get(request); }
const originalActions = new WeakMap<Request, Readonly<{ command: WeixinAction; observe: (result: WeixinActionResult) => Promise<void> }>>();
/** No clone, header or public credential can select original-effect collection. */
export function weixinOriginalAction(request: Request) { return originalActions.get(request); }

/** Unforgeable in-process request identities. No magic HTTP header or admin bypass.
 * All session/interaction permissions remain in the normal Hub/Connector routes. */
type InternalRequests = WeakMap<Request, () => HubPrincipal | undefined>;
type AsyncBridge = { mode: 'async'; access: Pick<AsyncWeixinBackgroundAccess, 'principal'>; internal: InternalRequests; deadlineMs?: number };
export function weixinBridge(app: Hono, source: AsyncBridge): (row: WeixinBinding, path: string, signal: AbortSignal, body?: unknown) => Promise<unknown>;
export function weixinBridge(app: Hono, source: HubStore, internal: InternalRequests, deadlineMs?: number,
  access?: Pick<AsyncWeixinBackgroundAccess, 'principal'>): (row: WeixinBinding, path: string, signal: AbortSignal, body?: unknown) => Promise<unknown>;
export function weixinBridge(app: Hono, source: HubStore | AsyncBridge, legacyInternal?: InternalRequests, legacyDeadlineMs = 20_000,
  legacyAccess?: Pick<AsyncWeixinBackgroundAccess, 'principal'>) {
  const asyncSource = 'mode' in source && source.mode === 'async' ? source : undefined;
  const access = asyncSource ? asyncSource.access : legacyAccess;
  const internal = asyncSource ? asyncSource.internal : legacyInternal;
  const deadlineMs = asyncSource ? asyncSource.deadlineMs ?? 20_000 : legacyDeadlineMs;
  if (!internal || asyncSource && typeof access?.principal !== 'function') throw new WeixinError('not_configured');
  // Only the legacy composition can capture a synchronous identity reader.
  const legacyPrincipal = access ? undefined : (row: WeixinBinding) => (source as HubStore).weixin.principal(row);
  return async (row: WeixinBinding, path: string, signal: AbortSignal, body?: unknown) => {
    const read = path === '/api/hub/v1/sessions/state' || /^\/api\/hub\/v1\/sessions\/[^/]+\/interactions$/.test(path);
    const answer = /^\/api\/hub\/v1\/sessions\/[^/]+\/interactions\/[^/]+\/answer$/.test(path);
    const stop = /^\/api\/hub\/v1\/sessions\/[^/]+\/messages$/.test(path) && body && typeof body === 'object'
      && 'message' in body && body.message === '/stop' && 'expectedRunId' in body && typeof body.expectedRunId === 'string' && body.expectedRunId.length > 0;
    if (path.includes('?') || path.includes('#') || !(body === undefined ? read : answer || stop)) throw new WeixinError('denied');
    const action = body === undefined ? undefined : weixinActionFor(row.user, path, body);
    if (body !== undefined && !action) throw new WeixinError('denied');
    let request: Request | undefined, known: WeixinActionResult | undefined;
    try { return await weixinOriginalEffect(signal, deadlineMs, 'unknown', async (originalSignal, retain) => {
    // A principal projection satisfies original synchronous route presentation
    // only. Every async SQL operation reconstructs the exact binding evidence
    // and checks current persisted authority; this is never a cached grant.
    const initial = access ? await access.principal(row) : legacyPrincipal!(row);
    const actor = () => !originalSignal.aborted ? access ? initial : legacyPrincipal!(row) : undefined;
    if (!initial || initial.userId !== row.user) throw new WeixinError('denied');
    request = new Request(`http://weixin.example.invalid${path}`, { method: body === undefined ? 'GET' : 'POST', signal: originalSignal,
      headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    internal.set(request, actor);
    requestBindings.set(request, Object.freeze({ id: row.id, user: row.user, keyId: row.keyId }));
    if (action) originalActions.set(request, Object.freeze({ command: action, observe: async result => {
      // Only the fixed native collector can supply an original known result.
      // Snapshot before any caller can mutate its returned projection.
      known ??= JSON.parse(JSON.stringify(result)) as WeixinActionResult;
    } }));
      originalSignal.throwIfAborted();
      const response = await app.fetch(request);
      const reader = response.body ? retain(response.body) : undefined;
      originalSignal.throwIfAborted();
      if (!response.ok || !reader) throw new WeixinError('denied');
      const chunks: Uint8Array[] = []; let bytes = 0;
      while (true) {
        const chunk = await reader.read(); originalSignal.throwIfAborted();
        if (chunk.done) break;
        bytes += chunk.value.byteLength; if (bytes > 4 * 1024 * 1024) throw new WeixinError('invalid_response');
        chunks.push(chunk.value);
      }
      originalSignal.throwIfAborted();
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (action) {
        if (!known) throw new WeixinError('invalid_response');
        return known;
      }
      // An original known write result must reach its worker settlement even
      // if authority was revoked after native acceptance. No next effect is
      // authorized here; the worker rechecks it before advancing.
      const current = access && body !== undefined ? initial : access ? await access.principal(row) : actor();
      if (!current || current.userId !== initial.userId || current.admin !== initial.admin) throw new WeixinError('denied');
      return value;
    }); } catch (error) {
      // weixinOriginalEffect has drained dispatch/read/cancellation ACKs. A
      // denied public HTTP response cannot erase its privately observed ACK.
      if (known) return known;
      throw error;
    } finally {
      // Evidence remains enrolled (but aborted and unusable) until original
      // fetch, reader cancellation and their acknowledgements have drained.
      if (request) { internal.delete(request); requestBindings.delete(request); originalActions.delete(request); }
    }
  };
}
