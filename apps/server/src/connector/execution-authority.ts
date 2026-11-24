import { HTTPException } from 'hono/http-exception';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import type { ExecutionAction, ExecutionGrants, ExecutionGrantTarget } from './execution-grants.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';

export const EXECUTION_GRANT_HEADER = 'x-agentopsdeck-execution-grant';

// A known pre-dispatch denial must be readable by receipt middleware. Plain
// text exceptions would leave a freshly claimed command outcome_unknown.
function denied(message: string) {
  return new HTTPException(403, { res: Response.json({ error: message }, { status: 403 }) });
}

export function resolveExecutionActor(request: Request, deps: { tokens: ConnectorTokenStore; grants: ExecutionGrants; nodeId: string },
  target: ExecutionGrantTarget, action?: ExecutionAction) {
  const principal = deps.tokens.authenticate(request);
  if (!principal) throw denied('Connector actor required');
  const id = request.headers.get(EXECUTION_GRANT_HEADER);
  if (id === null && !principal.scopes.includes('execution:delegate')) return { principal, actorId: principal.tokenId };
  const hubId = deps.tokens.delegationHubId(principal.tokenId);
  // A missing/malformed grant on an issuer credential must never downgrade to
  // its much broader Connector-token actor. The header carries only a ref ID.
  if (!id || !hubId || request.headers.get(EXPECTED_NODE_HEADER) !== deps.nodeId) {
    throw denied('Pinned execution delegation required');
  }
  const executionGrant = deps.grants.resolve(id, principal.tokenId, hubId, target);
  if (!executionGrant || (action && !deps.grants.authorize(executionGrant, principal.tokenId, target, action))) {
    throw denied('Execution delegation is not authorized');
  }
  return { principal, actorId: executionGrant.actorId, executionGrant };
}
