import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HubStore } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';
import type { NodeAction, NodeGrantProof } from '../hub/node-grants.js';
import { decodeHubSessionId } from '../hub/session-id.js';
import { sessionRef } from '../hub/session-ref.js';

/** Capture original grant versions once per request, then revalidate after
 * awaits and during streaming. A replacement grant never revives this proof.
 */
export function sharedSessionAccess(c: Context, deps: { hubStore: HubStore; principal: (c: Context) => HubPrincipal }) {
  c.header('Cache-Control', 'no-store');
  const store = deps.hubStore, userId = deps.principal(c).userId;
  store.roles.syncAdministrator(deps.principal(c));
  const ownerUserId = c.req.param('ownerUserId')!, sessionId = c.req.param('sessionId')!;
  const decoded = decodeHubSessionId(sessionId);
  if (!decoded || sessionId.length > 4096) throw new HTTPException(404, { message: 'Shared session not found' });
  const connection = store.getConnection(decoded.connectionId, ownerUserId);
  let ref;
  try { ref = sessionRef(connection?.nodeId, decoded.remoteSessionKey); } catch { /* Fail closed for unverified targets. */ }
  if (!connection || connection.status === 'disabled' || !ref) throw new HTTPException(404, { message: 'Shared session not found' });
  const policyTarget = { userId, ownerUserId, connectionId: connection.id, administrator: deps.principal(c).admin };
  // Agent-only grants require a verified session -> agent mapping, not a caller assertion.
  const resource = { runtime: ref.runtimeId, sessionKey: decoded.remoteSessionKey };
  const readProof = store.grants.authorize(policyTarget, 'messages:read', resource);
  if (!readProof) throw new HTTPException(404, { message: 'Shared session not found' });
  const proofs = new Map<NodeAction, NodeGrantProof>([['messages:read', readProof]]);
  const read = () => {
    if (deps.principal(c).userId !== userId) throw new HTTPException(401, { message: 'unauthorized' });
    if (!store.grants.revalidate(readProof)) throw new HTTPException(403, { message: 'Shared session access changed' });
  };
  const require = (action: NodeAction) => {
    read();
    const proof = proofs.get(action) ?? store.grants.authorize(policyTarget, action, resource);
    if (!proof || !store.grants.revalidate(proof)) throw new HTTPException(403, { message: 'Shared action access denied' });
    proofs.set(action, proof);
    return proof;
  };
  // For response hints only; actual operations still capture/revalidate require().
  const allows = (action: NodeAction) => { read(); return !!store.grants.authorize(policyTarget, action, resource); };
  const allowsTogether = (first: NodeAction, ...remaining: NodeAction[]) => {
    read();
    const proof = store.grants.authorize(policyTarget, first, resource);
    return !!proof && remaining.every(action => store.grants.revalidate({ ...proof, action }));
  };
  return { target: { userId, ownerUserId, sessionId }, connection, ref, resource, readProof, read, require, allows, allowsTogether };
}
