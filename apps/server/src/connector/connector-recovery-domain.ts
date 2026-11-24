import type { ConnectorUserStore } from './connector-user-store.js';

export type ConnectorRecoveryCommands = {
  turnRecoveryPage: {
    input: { runtime: 'codex' | 'openclaw'; after: string; limit: number; connectionId: string | null; mirror: boolean };
    output: string[];
  };
};
export type ConnectorRecoveryKind = keyof ConnectorRecoveryCommands;
export const connectorRecoverySteps = Object.freeze({ turnRecoveryPage: 38 });
export const isConnectorRecoveryKind = (kind: string): kind is ConnectorRecoveryKind => kind === 'turnRecoveryPage';
const binary = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const text = (v: unknown, maximum: number) => typeof v === 'string' && v.length > 0
  && !v.includes('\0') && Buffer.byteLength(v) <= maximum;
export function validConnectorRecoveryInput(_kind: ConnectorRecoveryKind, value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>, fields = ['runtime', 'after', 'limit', 'connectionId', 'mirror'];
  return Object.keys(v).length === fields.length && fields.every(field => Object.hasOwn(v, field))
    && (v.runtime === 'codex' || v.runtime === 'openclaw')
    && typeof v.after === 'string' && !v.after.includes('\0') && Buffer.byteLength(v.after) <= 4096
    && Number.isSafeInteger(v.limit) && Number(v.limit) >= 1 && Number(v.limit) <= 64
    && (v.connectionId === null || text(v.connectionId, v.runtime === 'openclaw' ? 512 : 128))
    && typeof v.mirror === 'boolean' && (v.runtime !== 'codex' || v.mirror === false);
}
export function validConnectorRecoveryOutput(_kind: ConnectorRecoveryKind, v: unknown): v is string[] {
  return Array.isArray(v) && v.length <= 64 && v.every((item, index) => text(item, 4096)
    && (index === 0 || binary(v[index - 1]!, item) < 0));
}

/** One fixed observation in the sole original shared DB owner. No arbitrary
 * SQL, callbacks, native requests, authority flags, unlocks or repairs. */
export function executeConnectorRecovery(input: ConnectorRecoveryCommands['turnRecoveryPage']['input'],
  owner: Pick<ConnectorUserStore, 'codexExecutions' | 'openClawExecutions' | 'mirrorOutbox'>): string[] {
  const { runtime, after, limit, connectionId, mirror } = input;
  const checked = (page: string[]) => {
    // Merging/slicing must not disguise corruption in one original source as
    // a legal empty or smaller page. Stop before the next source is queried.
    if (!validConnectorRecoveryOutput('turnRecoveryPage', page) || page.length > limit
      || page.some(value => binary(value, after) <= 0)) throw Error('connector_storage_unavailable');
    return page;
  };
  if (runtime === 'codex') return checked(owner.codexExecutions.recoveryPage(after, limit, connectionId ?? undefined));
  return [...new Set([
    ...checked(owner.openClawExecutions.recoveryPage(connectionId ?? undefined, after, limit)),
    ...checked(owner.openClawExecutions.historyPage(after, limit)),
    ...(mirror ? checked(owner.mirrorOutbox.recoveryPage(after, limit)) : []),
  ])].sort(binary).slice(0, limit);
}
