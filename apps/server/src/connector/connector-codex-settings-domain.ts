import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readGoalControl, readSessionSettingsResult, type GoalControl, type CommandReceipt, type SessionSettingsResult } from '@agentopsdeck/shared';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { CommandCapacity, CommandConflict } from '../commands/receipts.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionEvidence, type ApplicationTransactionClient } from '../auth/application-transaction-gate.js';
import { applicationControlTransaction } from './application-stop-transaction.js';

export type CodexSettingsChange = { kind: 'title'; title: string } | { kind: 'model'; model: string | null; thinking?: string | null }
  | { kind: 'goal'; control: GoalControl };
type Scope = { authorization: string; key: string };
export type CodexSettingsIntent = { id: string; receiptId: string; key: string; commandKey: string; change: CodexSettingsChange };
type Ref = { intent: CodexSettingsIntent };
export type CodexSettingsResult = { commandKey: string; receipt: CommandReceipt | null; intent: CodexSettingsIntent | null };
export type ConnectorCodexSettingsCommands = {
  codexSettingsAuthorize: { input: Scope & { readerId?: string }; output: { readerId: string } | { error: 403 | 409 } };
  codexSettingsClaim: { input: Scope & { commandKey: string; payloadJson: string; rejectFresh?: 'runtime_unavailable'; application?: ApplicationTransactionEvidence }; output: CodexSettingsResult | { error: 403 | 409 | 503 } };
  codexSettingsReceipt: { input: Scope & { commandKey: string }; output: CodexSettingsResult | { error: 403 } };
  codexSettingsBegin: { input: Ref & { authorization: string }; output: boolean };
  codexSettingsAccept: { input: Ref & { settings: SessionSettingsResult['settings'] }; output: CodexSettingsResult | false };
  codexSettingsAbandon: { input: Ref & { reason?: 'session_missing' }; output: CodexSettingsResult | false };
};
export type ConnectorCodexSettingsKind = keyof ConnectorCodexSettingsCommands;
export const connectorCodexSettingsSteps = Object.freeze({ codexSettingsAuthorize: 290, codexSettingsClaim: 291,
  codexSettingsReceipt: 292, codexSettingsBegin: 293, codexSettingsAccept: 294, codexSettingsAbandon: 295 });
export const isConnectorCodexSettingsKind = (v: string): v is ConnectorCodexSettingsKind => Object.hasOwn(connectorCodexSettingsSteps, v);
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const text = (v: unknown, max = 512): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= max && !/[\x00-\x1f\x7f]/.test(v);
const key = (v: unknown): v is string => text(v) && v.startsWith('codex:') && v.length > 6;
const commandKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const authorization = (v: unknown): v is string => typeof v === 'string' && Buffer.byteLength(v) <= 4096 && !/[\x00-\x1f\x7f]/.test(v);
function payload(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'string' || Buffer.byteLength(v) > 128 * 1024) return null;
  try { const p: unknown = JSON.parse(v); return p && typeof p === 'object' && !Array.isArray(p) && !Object.hasOwn(p, 'idempotencyKey') ? p as Record<string, unknown> : null; }
  catch { return null; }
}
/** Preserve legacy ignored metadata and original fingerprint; only normalize the
 * selected effect, with the same goal > model > title precedence as HTTP. */
export function codexSettingsChange(p: Record<string, unknown>): CodexSettingsChange | null {
  if (Object.hasOwn(p, 'goal')) { const control = readGoalControl(p.goal); return Object.keys(p).length === 1 && control ? { kind: 'goal', control } : null; }
  if (!Object.hasOwn(p, 'model')) return typeof p.title === 'string' && !!p.title.trim() && p.title.trim().length <= 120 ? { kind: 'title', title: p.title.trim() } : null;
  const model = p.model === null ? null : typeof p.model === 'string' ? p.model.trim() : undefined;
  const thinking = p.thinking === null ? null : typeof p.thinking === 'string' ? p.thinking.trim() : undefined;
  return model === undefined || model === '' || (model?.length ?? 0) > 4096
    || Object.hasOwn(p, 'thinking') && (thinking === undefined || thinking === '' || (thinking?.length ?? 0) > 4096) ? null
    : { kind: 'model', model, ...(thinking !== undefined ? { thinking } : {}) };
}
function validChange(v: unknown): v is CodexSettingsChange {
  if (!v || typeof v !== 'object') return false;
  const c = v as CodexSettingsChange;
  return c.kind === 'title' ? fields(c, ['kind', 'title']) && typeof c.title === 'string' && !!c.title.trim() && c.title === c.title.trim() && c.title.length <= 120
    : c.kind === 'goal' ? fields(c, ['kind', 'control']) && !!readGoalControl(c.control)
      : c.kind === 'model' && fields(c, ['kind', 'model'], ['thinking']) && (c.model === null || typeof c.model === 'string' && !!c.model.trim() && c.model.length <= 4096)
        && (!Object.hasOwn(c, 'thinking') || c.thinking === null || typeof c.thinking === 'string' && !!c.thinking.trim() && c.thinking.length <= 4096);
}
const intent = (v: unknown): v is CodexSettingsIntent => fields(v, ['id', 'receiptId', 'key', 'commandKey', 'change'])
  && text(v.id) && text(v.receiptId) && key(v.key) && commandKey(v.commandKey) && validChange(v.change);
function receipt(v: unknown): v is CommandReceipt {
  if (!fields(v, ['id', 'key', 'state', 'createdAt', 'updatedAt'], ['result']) || !text(v.id) || !commandKey(v.key)
    || !Number.isSafeInteger(v.createdAt) || Number(v.createdAt) < 0 || !Number.isSafeInteger(v.updatedAt) || Number(v.updatedAt) < 0) return false;
  return v.state === 'outcome_unknown' ? !Object.hasOwn(v, 'result') : fields(v.result, ['status', 'body']) && (v.state === 'accepted'
    ? v.result.status === 200 && !!v.result.body && typeof v.result.body === 'object' && key((v.result.body as any).sessionKey)
      && !!readSessionSettingsResult(v.result.body, (v.result.body as any).sessionKey)
    : v.state === 'rejected' && Number.isInteger(v.result.status) && Number(v.result.status) >= 400 && Number(v.result.status) < 500
      && fields(v.result.body, ['error']) && v.result.body.error === 'Command rejected');
}
function result(v: unknown): v is CodexSettingsResult {
  return fields(v, ['commandKey', 'receipt', 'intent']) && commandKey(v.commandKey) && (v.receipt === null || receipt(v.receipt) && v.receipt.key === v.commandKey)
    && (v.intent === null || intent(v.intent) && v.intent.commandKey === v.commandKey && v.intent.receiptId === (v.receipt as CommandReceipt)?.id && (v.receipt as CommandReceipt)?.state === 'outcome_unknown');
}
export function validConnectorCodexSettingsInput(k: ConnectorCodexSettingsKind, v: unknown): boolean {
  if (k === 'codexSettingsAuthorize') return fields(v, ['authorization', 'key'], ['readerId']) && authorization(v.authorization) && key(v.key)
    && (!Object.hasOwn(v, 'readerId') || text(v.readerId));
  if (k === 'codexSettingsClaim' || k === 'codexSettingsReceipt') return fields(v, ['authorization', 'key', 'commandKey', ...(k === 'codexSettingsClaim' ? ['payloadJson'] : [])], k === 'codexSettingsClaim' ? ['rejectFresh', 'application'] : [])
    && (!Object.hasOwn(v, 'application') || validApplicationTransactionEvidence(v.application))
    && authorization(v.authorization) && key(v.key) && commandKey(v.commandKey) && (k !== 'codexSettingsClaim' || payload(v.payloadJson) !== null)
    && (!Object.hasOwn(v, 'rejectFresh') || v.rejectFresh === 'runtime_unavailable');
  return fields(v, ['intent', ...(k === 'codexSettingsBegin' ? ['authorization'] : k === 'codexSettingsAccept' ? ['settings'] : [])], k === 'codexSettingsAbandon' ? ['reason'] : []) && intent(v.intent)
    && (!Object.hasOwn(v, 'reason') || v.reason === 'session_missing')
    && (k !== 'codexSettingsBegin' || authorization(v.authorization)) && (k !== 'codexSettingsAccept' || !!readSessionSettingsResult({ sessionKey: v.intent.key, settings: v.settings }, v.intent.key));
}
export function validConnectorCodexSettingsOutput(k: ConnectorCodexSettingsKind, v: unknown): boolean {
  if (k === 'codexSettingsBegin') return typeof v === 'boolean';
  if (k === 'codexSettingsAuthorize') return fields(v, ['readerId']) && text(v.readerId) || fields(v, ['error']) && [403, 409].includes(v.error as number);
  if (fields(v, ['error'])) return (k === 'codexSettingsClaim' ? [403, 409, 503] : k === 'codexSettingsReceipt' ? [403] : []).includes(v.error as number);
  return (k === 'codexSettingsAccept' || k === 'codexSettingsAbandon') && v === false || result(v);
}
type Binding = { intent: CodexSettingsIntent; scope: string; actor: string; dispatched: boolean;
  control?: NonNullable<ReturnType<typeof applicationControlTransaction>> };
class Denied extends Error {}
export function createConnectorCodexSettings(owner: ConnectorUserStore, tokens?: ConnectorTokenStore, transactions?: ApplicationTransactionClient) {
  const bindings = new Map<string, Binding>(); let disposed = false;
  const actor = (auth: string, expected?: string) => { const p = tokens?.authenticateAuthorization(auth);
    return p && (!expected || p.tokenId === expected) && p.scopes.includes('sessions:create') && !p.scopes.includes('execution:delegate') ? p.tokenId : undefined; };
  const execute = async <K extends ConnectorCodexSettingsKind>(kind: K, input: ConnectorCodexSettingsCommands[K]['input']): Promise<ConnectorCodexSettingsCommands[K]['output']> => {
    if (disposed || !validConnectorCodexSettingsInput(kind, input)) throw Error('connector_storage_unavailable');
    const v = structuredClone(input); let value: unknown;
    if (kind === 'codexSettingsAuthorize') {
      const p = v as ConnectorCodexSettingsCommands['codexSettingsAuthorize']['input'], id = actor(p.authorization, p.readerId);
      value = !id ? { error: 403 } : owner.commands.sessionDeletion(p.key) ? { error: 409 } : { readerId: id };
    } else if (kind === 'codexSettingsClaim' || kind === 'codexSettingsReceipt') {
      const p = v as ConnectorCodexSettingsCommands['codexSettingsClaim']['input'], id = actor(p.authorization);
      if (!id) value = { error: 403 };
      else {
        const scope = JSON.stringify(['settings', JSON.stringify([id, p.key])]);
        const current = (): CodexSettingsResult => ({ commandKey: p.commandKey, receipt: owner.commands.get(scope, p.commandKey) ?? null, intent: null });
        if (kind === 'codexSettingsReceipt') value = current();
        else {
          let bound: Binding | undefined;
          const control = applicationControlTransaction('codex', p, transactions);
          const check = () => { if (!actor(p.authorization, id)) throw new Denied(); };
          try {
            const raw = payload(p.payloadJson)!, change = codexSettingsChange(raw);
            const claimed = await owner.commands.claimAsync(scope, p.commandKey, raw, false, undefined,
              () => owner.sdkCommandAdmissionOpen && bindings.size < 128 && !owner.commands.sessionDeletion(p.key)
                && !owner.commands.sessionSettingsPending(p.key) && owner.canChangeSettings(p.key) && !p.rejectFresh,
              receiptId => { check(); if (!change) return { metadata: { runtime: 'codex-settings' }, complete: { status: 400, body: { error: 'Invalid settings' } } };
                bound = { scope, actor: id, dispatched: false, intent: { id: randomUUID(), receiptId, key: p.key, commandKey: p.commandKey, change },
                  ...(control ? { control } : {}) };
                return { metadata: { runtime: 'codex-settings' } }; }, true, check, check, control?.claim);
            if (claimed.fresh && bound && claimed.receipt.state === 'outcome_unknown') bindings.set(bound.intent.id, bound);
            value = { commandKey: p.commandKey, receipt: claimed.receipt, intent: claimed.fresh && bound && claimed.receipt.state === 'outcome_unknown' ? bound.intent : null };
          } catch (e) { if (e instanceof Denied) value = { error: 403 }; else if (e instanceof CommandCapacity) value = { error: 503 };
            else if (e instanceof CommandConflict) value = { error: 409 }; else throw e; }
        }
      }
    } else {
      const p = v as Ref & { authorization?: string; settings?: SessionSettingsResult['settings']; reason?: 'session_missing' }, b = bindings.get(p.intent.id);
      const original = b && owner.commands.get(b.scope, b.intent.commandKey);
      if (!b || !isDeepStrictEqual(b.intent, p.intent) || original?.id !== b.intent.receiptId || original.state !== 'outcome_unknown') value = false;
      else if (kind === 'codexSettingsBegin') {
        const begin = () => {
          const current = owner.commands.get(b.scope, b.intent.commandKey);
          if (disposed || bindings.get(b.intent.id) !== b || current?.id !== b.intent.receiptId || current.state !== 'outcome_unknown'
            || b.dispatched || !owner.sdkCommandAdmissionOpen || !actor(p.authorization!, b.actor) || owner.commands.sessionDeletion(b.intent.key)
            || !owner.canChangeSettings(b.intent.key)) return false;
          owner.commands.beginSettingsWrite(b.scope, b.intent.commandKey); b.dispatched = true; return true;
        };
        value = b.control ? await b.control.ready(begin) : begin();
      } else {
        const change = b.intent.change, settings = p.settings;
        if (kind === 'codexSettingsAccept') {
          const matches = settings && (change.kind === 'title' ? Object.keys(settings).length === 1 && settings.title === change.title
            : change.kind === 'goal' ? Object.keys(settings).length === 1 && settings.goalControl === change.control.action
              : Object.keys(settings).every(k => ['model', 'modelProvider', 'thinkingLevel'].includes(k)) && Object.hasOwn(settings, 'model') && Object.hasOwn(settings, 'modelProvider')
                && (change.model === null || settings.model === change.model) && (change.thinking === undefined ? !Object.hasOwn(settings, 'thinkingLevel') : settings.thinkingLevel === change.thinking));
          if (!b.dispatched || !matches) value = false;
          else { const accepted = owner.commands.settle(b.scope, b.intent.commandKey, { status: 200, body: { sessionKey: b.intent.key, settings } });
            if (accepted.state !== 'accepted') throw new CommandCapacity('Settings acceptance unavailable');
            bindings.delete(b.intent.id); value = { commandKey: b.intent.commandKey, receipt: accepted, intent: null }; }
        } else {
          // After any possible write, abandon is observation only; keep the
          // original capability for an original-connection late ACK.
          const r = b.dispatched ? original : owner.commands.settle(b.scope, b.intent.commandKey,
            { status: p.reason === 'session_missing' ? 404 : 409, body: { error: 'Settings preflight failed' } });
          if (!b.dispatched) bindings.delete(b.intent.id);
          value = { commandKey: b.intent.commandKey, receipt: r, intent: null };
        }
      }
    }
    if (!validConnectorCodexSettingsOutput(kind, value)) throw Error('connector_storage_unavailable');
    return value as ConnectorCodexSettingsCommands[K]['output'];
  };
  return Object.assign(execute, { dispose() { disposed = true; bindings.clear(); } });
}
