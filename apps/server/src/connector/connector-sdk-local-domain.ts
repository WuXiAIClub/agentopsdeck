import { randomUUID } from 'node:crypto';
import { readSessionSettingsResult, sessionRuntimeId, type CommandReceipt } from '@agentopsdeck/shared';
import { CommandCapacity, CommandConflict } from '../commands/receipts.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import type { SdkAgentId } from './sdk-execution-journal.js';
import { sdkModelChoices } from './sdk-models.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionEvidence, type ApplicationTransactionClient } from '../auth/application-transaction-gate.js';
import { applicationControlTransaction } from './application-stop-transaction.js';

export type SdkOwnerCatalogs = Partial<Record<SdkAgentId, { model: string; modelChoices?: readonly string[] }>>;
type Scope = { runtime: SdkAgentId; authorization: string; commandKey: string; payloadJson: string;
  /** Trusted caller observation can only veto new admission, never authorize. */
  rejectFresh?: 'runtime_unavailable'; application?: ApplicationTransactionEvidence };
type Result = { runtime: SdkAgentId; key: string | null; receipt: CommandReceipt };
type Failure = { error: 401 | 403 | 409 | 503 };
export type ConnectorSdkLocalCommands = {
  sdkSessionCreate: { input: Scope; output: Result | Failure };
  sdkModelUpdate: { input: Scope & { key: string }; output: Result | Failure };
};
export type ConnectorSdkLocalKind = keyof ConnectorSdkLocalCommands;
export const connectorSdkLocalSteps = Object.freeze({ sdkSessionCreate: 89, sdkModelUpdate: 90 });
export const SDK_LOCAL_PAYLOAD_BYTES = 128 * 1024;
export const isConnectorSdkLocalKind = (kind: string): kind is ConnectorSdkLocalKind => Object.hasOwn(connectorSdkLocalSteps, kind);
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => !!v
  && typeof v === 'object' && !Array.isArray(v) && required.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const runtime = (v: unknown): v is SdkAgentId => v === 'claude-code' || v === 'ghcp';
const key = (v: unknown, r?: unknown): v is string => typeof v === 'string' && v.length <= 512
  && !/[\u0000-\u001f\u007f]/.test(v) && runtime(sessionRuntimeId(v)) && v !== `${sessionRuntimeId(v)}:`
  && (r === undefined || sessionRuntimeId(v) === r);
const commandKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const title = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 120 && !/[\u0000-\u001f\u007f]/.test(v);

/** Trusted construction configuration, never a command-envelope authority or
 * caller-supplied catalog. Snapshot before the first admission await. */
export function copySdkOwnerCatalogs(value: unknown): SdkOwnerCatalogs {
  if (value === undefined) return {};
  if (!fields(value, [], ['claude-code', 'ghcp'])) throw Error('Invalid SDK owner catalogs');
  const result: SdkOwnerCatalogs = {};
  for (const r of ['claude-code', 'ghcp'] as const) {
    if (!Object.hasOwn(value, r)) continue;
    const c = value[r];
    if (!fields(c, ['model'], ['modelChoices']) || typeof c.model !== 'string'
      || c.modelChoices !== undefined && (!Array.isArray(c.modelChoices) || c.modelChoices.some(v => typeof v !== 'string'))) throw Error('Invalid SDK owner catalog');
    result[r] = { model: c.model, modelChoices: sdkModelChoices(c.model, c.modelChoices as string[] | undefined) };
  }
  return result;
}

// Preserve the original HTTP payload fingerprint, including ignored metadata
// and pre-trim strings. It is data only, not reflected methods/SQL/authority.
function payload(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || Buffer.byteLength(value) > SDK_LOCAL_PAYLOAD_BYTES) return null;
  try { const p: unknown = JSON.parse(value); return fields(p, [], Object.keys(p ?? {})) && !Object.hasOwn(p, 'idempotencyKey') ? p : null; }
  catch { return null; }
}
export function validConnectorSdkLocalInput(kind: ConnectorSdkLocalKind, v: unknown): boolean {
  return fields(v, ['runtime', 'authorization', 'commandKey', 'payloadJson', ...(kind === 'sdkModelUpdate' ? ['key'] : [])], ['rejectFresh', 'application'])
    && (!Object.hasOwn(v, 'application') || validApplicationTransactionEvidence(v.application))
    && (!Object.hasOwn(v, 'rejectFresh') || v.rejectFresh === 'runtime_unavailable')
    && runtime(v.runtime) && commandKey(v.commandKey) && typeof v.authorization === 'string' && !!v.authorization.trim()
    && Buffer.byteLength(v.authorization) <= 4096 && !/[\r\n\u0000]/.test(v.authorization) && payload(v.payloadJson) !== null
    && (kind !== 'sdkModelUpdate' || key(v.key, v.runtime));
}
export function validConnectorSdkLocalOutput(kind: ConnectorSdkLocalKind, v: unknown, allowLegacyTitle = false): boolean {
  if (fields(v, ['error'])) return [401, 403, 409, 503].includes(Number(v.error)) && typeof v.error === 'number';
  if (!fields(v, ['runtime', 'key', 'receipt']) || !runtime(v.runtime) || v.key !== null && !key(v.key, v.runtime)) return false;
  const r = v.receipt;
  if (!fields(r, ['id', 'key', 'state', 'createdAt', 'updatedAt'], ['result']) || typeof r.id !== 'string' || !r.id || r.id.length > 512
    || !commandKey(r.key) || !Number.isSafeInteger(r.createdAt) || Number(r.createdAt) < 0
    || !Number.isSafeInteger(r.updatedAt) || Number(r.updatedAt) < 0) return false;
  if (kind === 'sdkModelUpdate' && !key(v.key, v.runtime)) return false;
  if (r.state === 'outcome_unknown') return !Object.hasOwn(r, 'result') && (kind !== 'sdkSessionCreate' || v.key === null);
  if (!fields(r.result, ['status', 'body'])) return false;
  if (r.state === 'rejected') return typeof r.result.status === 'number' && [400, 403, 409].includes(r.result.status) && fields(r.result.body, ['error'])
    && r.result.body.error === 'Command rejected' && (kind !== 'sdkSessionCreate' || v.key === null);
  if (r.state !== 'accepted') return false;
  const b = r.result.body;
  if (kind === 'sdkSessionCreate') return r.result.status === 201 && fields(b, ['key', 'agentId', 'title'])
    && key(b.key, v.runtime) && b.key === v.key && b.agentId === v.runtime && title(b.title);
  if (r.result.status !== 200 || !fields(b, ['sessionKey', 'settings']) || b.sessionKey !== v.key) return false;
  // Settings and title share the historical receipt namespace. Recovery must
  // preserve an old title ACK, not turn it into unknown or fall through to a
  // second synchronous reader. This exception never admits a model-write ACK.
  if (allowLegacyTitle && fields(b.settings, ['title'])) return !!readSessionSettingsResult(b, v.key as string);
  return fields(b.settings, ['model', 'modelProvider']) && typeof b.settings.model === 'string'
    && b.settings.model.length > 0 && b.settings.model.length <= 256 && !/\s|[\u0000-\u001f\u007f]/.test(b.settings.model)
    && b.settings.modelProvider === null;
}
class LocalAuthorityDenied extends Error {}

/** Only local rollback-capable operations. There is no native effect here.
 * The original identity/settings and original receipt share one savepoint;
 * failure after COMMIT must be recovered from that receipt, never rerun. */
export async function executeConnectorSdkLocal<K extends ConnectorSdkLocalKind>(kind: K, request: ConnectorSdkLocalCommands[K]['input'],
  owner: ConnectorUserStore, tokens: ConnectorTokenStore | undefined, catalogs: SdkOwnerCatalogs,
  transactions?: ApplicationTransactionClient): Promise<ConnectorSdkLocalCommands[K]['output']> {
  if (!tokens || !validConnectorSdkLocalInput(kind, request)) throw Error('connector_storage_unavailable');
  const input = structuredClone(request), p = payload(input.payloadJson)!, catalog = catalogs[input.runtime];
  const actorId = tokens.authenticateAuthorization(input.authorization)?.tokenId;
  const allowed = () => {
    const actor = tokens.authenticateAuthorization(input.authorization);
    return !!actorId && !actorId.startsWith('actor_') && actor?.tokenId === actorId
      && actor.scopes.includes('sessions:create') && !actor.scopes.includes('execution:delegate');
  };
  const check = () => { if (!allowed()) throw new LocalAuthorityDenied(); };
  if (!actorId) return { error: 401 };
  if (!allowed()) return { error: 403 };
  if (!catalog) return { error: 503 };
  const journal = input.runtime === 'claude-code' ? owner.claudeJournal : owner.copilotJournal;
  const sessionKey = 'key' in input ? input.key : null;
  const scope = JSON.stringify([kind === 'sdkSessionCreate' ? 'create' : 'settings', JSON.stringify([actorId, sessionKey ?? input.runtime])]);
  const wrap = (receipt: CommandReceipt): Result => ({ runtime: input.runtime,
    key: sessionKey ?? (receipt.state === 'accepted' && typeof receipt.result?.body.key === 'string' ? receipt.result.body.key : null), receipt });
  const reject = (status: 400 | 403 | 409): Result => wrap(owner.commands.settle(scope, input.commandKey, { status, body: { error: 'SDK local command was not admitted' } }));
  let result: Result | Failure, mutationStarted = false, fresh = false;
  try {
    const control = applicationControlTransaction(input.runtime, { key: sessionKey ?? `${input.runtime}:create`,
      commandKey: input.commandKey, payloadJson: input.payloadJson,
      ...(Object.hasOwn(input, 'application') ? { application: input.application } : {}) }, transactions);
    const claimed = await owner.commands.claimAsync(scope, input.commandKey, p, false, undefined,
      kind === 'sdkModelUpdate' ? () => owner.sdkCommandAdmissionOpen && !!sessionKey && !owner.commands.sessionDeletion(sessionKey)
        && !owner.commands.sessionSettingsPending(sessionKey) && journal.canStart(sessionKey) && !owner.turns.hasPending(input.runtime, sessionKey) : undefined,
      undefined, kind === 'sdkModelUpdate', check, check, control?.claim);
    fresh = claimed.fresh;
    if (!claimed.fresh) result = wrap(claimed.receipt);
    else {
      const mutate = (): Result => {
      check();
      if (!owner.sdkCommandAdmissionOpen || input.rejectFresh === 'runtime_unavailable') return reject(409);
      else if (kind === 'sdkSessionCreate') {
        // Same legacy normalization and model restriction as the SDK HTTP route.
        let normalized: string;
        try { normalized = String(p.title ?? p.label ?? 'New chat').trim() || 'New chat'; }
        catch { normalized = ''; }
        if (!title(normalized)) return reject(400);
        else if (p.model && p.model !== catalog.model) return reject(409);
        else {
          const created = { key: `${input.runtime}:${randomUUID()}`, agentId: input.runtime, title: normalized };
          const commit = owner.commands.creationCommit(scope, input.commandKey, { status: 201, body: created });
          mutationStarted = true;
          journal.create({ key: created.key, nativeSessionId: randomUUID(), title: normalized, createdAt: Date.now() }, db => {
            check(); if (!owner.sdkCommandAdmissionOpen || owner.commands.sessionDeletion(created.key)) throw new LocalAuthorityDenied();
            commit(db);
          });
          return wrap(owner.commands.get(scope, input.commandKey)!);
        }
      } else {
        const model = p.model === null ? null : typeof p.model === 'string' ? p.model.trim() : undefined;
        if (model === undefined || model !== null && !sdkModelChoices(catalog.model, catalog.modelChoices).includes(model)
          || Object.hasOwn(p, 'thinking') && p.thinking !== null || Object.hasOwn(p, 'goal')) return reject(400);
        else if (!sessionKey || !journal.canStart(sessionKey) || owner.commands.sessionDeletion(sessionKey)
          || owner.turns.hasPending(input.runtime, sessionKey)) return reject(409);
        else {
          mutationStarted = true;
          journal.updateModel(sessionKey, model, () => {
            check(); if (!owner.sdkCommandAdmissionOpen || owner.commands.sessionDeletion(sessionKey)
              || owner.turns.hasPending(input.runtime, sessionKey)) throw new LocalAuthorityDenied();
            owner.commands.beginSettingsWrite(scope, input.commandKey);
            if (owner.commands.settle(scope, input.commandKey, { status: 200,
              body: { sessionKey, settings: { model: model ?? catalog.model, modelProvider: null } } }).state !== 'accepted') throw new CommandCapacity();
          });
          return wrap(owner.commands.get(scope, input.commandKey)!);
        }
      }
      };
      result = control ? await control.ready(mutate) : mutate();
    }
  } catch (error) {
    // A notification can throw after the original COMMIT. That is not denial.
    const saved = owner.commands.get(scope, input.commandKey);
    if (mutationStarted && saved?.state === 'accepted') result = wrap(saved);
    else if (error instanceof LocalAuthorityDenied) result = fresh && saved?.state === 'outcome_unknown' ? reject(403) : { error: 403 };
    else if (error instanceof CommandConflict) result = { error: 409 };
    else if (error instanceof CommandCapacity) result = { error: 503 };
    else throw error;
  }
  if (!validConnectorSdkLocalOutput(kind, result)) throw Error('connector_storage_unavailable');
  return result as ConnectorSdkLocalCommands[K]['output'];
}
