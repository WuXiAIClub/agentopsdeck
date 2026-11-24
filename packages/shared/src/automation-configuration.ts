import { readAutomationRule, type AutomationRule } from './automation-policy.js';

export type StoredAutomationRule = { rule: AutomationRule; template: string; templateHash: string; revoked: boolean };
export type AutomationConfiguration =
  | { kind: 'save'; rule: AutomationRule; template: string; expectedRevision: number; confirmEnable: boolean }
  | { kind: 'revoke'; ruleId: string; expectedRevision: number };
export type AutomationConfigurationReceipt = { requestId: string; fingerprint: string; result: StoredAutomationRule };
export type AutomationConfigurationView = { ownerId: string; connectionId: string; rules: StoredAutomationRule[] };
export const automationIdentity = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function validStoredAutomationRule(value: unknown): value is StoredAutomationRule {
  return object(value) && !!readAutomationRule(value.rule) && typeof value.template === 'string'
    && !!value.template.trim() && value.template.length <= 8192 && !value.template.includes('\0')
    && typeof value.templateHash === 'string' && /^[a-f0-9]{64}$/.test(value.templateHash)
    && typeof value.revoked === 'boolean' && (!value.revoked || (value.rule as AutomationRule).enabled === false);
}
export function validAutomationConfigurationView(value: unknown): value is AutomationConfigurationView {
  if (!object(value) || !automationIdentity(value.ownerId) || !automationIdentity(value.connectionId)
    || !Array.isArray(value.rules) || value.rules.length > 1000) return false;
  const ids = new Set<string>();
  return value.rules.every(rule => validStoredAutomationRule(rule) && rule.rule.target.ownerId === value.ownerId
    && rule.rule.target.connectionId === value.connectionId && !ids.has(rule.rule.id) && !!ids.add(rule.rule.id));
}
export function validAutomationConfigurationReceipt(value: unknown): value is AutomationConfigurationReceipt {
  return object(value) && automationIdentity(value.requestId) && typeof value.fingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(value.fingerprint) && validStoredAutomationRule(value.result);
}
