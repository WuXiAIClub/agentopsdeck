import { automationIdentity, readAutomationRule, validAutomationConfigurationReceipt, validAutomationConfigurationView,
  type AutomationConfiguration, type AutomationConfigurationReceipt, type AutomationConfigurationView } from '@agentopsdeck/shared';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { AutomationStoreConflict } from '../commands/automation-store.js';
import type { AutomationTarget } from '../commands/automation-policy.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { createTurnAuthorizer } from './execution-grants.js';

type Authority = { ownerId: string; connectionId: string };
type Evidence = { authorization: string };
export type AutomationResult<T> = { ok: true; value: T } | { ok: false; error: 401 | 403 | 404 | 409 | 503 };
export type ConnectorAutomationCommands = {
  automationAuthority: { input: Evidence; output: AutomationResult<Authority> };
  automationConfigurationView: { input: Evidence; output: AutomationResult<AutomationConfigurationView> };
  automationConfigurationOriginal: { input: Evidence & { requestId: string }; output: AutomationResult<AutomationConfigurationReceipt | null> };
  automationConfigure: { input: Evidence & { requestId: string; configuration: AutomationConfiguration }; output: AutomationResult<AutomationConfigurationReceipt> };
};
export type ConnectorAutomationKind = keyof ConnectorAutomationCommands;
// Append-only diagnostic protocol. No dispatch/resend/HTTP completion command.
export const connectorAutomationSteps = Object.freeze({ automationAuthority: 272, automationConfigurationView: 273,
  automationConfigurationOriginal: 274, automationConfigure: 275 });
export const isConnectorAutomationKind = (kind: string): kind is ConnectorAutomationKind => Object.hasOwn(connectorAutomationSteps, kind);
const fields = (v: unknown, keys: string[]): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
  && keys.length === Object.keys(v).length && keys.every(k => Object.hasOwn(v, k));
export function validAutomationConfigurationInput(v: unknown): v is AutomationConfiguration {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const value = v as Record<string, unknown>;
  if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) return false;
  return value.kind === 'save' ? fields(value, ['kind', 'rule', 'template', 'expectedRevision', 'confirmEnable'])
    && !!readAutomationRule(value.rule) && typeof value.confirmEnable === 'boolean'
    && typeof value.template === 'string' && !!value.template.trim() && value.template.length <= 8192
    && Buffer.byteLength(value.template) <= 32768 && !value.template.includes('\0')
    : value.kind === 'revoke' && fields(value, ['kind', 'ruleId', 'expectedRevision']) && automationIdentity(value.ruleId);
}
export function validConnectorAutomationInput(kind: ConnectorAutomationKind, v: unknown): boolean {
  return fields(v, ['authorization', ...(['automationConfigurationOriginal', 'automationConfigure'].includes(kind) ? ['requestId'] : []),
    ...(kind === 'automationConfigure' ? ['configuration'] : [])])
    && typeof v.authorization === 'string' && v.authorization.length <= 4096 && !/[\x00-\x1f\x7f]/.test(v.authorization)
    && (!('requestId' in v) || automationIdentity(v.requestId))
    && (kind !== 'automationConfigure' || validAutomationConfigurationInput(v.configuration));
}
export function validConnectorAutomationOutput(kind: ConnectorAutomationKind, v: unknown): boolean {
  if (fields(v, ['ok', 'error'])) return v.ok === false && [401, 403, 404, 409, 503].includes(v.error);
  if (!fields(v, ['ok', 'value']) || v.ok !== true) return false;
  if (kind === 'automationAuthority') return fields(v.value, ['ownerId', 'connectionId'])
    && automationIdentity(v.value.ownerId) && automationIdentity(v.value.connectionId);
  if (kind === 'automationConfigurationView') return fields(v.value, ['ownerId', 'connectionId', 'rules'])
    && validAutomationConfigurationView(v.value) && v.value.rules.every((r: any) => r.rule.target.runtime === 'codex');
  return kind === 'automationConfigurationOriginal' && v.value === null
    || fields(v.value, ['requestId', 'fingerprint', 'result']) && validAutomationConfigurationReceipt(v.value)
      && v.value.result.rule.target.runtime === 'codex';
}
class Reject extends Error {
  constructor(readonly status: 401 | 403 | 404 | 409 | 503) { super('Automation unavailable'); }
}
/** Only this physical DB owner derives the principal from raw credentials.
 * A local/native observation is never a substitute for current authority.
 * Persistence is lazy: opening a disabled runtime creates no automation schema. */
export function createConnectorAutomationCommands(owner: ConnectorUserStore, tokens?: ConnectorTokenStore) {
  const authorize = createTurnAuthorizer(owner.executionGrants, (actor, scope) => tokens?.hasScope(actor, scope) === true);
  const targetAllowed = (actor: string, target: AutomationTarget) => target.ownerId === actor
    && target.connectionId === owner.nodeId && target.runtime === 'codex' && target.sessionId.startsWith('codex:')
    && target.sessionId.length > 6 && tokens?.hasScope(actor, 'automation:manage') === true
    && authorize(actor, { runtime: 'codex', sessionKey: target.sessionId }, 'messages:send') && !owner.commands.sessionDeletion(target.sessionId)
    && !owner.codexExecutions.isDeletedTerminal(target.sessionId);
  let persistence: ReturnType<ConnectorUserStore['createAutomationPersistence']> | undefined;
  const db = () => persistence ??= owner.createAutomationPersistence(targetAllowed);
  const principal = (authorization: string): Authority => {
    const p = tokens?.authenticateAuthorization(authorization);
    if (!p) throw new Reject(401);
    if (!p.scopes.includes('automation:manage') || !p.scopes.includes('messages:send')) throw new Reject(403);
    return { ownerId: p.tokenId, connectionId: owner.nodeId };
  };
  return <K extends ConnectorAutomationKind>(kind: K, input: ConnectorAutomationCommands[K]['input']): ConnectorAutomationCommands[K]['output'] => {
    if (!validConnectorAutomationInput(kind, input)) throw Error('connector_storage_unavailable');
    let result: unknown;
    try {
      const identity = principal(input.authorization), v = input as ConnectorAutomationCommands['automationConfigure']['input'];
      let value: unknown;
      if (kind === 'automationAuthority') value = identity;
      else if (kind === 'automationConfigurationView') value = { ...identity, rules: db().store.list(identity.ownerId) };
      else if (kind === 'automationConfigurationOriginal') {
        const receipt = db().config.original(identity.ownerId, v.requestId);
        if (receipt && !targetAllowed(identity.ownerId, receipt.result.rule.target)) throw new Reject(403);
        value = receipt ?? null;
      } else {
        if (!owner.sdkCommandAdmissionOpen) throw new Reject(409);
        value = db().config.configure(identity.ownerId, v.requestId, v.configuration);
      }
      // Also fence reads and committed replies: never hand a stale credential
      // another owner's rule/template. A failed delivery doesn't undo commit.
      const current = principal(input.authorization);
      if (current.ownerId !== identity.ownerId) throw new Reject(403);
      result = { ok: true, value };
    } catch (error) {
      if (error instanceof Reject) result = { ok: false, error: error.status };
      else if (error instanceof AutomationStoreConflict) result = { ok: false, error: error.message === 'forbidden' ? 403 : 409 };
      else throw error;
    }
    if (!validConnectorAutomationOutput(kind, result)) throw Error('connector_storage_unavailable');
    return result as ConnectorAutomationCommands[K]['output'];
  };
}
