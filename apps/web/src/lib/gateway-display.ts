import type { GatewayHealth } from '@agentopsdeck/shared';

/** Shared status labels must not eagerly pull the administration panel into
 * the initial workspace bundle. This observation has no mutation or fetch. */
export function gatewayDisplayState(gateway: GatewayHealth | undefined): { label: string; badge: string; hint: string; variant: 'running' | 'accent' | 'muted' | 'default' } {
  if (!gateway) return { label: 'unknown', badge: 'unknown', hint: 'Gateway status has not loaded yet.', variant: 'muted' };
  if (gateway.enabled === false) return { label: 'disabled', badge: 'disabled', hint: 'OpenClaw is disabled; Codex runs independently.', variant: 'muted' };
  if (gateway.ok || gateway.status === 'online') return { label: 'online', badge: 'online', hint: 'Gateway is reachable.', variant: 'running' };
  if (gateway.degraded) return { label: 'degraded', badge: 'degraded', hint: 'Gateway is partially available.', variant: 'accent' };
  return { label: gateway.status ?? 'offline', badge: gateway.status ?? 'offline', hint: 'Gateway unavailable.', variant: 'default' };
}
