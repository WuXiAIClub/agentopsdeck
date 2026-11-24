/** Main-side request correlation only. An HTTP header is not a trusted pin.
 * Kept outside RPC DTOs so clients cannot assert an original identity scope. */
const scopes = new WeakMap<Request, string>();
// Undici follows a signal through a weak controller reference. Keeping only
// the copied signal can let an ephemeral source Request/controller be GC'd,
// silently breaking cancellation. A weak key retains the source chain only
// for the lifetime of its live copy, without a global request retention set.
const inheritedSources = new WeakMap<Request, Request>();
export function pinOriginalRequestScope(request: Request, scope: string): void {
  const previous = scopes.get(request);
  if (previous !== undefined && previous !== scope) throw Error('original_request_scope_changed');
  scopes.set(request, scope);
}
export function originalRequestScope(request: Request): string | undefined {
  return scopes.get(request);
}
export function copyOriginalRequest(request: Request, options?: { signal: AbortSignal | null }): Request {
  // null deliberately detaches HTTP lifetime for an already-authorized lease;
  // it never detaches the original private identity correlation.
  const copy = new Request(request.url, {headers: new Headers(request.headers), signal: options ? options.signal : request.signal});
  if (!options) inheritedSources.set(copy, request);
  const scope = scopes.get(request);
  if (scope !== undefined) pinOriginalRequestScope(copy, scope);
  return copy;
}
