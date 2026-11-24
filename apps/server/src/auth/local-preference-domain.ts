import { safeEqual } from './access-key.js';
import { AuthPersistenceError } from './private-store.js';
import { validOriginalJsonAuthCommand, type OriginalJsonEvidence } from './original-json-command-domain.js';
import { validSqliteAuthInput, SQLITE_AUTH_RESULT_BYTES } from './sqlite-owner-domain.js';
import { changeSessionPreference, currentPreferences } from '../projection/session-preference-file.js';

export type LocalPreferenceKind = 'hidden' | 'archived' | 'pinned';
export type LocalPreferenceFiles = Record<LocalPreferenceKind, string>;
export type LocalPreferenceInput = { field: LocalPreferenceKind; key: string; enabled: boolean; evidence: OriginalJsonEvidence };
export type LocalPreferenceResult = { denied: true } | {
  field: LocalPreferenceKind; key: string; enabled: boolean; values: string[];
};
export type AcceptedLocalPreference = Exclude<LocalPreferenceResult, { denied: true }>;
export type LocalPreferenceSnapshot = Record<LocalPreferenceKind, string[]>;
const fields = ['hidden', 'archived', 'pinned'] as const;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function validLocalPreferenceFiles(value: unknown): value is LocalPreferenceFiles {
  return record(value) && Object.keys(value).length === 3 && fields.every(field => Object.hasOwn(value, field)
    && typeof value[field] === 'string' && value[field].length > 0 && !value[field].includes('\0'));
}
export function validLocalPreferenceInput(value: unknown, json: boolean): value is LocalPreferenceInput {
  return record(value) && Object.keys(value).length === 4
    && Object.hasOwn(value, 'field') && fields.includes(value.field as LocalPreferenceKind)
    && Object.hasOwn(value, 'key') && typeof value.key === 'string' && value.key.length > 0 && Buffer.byteLength(value.key) <= 4096
    && Object.hasOwn(value, 'enabled') && typeof value.enabled === 'boolean'
    && Object.hasOwn(value, 'evidence') && (json
      ? validOriginalJsonAuthCommand({ kind: 'originalJsonAuthorized', input: value.evidence })
      : validSqliteAuthInput('authorized', value.evidence));
}
export function validLocalPreferenceOutput(value: unknown): value is LocalPreferenceResult {
  if (!record(value)) return false;
  if (Object.hasOwn(value, 'denied')) return Object.keys(value).length === 1 && value.denied === true;
  return Object.keys(value).length === 4 && fields.includes(value.field as LocalPreferenceKind)
    && typeof value.key === 'string' && value.key.length > 0 && Buffer.byteLength(value.key) <= 4096
    && typeof value.enabled === 'boolean' && Array.isArray(value.values)
    && value.values.every(v => typeof v === 'string' && v.length > 0)
    && new Set(value.values).size === value.values.length
    && value.values.includes(value.key) === value.enabled;
}
export function validLocalPreferenceSnapshot(value: unknown): value is LocalPreferenceSnapshot {
  return record(value) && Object.keys(value).length === 3 && fields.every(field => Object.hasOwn(value, field)
    && Array.isArray(value[field]) && value[field].every(v => typeof v === 'string' && v.length > 0)
    && new Set(value[field]).size === value[field].length);
}

/** Fixed original file effects inside the ORIGINAL standalone authority owner.
 * authorize is built in that worker from its store, never sent over RPC. No
 * cached boolean, main-thread fs, arbitrary path or native execution permit. */
export class OriginalLocalPreferences {
  private readonly values = new Map<LocalPreferenceKind, Set<string>>();
  constructor(private readonly files: LocalPreferenceFiles) {
    if (!validLocalPreferenceFiles(files)) throw new AuthPersistenceError();
  }
  snapshot(): LocalPreferenceSnapshot {
    const result = Object.fromEntries(fields.map(field => [field, [...currentPreferences(this.files[field], new Set())]]));
    if (!validLocalPreferenceSnapshot(result) || Buffer.byteLength(JSON.stringify(result)) > SQLITE_AUTH_RESULT_BYTES) {
      throw new AuthPersistenceError();
    }
    return result;
  }
  change(input: LocalPreferenceInput, authorize: (proof: OriginalJsonEvidence) => boolean): LocalPreferenceResult {
    if (authorize(input.evidence) !== true) return { denied: true };
    const values = changeSessionPreference(this.values.get(input.field) ?? new Set(), this.files[input.field], input.key, input.enabled);
    const result = { field: input.field, key: input.key, enabled: input.enabled, values: [...values] };
    // An oversized ACK after a successful original save is UNKNOWN, not a
    // reason to truncate the projection, undo disk or repeat the operation.
    if (!validLocalPreferenceOutput(result) || Buffer.byteLength(JSON.stringify(result)) > SQLITE_AUTH_RESULT_BYTES) {
      throw new AuthPersistenceError();
    }
    this.values.set(input.field, values);
    return result;
  }
}

/** Same session-first semantics as executeSqliteAuthCommand's standalone
 * authority. Kept synchronous so no Auth revocation can interleave between
 * this original-store check and the fixed synchronous file replacement. */
export function originalStandaloneAuthorization(store: { sessionAuthorized(token: string): boolean },
  digest: string | undefined, proof: OriginalJsonEvidence): boolean {
  return proof.sessionToken !== undefined && store.sessionAuthorized(proof.sessionToken)
    || digest === undefined || proof.suppliedKeyDigest !== undefined && safeEqual(digest, proof.suppliedKeyDigest);
}
