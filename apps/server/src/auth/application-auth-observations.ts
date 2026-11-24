import { types } from 'node:util';
import type { HubPrincipal } from '../hub/identity.js';
import { copyHubPrincipal } from '../hub/request-authority.js';
import { AuthPersistenceError } from './private-store.js';
import type { Awaitable } from './route-persistence.js';
import type { RequestAuthorization } from './awaited-request-authorization.js';

type MemberIdentity = { userId: string; keyId: string };
function copyMemberIdentity(value: unknown): MemberIdentity | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || types.isProxy(value) || types.isPromise(value)) throw new AuthPersistenceError();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new AuthPersistenceError();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).some(key => key !== 'userId' && key !== 'keyId')) throw new AuthPersistenceError();
  const user = fields.userId, key = fields.keyId;
  if (!user || !key || !('value' in user) || !('value' in key)
    || typeof user.value !== 'string' || !user.value || typeof key.value !== 'string' || !key.value) throw new AuthPersistenceError();
  return Object.freeze({ userId: user.value, keyId: key.value });
}

/** HTTP read adapters only. They never replace an original transaction's
 * synchronous authority callback or transport a cached grant into a worker.
 * The route owns bounded read waits, diagnostics and mutation ACK handling. */
export function createApplicationAuthObservations(deps: {
  hasHub: boolean;
  principal: (request: Request) => Awaitable<HubPrincipal | undefined>;
  standaloneAuthorization: RequestAuthorization;
  memberIdentity: (request: Request) => Awaitable<MemberIdentity | undefined>;
  keyIdentity: (key: string | undefined) => Awaitable<MemberIdentity | undefined>;
  recoveryScope: (principal: HubPrincipal, request: Request) => Awaitable<string | undefined>;
}) {
  const principal = async (request: Request) => {
    const value = await deps.principal(request);
    if (value === undefined) return undefined;
    const proof = copyHubPrincipal(value);
    if (!proof) throw new AuthPersistenceError();
    return proof;
  };
  const current = async (request: Request, actor: HubPrincipal) => {
    const value = await principal(request);
    return value?.userId === actor.userId && value.admin === actor.admin;
  };
  return {
    async observeAuthorization(request: Request) {
      return deps.hasHub ? (await principal(request)) !== undefined : (await deps.standaloneAuthorization(request)) === true;
    },
    async memberSessionCurrent(token: string, request: Request) {
      // Query the newly issued session, NOT the login request's old cookie/key.
      const identity = await deps.memberIdentity(new Request('http://auth.invalid/', {
        headers: { cookie: `agentopsdeck_session=${encodeURIComponent(token)}` }, signal: request.signal,
      }));
      return copyMemberIdentity(identity) !== undefined;
    },
    async memberKeyIdentity(key: string | undefined) {
      return copyMemberIdentity(await deps.keyIdentity(key));
    },
    async auditIdentity(request: Request) {
      const actor = await principal(request);
      if (actor?.admin || (!deps.hasHub && (await deps.standaloneAuthorization(request)) === true)) {
        return Object.freeze({ userId: actor?.userId ?? 'default', authMethod: 'administrator' as const });
      }
      if (!actor) return undefined;
      const member = copyMemberIdentity(await deps.memberIdentity(request));
      if (!member || member.userId !== actor.userId || !await current(request, actor)) return undefined;
      return Object.freeze({ ...member, authMethod: 'member' as const });
    },
    async recoveryScope(request: Request) {
      const actor = await principal(request);
      if (!actor) return undefined;
      const scope = await deps.recoveryScope(actor, request);
      if (scope !== undefined && (typeof scope !== 'string' || !/^[a-f0-9]{64}$/.test(scope))) throw new AuthPersistenceError();
      return await current(request, actor) ? scope : undefined;
    },
  };
}
