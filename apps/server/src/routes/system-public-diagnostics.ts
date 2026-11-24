import type { GatewayHealth } from '@agentopsdeck/shared';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function publicGatewayWs(value: unknown) {
  const status = record(value);
  return { configured: status.configured === true || typeof status.url === 'string' && status.url.length > 0,
    connected: status.connected === true };
}

export function publicAdminRpc(value: unknown) {
  return { configured: record(value).configured === true };
}

export function publicGatewayHealth(value: GatewayHealth, defaultAgentId: string): GatewayHealth {
  const sources = ['disabled', 'gateway ws', 'gateway ws + remote mode', 'openclaw status --json'];
  const source = record(value.details).source;
  const disabled = value.enabled === false;
  const reachable = value.ok === true;
  const status = ['online', 'offline', 'degraded', 'unknown'].includes(value.status)
    ? value.status : 'unknown';
  const version = typeof value.version === 'string' && /^\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(value.version)
    ? value.version : undefined;
  return {
    ok: reachable, ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
    status: disabled ? 'unknown' : status,
    degraded: value.degraded === true,
    updatedAt: Number.isSafeInteger(value.updatedAt) && value.updatedAt >= 0 ? value.updatedAt : Date.now(),
    ...(version ? { version } : {}),
    ...(!disabled && defaultAgentId ? { defaultAgentId } : {}),
    gatewayWs: publicGatewayWs(value.gatewayWs), adminRpc: publicAdminRpc(value.adminRpc),
    details: { source: typeof source === 'string' && sources.includes(source) ? source : 'unknown' },
    ...(value.error ? { error: 'gateway_probe_failed' } : {}),
    note: disabled ? 'OpenClaw is disabled on this Connector. Codex runs independently.'
      : reachable ? 'Gateway is reachable.' : 'Gateway is not reachable.',
  };
}
