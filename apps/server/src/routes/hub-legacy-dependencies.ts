import type { Context } from 'hono';
import type { HubStore } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';

/** Explicit compatibility lane, never a fallback for a failed async request. */
export type LegacyHubRouteDependencies = {
  mode?: 'legacy'; hubStore: HubStore; principal: (context: Context) => HubPrincipal;
};
export type AsyncOnlyHubRouteDependencies = { mode: 'async'; hubStore?: never; principal?: never };
export function requireLegacyHubRoute(deps: LegacyHubRouteDependencies | AsyncOnlyHubRouteDependencies): LegacyHubRouteDependencies {
  if (deps.mode === 'async') throw Error('hub_legacy_route_not_selected');
  return deps;
}

export type LegacyHubStoreRouteDependencies = {
  mode?: 'legacy'; store: HubStore; principal: (context: Context) => HubPrincipal;
};
export type AsyncOnlyHubStoreRouteDependencies = { mode: 'async'; store?: never; principal?: never };
export function requireLegacyHubStoreRoute(deps: LegacyHubStoreRouteDependencies | AsyncOnlyHubStoreRouteDependencies): LegacyHubStoreRouteDependencies {
  if (deps.mode === 'async') throw Error('hub_legacy_route_not_selected');
  return deps;
}
