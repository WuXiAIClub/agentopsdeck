/** Pure bounded-automation policy. No timers, storage, queue or native calls.
 * A future authoritative store MUST evaluate and reserve in one transaction;
 * this decision alone is never permission to send a message. */
export type AutomationTarget = { ownerId: string; connectionId: string; runtime: string; sessionId: string };
export type AutomationRule = {
  id: string; revision: number; authorityEpoch: number; target: AutomationTarget;
  enabled: boolean; startsAt: number; expiresAt: number;
  maxSends: number; maxPerHour: number; minIntervalMs: number;
  mode: { kind: 'interval'; intervalMs: number } | { kind: 'once'; at: number }
    | { kind: 'completion'; allowOwnTurns: boolean };
};
const MINUTE = 60_000, HOUR = 60 * MINUTE;
export const AUTOMATION_TIMER_GRACE_MS = 5_000;
const integer = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && (value as number) >= min;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const fields = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).every(key => expected.includes(key));
export function validAutomationTarget(value: unknown): value is AutomationTarget {
  return object(value) && fields(value, ['ownerId', 'connectionId', 'runtime', 'sessionId'])
    && ['ownerId', 'connectionId', 'runtime', 'sessionId'].every(key => text(value[key]));
}
/** Untrusted config parser: omission means disabled, never implicit activation. */
export function readAutomationRule(value: unknown): AutomationRule | undefined {
  if (!object(value) || !fields(value, ['id', 'revision', 'authorityEpoch', 'target', 'enabled', 'startsAt', 'expiresAt', 'maxSends', 'maxPerHour', 'minIntervalMs', 'mode'])
    || !text(value.id) || !integer(value.revision, 1) || !integer(value.authorityEpoch, 1) || !validAutomationTarget(value.target)
    || value.enabled !== undefined && typeof value.enabled !== 'boolean'
    || !integer(value.startsAt) || !integer(value.expiresAt) || value.expiresAt <= value.startsAt
    || !integer(value.maxSends, 1) || value.maxSends > 1000 || !integer(value.maxPerHour, 1) || value.maxPerHour > 60
    || !integer(value.minIntervalMs, MINUTE) || !object(value.mode)) return undefined;
  const mode = value.mode;
  if (mode.kind === 'interval') {
    if (!fields(mode, ['kind', 'intervalMs']) || !integer(mode.intervalMs, MINUTE)) return undefined;
  } else if (mode.kind === 'once') {
    if (!fields(mode, ['kind', 'at']) || !integer(mode.at) || mode.at < value.startsAt || mode.at >= value.expiresAt) return undefined;
  } else if (mode.kind === 'completion') {
    if (!fields(mode, ['kind', 'allowOwnTurns']) || typeof mode.allowOwnTurns !== 'boolean') return undefined;
  } else return undefined; // Daily/DST schedules are deliberately unsupported.
  return { ...value, enabled: value.enabled ?? false, target: { ...value.target }, mode: { ...mode } } as AutomationRule;
}
export type TimerTrigger = { kind: 'timer'; at: number; slot: number };
export type CompletionTrigger = { kind: 'completion'; turnId: string; startedAt: number; completedAt: number;
  outcome: 'completed' | 'failed' | 'interrupted'; operation: 'message' | 'compact';
  authoritative: boolean; historical: boolean; origin: 'manual' | 'automation' | 'unknown'; originRuleId?: string };
export type AutomationTrigger = TimerTrigger | CompletionTrigger;
/** Strictly future only. Restart callers use current time, never a stale cursor. */
export function nextAutomationTimer(rule: AutomationRule, after: number): TimerTrigger | undefined {
  if (!readAutomationRule(rule) || !rule.enabled || !integer(after) || rule.mode.kind === 'completion') return undefined;
  if (rule.mode.kind === 'once') return rule.mode.at > after ? { kind: 'timer', at: rule.mode.at, slot: 0 } : undefined;
  const slot = after < rule.startsAt ? 0 : Math.floor((after - rule.startsAt) / rule.mode.intervalMs) + 1;
  const at = rule.startsAt + slot * rule.mode.intervalMs;
  return integer(at) && at < rule.expiresAt ? { kind: 'timer', at, slot } : undefined;
}
export type AutomationLedger = {
  /** Includes every accepted, reserved AND unknown request; only proven
   * pre-dispatch rejection can release a count, never a network timeout. */
  occupied: number; reservedAt: readonly number[]; lastReservedAt?: number;
  consumedTriggers: ReadonlySet<string>;
};
export type AutomationObservation = {
  now: number; connectedSince: number; target: AutomationTarget; revision: number; authorityEpoch: number;
  online: boolean; idle: boolean; queueEmpty: boolean; admissionAllowed: boolean;
};
export type AutomationDecision = { eligible: true; triggerKey: string }
  | { eligible: false; reason: 'invalid' | 'disabled' | 'authority' | 'not-started' | 'expired' | 'offline'
    | 'clock' | 'busy' | 'admission' | 'trigger' | 'missed' | 'duplicate' | 'limit' | 'rate' };
const targetKey = (target: AutomationTarget) => JSON.stringify([target.ownerId, target.connectionId, target.runtime, target.sessionId]);
export function evaluateAutomation(rule: AutomationRule, trigger: AutomationTrigger, ledger: AutomationLedger, view: AutomationObservation): AutomationDecision {
  const no = (reason: Exclude<AutomationDecision, { eligible: true }>['reason']): AutomationDecision => ({ eligible: false, reason });
  if (!readAutomationRule(rule) || !validAutomationTarget(view.target) || !integer(view.now) || !integer(view.connectedSince)
    || [view.online, view.idle, view.queueEmpty, view.admissionAllowed].some(value => typeof value !== 'boolean')
    || !integer(ledger.occupied) || !Array.isArray(ledger.reservedAt) || ledger.reservedAt.length > 1000
    || ledger.reservedAt.some(at => !integer(at)) || ledger.lastReservedAt !== undefined && !integer(ledger.lastReservedAt)) return no('invalid');
  if (!rule.enabled) return no('disabled');
  if (view.revision !== rule.revision || view.authorityEpoch !== rule.authorityEpoch || targetKey(view.target) !== targetKey(rule.target)) return no('authority');
  if (view.now < rule.startsAt) return no('not-started');
  if (view.now >= rule.expiresAt) return no('expired');
  if (!view.online) return no('offline');
  if (view.connectedSince > view.now || ledger.lastReservedAt !== undefined && ledger.lastReservedAt > view.now
    || ledger.reservedAt.some(at => at > view.now)) return no('clock');
  if (!view.admissionAllowed) return no('admission');
  if (!view.idle || !view.queueEmpty) return no('busy');
  let identity: string | number;
  if (trigger.kind === 'timer') {
    if (rule.mode.kind === 'completion' || !integer(trigger.at) || !integer(trigger.slot)) return no('trigger');
    const at = rule.mode.kind === 'once' ? rule.mode.at : rule.startsAt + trigger.slot * rule.mode.intervalMs;
    if (at !== trigger.at || rule.mode.kind === 'once' && trigger.slot !== 0 || at >= rule.expiresAt || at > view.now) return no('trigger');
    if (at < view.connectedSince || view.now - at > AUTOMATION_TIMER_GRACE_MS) return no('missed');
    identity = trigger.slot;
  } else if (trigger.kind === 'completion') {
    if (rule.mode.kind !== 'completion' || !text(trigger.turnId) || !integer(trigger.startedAt) || !integer(trigger.completedAt)
      || trigger.startedAt < rule.startsAt || trigger.completedAt < trigger.startedAt || trigger.completedAt > view.now
      || trigger.outcome !== 'completed' || trigger.operation !== 'message' || trigger.authoritative !== true || trigger.historical !== false
      || !['manual', 'automation'].includes(trigger.origin) || trigger.origin === 'manual' && trigger.originRuleId !== undefined
      || trigger.origin === 'automation' && (!rule.mode.allowOwnTurns || trigger.originRuleId !== rule.id)) return no('trigger');
    if (trigger.completedAt < view.connectedSince) return no('missed');
    identity = trigger.turnId;
  } else return no('trigger');
  // JSON tuples avoid separator collisions; target/revision/epoch fence old grants.
  const triggerKey = JSON.stringify([rule.id, rule.revision, rule.authorityEpoch, targetKey(rule.target), trigger.kind, identity]);
  if (ledger.consumedTriggers.has(triggerKey)) return no('duplicate');
  if (ledger.occupied >= rule.maxSends) return no('limit');
  if (ledger.lastReservedAt !== undefined && view.now - ledger.lastReservedAt < rule.minIntervalMs
    || ledger.reservedAt.filter(at => at > view.now - HOUR).length >= rule.maxPerHour) return no('rate');
  return { eligible: true, triggerKey };
}
