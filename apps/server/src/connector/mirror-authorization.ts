import { resolveExplicitChannelRoute, type MirrorParams } from '../messages/mirror.js';
import type { AuthorizeTurn } from './execution-grants.js';

export function createMirrorAuthorizer(authorizeTurn: AuthorizeTurn, defaultAgentId: string) {
  return (params: MirrorParams) => {
    const target = { runtime: 'openclaw' as const, sessionKey: params.sessionKey };
    if (!authorizeTurn(params.actorId, target, 'messages:send', params.executionGrant)
      || !authorizeTurn(params.actorId, target, 'messages:mirror', params.executionGrant)) return false;
    const route = resolveExplicitChannelRoute(params.sessionKey, defaultAgentId);
    return !!route && route.originatingChannel === params.explicitRoute.originatingChannel
      && route.originatingTo === params.explicitRoute.originatingTo && route.originatingAccountId === params.explicitRoute.originatingAccountId
      && route.outboundTarget === params.explicitRoute.outboundTarget;
  };
}
