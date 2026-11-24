import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readSessionSettingsResult, sessionRuntimeId, type CommandReceipt } from '@agentopsdeck/shared';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionClient, type ApplicationTransactionEvidence } from '../auth/application-transaction-gate.js';
import { CommandCapacity, CommandConflict } from '../commands/receipts.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { applicationControlTransaction } from './application-stop-transaction.js';

export type TitleRuntime = 'openclaw' | 'hermes' | 'claude-code' | 'ghcp';
export const titleRuntime = (v: string): v is TitleRuntime => ['openclaw', 'hermes', 'claude-code', 'ghcp'].includes(v);
type Scope = { authorization: string; key: string };
export type TitleIntent = { id: string; receiptId: string; key: string; commandKey: string; title: string };
export type TitleResult = { commandKey: string; receipt: CommandReceipt | null; intent: TitleIntent | null };
export type ConnectorTitleCommands = {
  titleClaim: { input: Scope & { commandKey: string; payloadJson: string; rejectFresh?: 'runtime_unavailable'; application?: ApplicationTransactionEvidence }; output: TitleResult | { error: 403 | 409 | 503 } };
  titleReceipt: { input: Scope & { commandKey: string }; output: TitleResult | { error: 403 } };
  titleBegin: { input: { intent: TitleIntent; authorization: string }; output: boolean };
  titleAccept: { input: { intent: TitleIntent; title: string }; output: TitleResult | false };
  titleAbandon: { input: { intent: TitleIntent; reason?: 'session_missing' }; output: TitleResult | false };
};
export type ConnectorTitleKind = keyof ConnectorTitleCommands;
export const connectorTitleSteps = Object.freeze({ titleClaim: 361, titleReceipt: 362, titleBegin: 363, titleAccept: 364, titleAbandon: 365 });
export const isConnectorTitleKind = (v: string): v is ConnectorTitleKind => Object.hasOwn(connectorTitleSteps, v);
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const text = (v: unknown, max = 512): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= max && !/[\x00-\x1f\x7f]/.test(v);
const key = (v: unknown): v is string => text(v) && titleRuntime(sessionRuntimeId(v)) && v.includes(':') && !v.endsWith(':');
const commandKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const authorization = (v: unknown): v is string => typeof v === 'string' && Buffer.byteLength(v) <= 4096 && !/[\x00-\x1f\x7f]/.test(v);
const title = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v === v.trim() && v.length <= 120;
function payload(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'string' || Buffer.byteLength(v) > 128 * 1024) return null;
  try { const p: unknown = JSON.parse(v); return p && typeof p === 'object' && !Array.isArray(p) && !Object.hasOwn(p, 'idempotencyKey') ? p as Record<string, unknown> : null; }
  catch { return null; }
}
const intent = (v: unknown): v is TitleIntent => fields(v, ['id', 'receiptId', 'key', 'commandKey', 'title'])
  && text(v.id) && text(v.receiptId) && key(v.key) && commandKey(v.commandKey) && title(v.title);
function receipt(v: unknown): v is CommandReceipt {
  if (!fields(v, ['id', 'key', 'state', 'createdAt', 'updatedAt'], ['result']) || !text(v.id) || !commandKey(v.key)
    || !Number.isSafeInteger(v.createdAt) || Number(v.createdAt) < 0 || !Number.isSafeInteger(v.updatedAt) || Number(v.updatedAt) < 0) return false;
  if (v.state === 'outcome_unknown') return !Object.hasOwn(v, 'result');
  if (!fields(v.result, ['status', 'body'])) return false;
  if (v.state === 'accepted') return v.result.status === 200 && fields(v.result.body, ['sessionKey', 'settings']) && key(v.result.body.sessionKey)
    && !!readSessionSettingsResult(v.result.body, v.result.body.sessionKey);
  return v.state === 'rejected' && Number.isInteger(v.result.status) && Number(v.result.status) >= 400 && Number(v.result.status) < 500
    && fields(v.result.body, ['error']) && v.result.body.error === 'Command rejected';
}
function result(v: unknown): v is TitleResult {
  return fields(v, ['commandKey', 'receipt', 'intent']) && commandKey(v.commandKey) && (v.receipt === null || receipt(v.receipt) && v.receipt.key === v.commandKey)
    && (v.intent === null || intent(v.intent) && v.intent.commandKey === v.commandKey && v.intent.receiptId === (v.receipt as CommandReceipt)?.id && (v.receipt as CommandReceipt)?.state === 'outcome_unknown');
}
export function validConnectorTitleInput(k: ConnectorTitleKind, v: unknown): boolean {
  if (k === 'titleClaim' || k === 'titleReceipt') return fields(v, ['authorization', 'key', 'commandKey', ...(k === 'titleClaim' ? ['payloadJson'] : [])], k === 'titleClaim' ? ['application', 'rejectFresh'] : [])
    && authorization(v.authorization) && key(v.key) && commandKey(v.commandKey) && (k !== 'titleClaim' || payload(v.payloadJson) !== null)
    && (!Object.hasOwn(v, 'application') || validApplicationTransactionEvidence(v.application)) && (!Object.hasOwn(v, 'rejectFresh') || v.rejectFresh === 'runtime_unavailable');
  return fields(v, ['intent', ...(k === 'titleBegin' ? ['authorization'] : k === 'titleAccept' ? ['title'] : [])], k === 'titleAbandon' ? ['reason'] : []) && intent(v.intent)
    && (k !== 'titleBegin' || authorization(v.authorization)) && (k !== 'titleAccept' || title(v.title)) && (!Object.hasOwn(v, 'reason') || v.reason === 'session_missing');
}
export function validConnectorTitleOutput(k: ConnectorTitleKind, v: unknown): boolean {
  if (k === 'titleBegin') return typeof v === 'boolean';
  if (fields(v, ['error'])) return (k === 'titleClaim' ? [403, 409, 503] : k === 'titleReceipt' ? [403] : []).includes(v.error as number);
  return (k === 'titleAccept' || k === 'titleAbandon') && v === false || result(v);
}
type Binding = { intent: TitleIntent; scope: string; actor: string; dispatched: boolean; control?: NonNullable<ReturnType<typeof applicationControlTransaction>> };
class Denied extends Error {}
/** Fixed title effects only. No SQL/callback RPC, no caller actor, no native
 * writer. The original Auth transaction evidence stays worker-private at Ready. */
export function createConnectorTitle(owner: ConnectorUserStore, tokens?: ConnectorTokenStore, transactions?: ApplicationTransactionClient) {
  const bindings = new Map<string, Binding>(); let disposed = false;
  const actor = (auth: string, expected?: string) => { const p = tokens?.authenticateAuthorization(auth);
    return p && !p.tokenId.startsWith('actor_') && (!expected || p.tokenId === expected) && p.scopes.includes('sessions:create') && !p.scopes.includes('execution:delegate') ? p.tokenId : undefined; };
  const execute = async <K extends ConnectorTitleKind>(kind: K, input: ConnectorTitleCommands[K]['input']): Promise<ConnectorTitleCommands[K]['output']> => {
    if (disposed || !validConnectorTitleInput(kind, input)) throw Error('connector_storage_unavailable');
    const v = structuredClone(input); let value: unknown;
    if (kind === 'titleClaim' || kind === 'titleReceipt') {
      const p = v as ConnectorTitleCommands['titleClaim']['input'], id = actor(p.authorization);
      if (!id) value = { error: 403 };
      else {
        const scope = JSON.stringify(['settings', JSON.stringify([id, p.key])]);
        if (kind === 'titleReceipt') value = { commandKey: p.commandKey, receipt: owner.commands.get(scope, p.commandKey) ?? null, intent: null };
        else {
          const control = applicationControlTransaction(sessionRuntimeId(p.key), p, transactions);
          const check = () => { if (!actor(p.authorization, id)) throw new Denied(); };
          let bound: Binding | undefined;
          try {
            const raw = payload(p.payloadJson)!;
            const claimed = await owner.commands.claimAsync(scope, p.commandKey, raw, false, undefined,
              () => !disposed && owner.sdkCommandAdmissionOpen && bindings.size < 128 && !owner.commands.sessionDeletion(p.key)
                && !owner.commands.sessionSettingsPending(p.key) && owner.canChangeSettings(p.key) && !p.rejectFresh,
              receiptId => { check();
                if (Object.hasOwn(raw, 'goal') || Object.hasOwn(raw, 'model') || typeof raw.title !== 'string' || !title(raw.title.trim()))
                  return { metadata: { runtime: 'session-title' }, complete: { status: 400, body: { error: 'Invalid title settings' } } };
                bound = { scope, actor: id, dispatched: false, intent: { id: randomUUID(), receiptId, key: p.key, commandKey: p.commandKey, title: raw.title.trim() }, ...(control ? { control } : {}) };
                return { metadata: { runtime: 'session-title' } };
              }, true, check, check, control?.claim);
            if (claimed.fresh && bound && claimed.receipt.state === 'outcome_unknown') bindings.set(bound.intent.id, bound);
            value = { commandKey: p.commandKey, receipt: claimed.receipt, intent: claimed.fresh && bound && claimed.receipt.state === 'outcome_unknown' ? bound.intent : null };
          } catch (e) { if (e instanceof Denied) value = { error: 403 }; else if (e instanceof CommandCapacity) value = { error: 503 };
            else if (e instanceof CommandConflict) value = { error: 409 }; else throw e; }
        }
      }
    } else {
      const p = v as { intent: TitleIntent; authorization?: string; title?: string; reason?: 'session_missing' }, b = bindings.get(p.intent.id);
      const original = b && owner.commands.get(b.scope, b.intent.commandKey);
      if (!b || !isDeepStrictEqual(b.intent, p.intent) || original?.id !== b.intent.receiptId || original.state !== 'outcome_unknown') value = false;
      else if (kind === 'titleBegin') {
        const begin = () => {
          const current = owner.commands.get(b.scope, b.intent.commandKey);
          if (disposed || bindings.get(b.intent.id) !== b || current?.id !== b.intent.receiptId || current.state !== 'outcome_unknown' || b.dispatched
            || !owner.sdkCommandAdmissionOpen || !actor(p.authorization!, b.actor) || owner.commands.sessionDeletion(b.intent.key) || !owner.canChangeSettings(b.intent.key)) return false;
          owner.commands.beginSettingsWrite(b.scope, b.intent.commandKey); b.dispatched = true; return true;
        };
        value = b.control ? await b.control.ready(begin) : begin();
      } else if (kind === 'titleAccept') {
        if (!b.dispatched || p.title !== b.intent.title) value = false;
        else {
          const accepted = owner.commands.settle(b.scope, b.intent.commandKey, { status: 200, body: { sessionKey: b.intent.key, settings: { title: p.title } } });
          if (accepted.state !== 'accepted') throw new CommandCapacity('Title acceptance unavailable');
          bindings.delete(b.intent.id); value = { commandKey: b.intent.commandKey, receipt: accepted, intent: null };
        }
      } else {
        const r = b.dispatched ? original : owner.commands.settle(b.scope, b.intent.commandKey,
          { status: p.reason === 'session_missing' ? 404 : 409, body: { error: 'Title preflight failed' } });
        if (!b.dispatched) bindings.delete(b.intent.id);
        value = { commandKey: b.intent.commandKey, receipt: r, intent: null };
      }
    }
    if (!validConnectorTitleOutput(kind, value)) throw Error('connector_storage_unavailable');
    return value as ConnectorTitleCommands[K]['output'];
  };
  return Object.assign(execute, { dispose() { disposed = true; bindings.clear(); } });
}
