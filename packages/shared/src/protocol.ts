/** Product version and wire compatibility are deliberately independent.
 * Additive features are negotiated by capabilities, never by version strings. */
// Manually maintained release version; never inferred from the build date or Git.
export const AGENTOPSDECK_VERSION = '1.0.0';
export const AGENTOPSDECK_PRODUCT_NAME = 'AgentOpsDeck';
export const CONNECTOR_PROTOCOL = { min: 1, max: 1 } as const;
export const CONNECTOR_PROTOCOL_HEADER = 'x-agentopsdeck-protocol';
export type ProtocolRange = { min: number; max: number };

export function negotiateConnectorProtocol(remote: unknown): number | undefined {
  // The existing /v1 route contract predates explicit ranges.
  if (remote === undefined) return 1;
  if (!remote || typeof remote !== 'object') return undefined;
  const { min, max } = remote as ProtocolRange;
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1 || max < min) return undefined;
  const selected = Math.min(CONNECTOR_PROTOCOL.max, max);
  return selected >= Math.max(CONNECTOR_PROTOCOL.min, min) ? selected : undefined;
}

export function acceptsConnectorProtocolHeader(value: string | null | undefined) {
  return value == null || value === '1';
}
