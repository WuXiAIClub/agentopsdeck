import { CONNECTOR_SCOPES, type ConnectorTokenStore } from '../auth/connector-token.js';
import { LOCAL_CREDENTIAL_IDENTITIES, type LocalCredentialSpec } from './local-credential-plan.js';

export type LocalCredentialBundle = { leaseId: string; credentials: (LocalCredentialSpec & { token: string })[] };
export type LocalCredentialsCommands = {
  localCredentialsCreate: { input: { leaseId: string; specs: LocalCredentialSpec[] }; output: LocalCredentialBundle };
  localCredentialsRelease: { input: { leaseId: string }; output: { leaseId: string; released: boolean } };
};
export type LocalCredentialsKind = keyof LocalCredentialsCommands;
export const localCredentialsSteps = Object.freeze({ localCredentialsCreate: 140, localCredentialsRelease: 141 });
export const isLocalCredentialsKind = (kind: string): kind is LocalCredentialsKind => Object.hasOwn(localCredentialsSteps, kind);
const record = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && keys.length === Object.keys(v).length && keys.every(k => Object.hasOwn(v, k));
const lease = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const specs = (v: unknown, credential = false): v is LocalCredentialBundle['credentials'] => Array.isArray(v) && v.length >= 2 && v.length <= 5
  && v.every(s => record(s, credential ? ['role', 'identity', 'scopes', 'token'] : ['role', 'identity', 'scopes'])
    && typeof s.role === 'string' && Object.hasOwn(LOCAL_CREDENTIAL_IDENTITIES, s.role)
    && s.identity === LOCAL_CREDENTIAL_IDENTITIES[s.role as keyof typeof LOCAL_CREDENTIAL_IDENTITIES]
    && Array.isArray(s.scopes) && s.scopes.length <= CONNECTOR_SCOPES.length
    && s.scopes.every(scope => CONNECTOR_SCOPES.includes(scope)) && new Set(s.scopes).size === s.scopes.length
    && (!credential || typeof s.token === 'string' && /^aod_local_[A-Za-z0-9_-]{43}$/.test(s.token)))
  && new Set(v.map(s => s.role)).size === v.length && v.some(s => s.role === 'daily') && v.some(s => s.role === 'maintenance');
export function validLocalCredentialsInput(kind: LocalCredentialsKind, value: unknown): boolean {
  return kind === 'localCredentialsCreate' ? record(value, ['leaseId', 'specs']) && lease(value.leaseId) && specs(value.specs)
    : record(value, ['leaseId']) && lease(value.leaseId);
}
export function validLocalCredentialsOutput(kind: LocalCredentialsKind, value: unknown): boolean {
  return kind === 'localCredentialsCreate' ? record(value, ['leaseId', 'credentials']) && lease(value.leaseId) && specs(value.credentials, true)
    : record(value, ['leaseId', 'released']) && lease(value.leaseId) && typeof value.released === 'boolean';
}
export function localCredentialsMatch(input: LocalCredentialsCommands['localCredentialsCreate']['input'], output: LocalCredentialBundle): boolean {
  return input.leaseId === output.leaseId && input.specs.length === output.credentials.length
    && input.specs.every((s, i) => { const c = output.credentials[i]!;
      return c.role === s.role && c.identity === s.identity && s.scopes.length === c.scopes.length && s.scopes.every((scope, j) => scope === c.scopes[j]); });
}

/** Internal startup capability only, never an HTTP provisioning endpoint.
 * One attempted bundle per worker lifetime, including failed or lost ACKs. */
export function createLocalCredentialsCommands(tokens?: ConnectorTokenStore) {
  let attempted = false, leaseId: string | undefined, released = false;
  const disposers: (() => void)[] = [];
  const dispose = () => { for (const release of disposers.splice(0).reverse()) release(); released = true; };
  return {
    dispose,
    execute<K extends LocalCredentialsKind>(kind: K, input: LocalCredentialsCommands[K]['input']): LocalCredentialsCommands[K]['output'] {
      if (!tokens || !validLocalCredentialsInput(kind, input)) throw Error('Local credentials unavailable');
      if (kind === 'localCredentialsRelease') {
        if (input.leaseId === leaseId && !released) dispose();
        return { leaseId: input.leaseId, released: input.leaseId === leaseId && released } as LocalCredentialsCommands[K]['output'];
      }
      if (attempted) throw Error('Local credentials already attempted');
      attempted = true;
      const original = input as LocalCredentialsCommands['localCredentialsCreate']['input'];
      leaseId = original.leaseId;
      try {
        const credentials = original.specs.map(spec => {
          const credential = tokens.createTransient(spec.scopes, spec.identity); disposers.push(credential.dispose);
          return { ...spec, scopes: [...spec.scopes], token: credential.token };
        });
        return { leaseId, credentials } as LocalCredentialsCommands[K]['output'];
      } catch (error) { dispose(); throw error; }
    },
  };
}
