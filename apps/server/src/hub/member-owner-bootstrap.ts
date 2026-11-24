import { types } from 'node:util';
import type { HubStore } from './hub-store.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { ServerConfig } from '../config.js';
import { usesInProcessConnector } from '../server-role.js';

export type HubDefaultConnection = { kind: 'local'; id: string; label: string; environmentId: string;
  environmentLabel: string; status: 'enabled' | 'degraded' }
  | { kind: 'remote'; id: string; label: string; connectorUrl: string; credentialToken?: string };

export function hubDefaultConnection(config: ServerConfig): HubDefaultConnection | undefined {
  if (usesInProcessConnector(config)) return { kind: 'local', id: config.hub.defaultConnectionId,
    label: config.hub.defaultConnectionLabel, environmentId: config.connector.environmentId,
    environmentLabel: config.connector.environmentLabel, status: config.gatewayWsUrl || config.codex.enabled ? 'enabled' : 'degraded' };
  if (config.hub.localConnectorUrl) return { kind: 'remote', id: config.hub.defaultConnectionId,
    label: config.hub.defaultConnectionLabel, connectorUrl: config.hub.localConnectorUrl,
    ...(config.hub.localConnectorToken === undefined ? {} : { credentialToken: config.hub.localConnectorToken }) };
}
export function initializeHubDefaultConnection(owner: Pick<HubStore, 'ensureLocalConnection' | 'getConnection' | 'upsertConnection'>,
  connection: HubDefaultConnection | undefined): void {
  if (!connection) return;
  if (connection.kind === 'local') {
    owner.ensureLocalConnection({ ...connection, connectorUrl: 'local://aod-connector' }); return;
  }
  const existing = owner.getConnection(connection.id);
  owner.upsertConnection({ ...connection, status: existing?.status ?? 'enabled',
    capabilities: ['sessions', 'messages', 'events', 'media'] }, { preserveCredential: true, audit: false, skipUnchanged: true });
}

/** Original application startup checks must run on the original worker owner,
 * before ready. These paths are trusted configuration, never an RPC command. */
export type HubMemberBootstrap = {
  legacyPreferences: { hidden: string; archived: string; pinned: string };
  /** Combined root only: this original worker is the sole file writer. */
  ownLocalPreferences?: true;
  legacyPreferencesOwner?: string;
  defaultConnection?: HubDefaultConnection;
};

export function parseHubMemberBootstrap(value: unknown): HubMemberBootstrap {
  const unavailable = () => { throw Error('hub_member_storage_unavailable'); };
  const record = (item: unknown, fields: string[]): Record<string, unknown> => {
    if (!item || typeof item !== 'object' || types.isProxy(item)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) return unavailable();
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(item)) {
      if (typeof key !== 'string' || !fields.includes(key)) return unavailable();
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return unavailable();
      result[key] = descriptor.value;
    }
    return result;
  };
  const input = record(value, ['legacyPreferences', 'legacyPreferencesOwner', 'defaultConnection', 'ownLocalPreferences']);
  if (input.ownLocalPreferences !== undefined && input.ownLocalPreferences !== true) unavailable();
  const files = record(input.legacyPreferences, ['hidden', 'archived', 'pinned']);
  const text = (item: unknown, allowEmpty = false): string => {
    if (typeof item !== 'string' || (!allowEmpty && !item) || item.includes('\0') || Buffer.byteLength(item) > 16_384) return unavailable();
    return item;
  };
  let defaultConnection: HubDefaultConnection | undefined;
  if (input.defaultConnection !== undefined) {
    const c = record(input.defaultConnection, ['kind','id','label','environmentId','environmentLabel','status','connectorUrl','credentialToken']);
    const id = text(c.id), label = text(c.label, true);
    if (c.kind === 'local' && Object.keys(c).length === 6 && ['enabled','degraded'].includes(String(c.status)))
      defaultConnection = { kind: 'local', id, label, environmentId: text(c.environmentId, true), environmentLabel: text(c.environmentLabel, true), status: c.status as 'enabled' | 'degraded' };
    else if (c.kind === 'remote' && Object.keys(c).every(k => ['kind','id','label','connectorUrl','credentialToken'].includes(k)))
      defaultConnection = { kind: 'remote', id, label, connectorUrl: text(c.connectorUrl),
        ...(c.credentialToken === undefined ? {} : { credentialToken: text(c.credentialToken) }) };
    else unavailable();
  }
  return { legacyPreferences: { hidden: text(files.hidden), archived: text(files.archived), pinned: text(files.pinned) },
    ...(input.ownLocalPreferences === true ? { ownLocalPreferences: true as const } : {}),
    ...(defaultConnection === undefined ? {} : { defaultConnection }),
    ...(input.legacyPreferencesOwner === undefined ? {} : { legacyPreferencesOwner: text(input.legacyPreferencesOwner) }) };
}

export function initializeHubMemberOwner(owner: Pick<HubStore, 'identities' | 'importLegacySessionPreferences' | 'ensureLocalConnection' | 'getConnection' | 'upsertConnection' | 'reconcileStrandedOwnerFileBindings'>,
  bootstrap: HubMemberBootstrap, administratorKey: string | undefined,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics): void {
  let trace: ReturnType<PerformanceDiagnostics['start']> | undefined;
  try { trace = diagnostics.start('hub-member-sqlite-owner'); } catch { /* Observation is not admission. */ }
  let failed = true;
  try {
    if (owner.identities.hasKeys() && !administratorKey) throw Error('hub_member_storage_unavailable');
    owner.importLegacySessionPreferences(bootstrap.legacyPreferences, bootstrap.legacyPreferencesOwner);
    initializeHubDefaultConnection(owner, bootstrap.defaultConnection);
    owner.reconcileStrandedOwnerFileBindings();
    failed = false;
  } finally {
    try { trace?.add('step', 13); trace?.add(failed ? 'deferred' : 'settled', 1); trace?.finish(failed); }
    catch { /* A broken log sink cannot grant startup or replace its error. */ }
  }
}
