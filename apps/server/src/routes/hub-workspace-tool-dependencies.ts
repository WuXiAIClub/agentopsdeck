import type { Context } from 'hono';
import type { HubPrincipal } from '../hub/identity.js';
import type { AuthRouteAuditStore } from '../auth/route-persistence.js';

/** Private request authority and audit are owned by the same async service.
 * A missing async port is a composition error, never a legacy fallback. */
export type WorkspaceToolRouteDependencies<Access> = {
  mode: 'async'; access: Access; principal?: never; audit?: never;
} | {
  mode?: 'legacy'; access?: Access; principal: (c: Context) => HubPrincipal;
  audit: Pick<AuthRouteAuditStore, 'append'>;
};

export function legacyWorkspaceToolDependencies<Access>(deps: WorkspaceToolRouteDependencies<Access>) {
  if (deps.mode === 'async') throw Error('hub_legacy_workspace_tool_not_selected');
  return deps;
}

export function validateWorkspaceToolDependencies(deps: WorkspaceToolRouteDependencies<{
  requests: { begin: unknown }; audit: { append: unknown }; close: unknown;
}>): void {
  if (deps.mode === 'async' && (typeof deps.access?.requests?.begin !== 'function'
    || typeof deps.access?.audit?.append !== 'function' || typeof deps.access?.close !== 'function'))
    throw Error('Async Hub workspace tool ports are required before route registration');
}
