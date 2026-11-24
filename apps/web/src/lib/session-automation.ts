import { readAutomationRule, validAutomationConfigurationView, validAutomationConfigurationReceipt,
  type AutomationConfigurationView, type AutomationConfiguration, type AutomationConfigurationReceipt, type StoredAutomationRule } from '@agentopsdeck/shared';
export type AutomationView = AutomationConfigurationView & { sessionId: string };
export function validAutomationView(value: unknown): value is AutomationView {
  return validAutomationConfigurationView(value) && 'sessionId' in value
    && typeof value.sessionId === 'string' && value.sessionId.startsWith('codex:')
    && value.rules.every(s => s.rule.target.sessionId === value.sessionId && s.rule.target.runtime === 'codex');
}
export function scopedAutomationReceipt(value: unknown, id: string, view: AutomationView): value is AutomationConfigurationReceipt {
  if (!validAutomationConfigurationReceipt(value) || value.requestId !== id) return false;
  const t = value.result.rule.target;
  return t.ownerId === view.ownerId && t.connectionId === view.connectionId && t.sessionId === view.sessionId && t.runtime === 'codex';
}
export type AutomationDraft = { template: string; enabled: boolean; kind: 'once' | 'interval' | 'completion'; minutes: number; hours: number; maxSends: number; maxPerHour: number };
export function automationDraft(view: AutomationView, draft: AutomationDraft, id: string, now: number): AutomationConfiguration | undefined {
  const rule = readAutomationRule({ id, revision: 1, authorityEpoch: 1,
    target: { ownerId: view.ownerId, connectionId: view.connectionId, sessionId: view.sessionId, runtime: 'codex' },
    enabled: draft.enabled, startsAt: now, expiresAt: now + draft.hours * 3600000,
    maxSends: draft.maxSends, maxPerHour: draft.maxPerHour, minIntervalMs: draft.minutes * 60000,
    mode: draft.kind === 'completion' ? { kind: 'completion', allowOwnTurns: false }
      : draft.kind === 'once' ? { kind: 'once', at: now + draft.minutes * 60000 } : { kind: 'interval', intervalMs: draft.minutes * 60000 } });
  if (!rule || draft.hours > 168 || !draft.template.trim() || draft.template.length > 8192 || draft.template.includes('\0')) return;
  return { kind: 'save', rule, template: draft.template, expectedRevision: 0, confirmEnable: draft.enabled };
}
export function pauseAutomation(stored: StoredAutomationRule): AutomationConfiguration {
  return { kind: 'save', rule: { ...stored.rule, enabled: false, revision: stored.rule.revision + 1, authorityEpoch: stored.rule.authorityEpoch + 1 },
    template: stored.template, expectedRevision: stored.rule.revision, confirmEnable: false };
}
