import { randomUUID } from 'node:crypto';
import { automationIdentity } from '@agentopsdeck/shared';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import type { CodexAutomationCompletion } from '../codex/automation-completions.js';
import type { AutomationTarget } from '../commands/automation-policy.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { createTurnAuthorizer } from './execution-grants.js';
import type { CodexAutomationRuntime, createCodexAutomation } from './codex-automation.js';

export type AutomationLocalObservation = { sessionKey: string; connectionId: string | null;
  now: number; connectedSince: number; online: boolean; idle: boolean };
export type AutomationBackgroundPlan = { id: string; ownerId: string; targets: string[] };
export type AutomationQueuedHint = { sessionKey: string; id: string; text: string; createdAt: number; queueVersion: string };
export type ConnectorAutomationBackgroundCommands = {
  automationBackgroundPlan: { input: { after: string }; output: AutomationBackgroundPlan | null };
  automationBackgroundPoll: { input: { planId: string; observations: AutomationLocalObservation[];
    completions: CodexAutomationCompletion[] }; output: { queued: AutomationQueuedHint[] } };
  automationBackgroundStop: { input: Record<string, never>; output: null };
};
export type ConnectorAutomationBackgroundKind = keyof ConnectorAutomationBackgroundCommands;
export const connectorAutomationBackgroundSteps = Object.freeze({ automationBackgroundPlan: 276,
  automationBackgroundPoll: 277, automationBackgroundStop: 278 });
export const isConnectorAutomationBackgroundKind = (k: string): k is ConnectorAutomationBackgroundKind => Object.hasOwn(connectorAutomationBackgroundSteps, k);
const fields = (v: unknown, keys: string[]): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const text = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= max && !/[\x00-\x1f\x7f]/.test(v);
const key = (v: unknown): v is string => automationIdentity(v) && v.startsWith('codex:') && v.length > 6;
const time = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const observation = (v: unknown): v is AutomationLocalObservation => fields(v, ['sessionKey', 'connectionId', 'now', 'connectedSince', 'online', 'idle'])
  && key(v.sessionKey) && (v.connectionId === null || text(v.connectionId)) && time(v.now) && time(v.connectedSince)
  && typeof v.online === 'boolean' && typeof v.idle === 'boolean';
const completion = (v: unknown): v is CodexAutomationCompletion => fields(v, ['actorId', 'sessionKey', 'commandId', 'connectionId', 'turnId', 'startedAt', 'completedAt'])
  && automationIdentity(v.actorId) && key(v.sessionKey) && text(v.commandId) && text(v.connectionId) && text(v.turnId)
  && time(v.startedAt) && time(v.completedAt) && v.startedAt <= v.completedAt;
export function validConnectorAutomationBackgroundInput(k: ConnectorAutomationBackgroundKind, v: unknown): boolean {
  if (k === 'automationBackgroundStop') return fields(v, []);
  if (k === 'automationBackgroundPlan') return fields(v, ['after']) && (v.after === '' || automationIdentity(v.after));
  return fields(v, ['planId', 'observations', 'completions']) && text(v.planId, 64)
    && Array.isArray(v.observations) && v.observations.length <= 1000 && v.observations.every(observation)
    && new Set(v.observations.map((o: AutomationLocalObservation) => o.sessionKey)).size === v.observations.length
    && Array.isArray(v.completions) && v.completions.length <= 512 && v.completions.every(completion);
}
export function validConnectorAutomationBackgroundOutput(k: ConnectorAutomationBackgroundKind, v: unknown): boolean {
  if (k === 'automationBackgroundStop') return v === null;
  if (k === 'automationBackgroundPlan') return v === null || fields(v, ['id', 'ownerId', 'targets']) && text(v.id, 64)
    && automationIdentity(v.ownerId) && Array.isArray(v.targets) && v.targets.length <= 1000 && v.targets.every(key)
    && new Set(v.targets).size === v.targets.length;
  return fields(v, ['queued']) && Array.isArray(v.queued) && v.queued.length <= 1000 && v.queued.every((h: unknown) =>
    fields(h, ['sessionKey', 'id', 'text', 'createdAt', 'queueVersion']) && key(h.sessionKey) && text(h.id)
    && typeof h.text === 'string' && h.text.length <= 8192 && time(h.createdAt) && text(h.queueVersion));
}

/** Private background domain; never registered as an HTTP route. Plan owner and
 * targets are recovered from original durable rules, not a caller principal.
 * Local observations can only veto. SQL authority and the original queue commit
 * callback stay in this owner. No timer, native child or SQL RPC is constructed. */
export function createConnectorAutomationBackground(owner: ConnectorUserStore, tokens?: ConnectorTokenStore) {
  const authorize = createTurnAuthorizer(owner.executionGrants, (actor, scope) => tokens?.hasScope(actor, scope) === true);
  const allowed = (target: AutomationTarget) => target.connectionId === owner.nodeId && target.runtime === 'codex' && key(target.sessionId)
    && tokens?.hasScope(target.ownerId, 'automation:manage') === true
    && authorize(target.ownerId, { runtime: 'codex', sessionKey: target.sessionId }, 'messages:send')
    && !owner.commands.sessionDeletion(target.sessionId) && !owner.codexExecutions.isDeletedTerminal(target.sessionId);
  type Service = ReturnType<typeof createCodexAutomation>;
  const services = new Map<string, Service>();
  let plan: (AutomationBackgroundPlan & { at: number }) | undefined;
  let local = new Map<string, AutomationLocalObservation>(), completed: CodexAutomationCompletion[] = [];
  let queued: AutomationQueuedHint[] = [], stopped = false;
  const view = (sessionKey: string, actorId: string) => {
    const o = local.get(sessionKey), now = Date.now(), fact = owner.codexExecutions.get(sessionKey);
    const fresh = !!o && o.now <= now && now - o.now <= 5000 && o.connectedSince > 0 && o.connectedSince <= o.now;
    const target: AutomationTarget = { ownerId: actorId, connectionId: owner.nodeId, runtime: 'codex', sessionId: sessionKey };
    const online = fresh && o.online && o.connectionId !== null && fact?.connectionId === o.connectionId;
    const idle = !!online && o.idle && owner.codexExecutions.canStart(sessionKey) && !!fact?.runId
      && fact.sync === 'current' && !fact.reason && !fact.preparation && fact.nativeHistory?.state === 'verified'
      && fact.nativeHistory.turnId === fact.runId && fact.nativeHistory.connectionId === o.connectionId;
    return { now, connectedSince: o?.connectedSince ?? 0, online: !!online, idle,
      admissionAllowed: !!online && owner.sdkCommandAdmissionOpen && allowed(target) };
  };
  const runtime: CodexAutomationRuntime = {
    owns: key,
    automationObservation: view,
    takeAutomationCompletions: actorId => {
      const now = Date.now(), values = completed; completed = [];
      return values.filter(e => {
        const f = owner.codexExecutions.get(e.sessionKey), o = local.get(e.sessionKey);
        return e.actorId === actorId && now >= e.completedAt && now - e.completedAt <= 300000
          && f?.commandId === e.commandId && f.runId === e.turnId && f.connectionId === e.connectionId
          && o?.connectionId === e.connectionId && f.phase === 'completed' && view(e.sessionKey, actorId).idle;
      });
    },
    send: async (sessionKey, template, images = [], admission) => {
      if (images.length || !admission?.actorId || admission.executionGrant || !admission.accept) throw Error('automation_admission_unavailable');
      const actorId = admission.actorId, id = `${sessionKey}:codex-queued-${randomUUID()}`, now = Date.now();
      const check = () => {
        const v = view(sessionKey, actorId);
        if (!v.online || !v.idle || !v.admissionAllowed || stopped) throw Error('automation_admission_unavailable');
      };
      const result: Awaited<ReturnType<CodexAutomationRuntime['send']>> = { runId: id, idempotencyKey: id, status: 'queued', media: [] };
      let committed: AutomationQueuedHint | undefined;
      try {
        await owner.turns.enqueueAsync('codex', { id, sessionKey, createdAt: now,
          payload: { text: template, images: [], actorId } }, (db, turn) => {
          const queueVersion = owner.turns.version('codex', sessionKey, id)!;
          result.admission = { createdAt: now, queueVersion, disposition: 'preparing' };
          admission.accept!(result)!(db, turn);
          committed = { sessionKey, id, text: template, createdAt: now, queueVersion };
        }, check);
        return result;
      } finally {
        // A callback can precede transaction rollback. Publish only the exact
        // committed FIFO row; a lost reply never causes another enqueue.
        const row = committed && owner.turns.list<{ text: string; actorId: string }>('codex', sessionKey).find(t => t.id === id);
        if (committed && row?.payload.actorId === actorId && row.payload.text === template) queued.push(committed);
      }
    },
  };
  const service = (actor: string) => {
    let s = services.get(actor);
    if (!s) {
      if (services.size >= 128) throw Error('automation_owner_capacity');
      s = owner.createCodexAutomation(runtime, actor, owner.nodeId, allowed); services.set(actor, s);
    }
    return s;
  };
  const dispose = () => { stopped = true; plan = undefined; local.clear(); completed = [];
    for (const s of services.values()) s.scheduler.stop(); services.clear(); };
  const execute = async <K extends ConnectorAutomationBackgroundKind>(kind: K,
    input: ConnectorAutomationBackgroundCommands[K]['input']): Promise<ConnectorAutomationBackgroundCommands[K]['output']> => {
    if (!validConnectorAutomationBackgroundInput(kind, input)) throw Error('connector_storage_unavailable');
    let result: unknown;
    if (kind === 'automationBackgroundStop') { dispose(); result = null; }
    else if (stopped) throw Error('connector_storage_unavailable');
    else if (kind === 'automationBackgroundPlan') {
      plan = undefined;
      const after = (input as { after: string }).after;
      const owners = owner.automationOwners();
      for (const [actor, s] of services) if (!owners.includes(actor) || !tokens?.hasScope(actor, 'automation:manage') || !tokens.hasScope(actor, 'messages:send')) {
        s.scheduler.stop(); services.delete(actor);
      }
      const actor = owners.find(actor => actor > after && tokens?.hasScope(actor, 'automation:manage') && tokens.hasScope(actor, 'messages:send'));
      if (!actor) result = null;
      else {
        const s = service(actor); s.scheduler.start(false);
        const targets = [...new Set(s.store.list(actor).filter(r => !r.revoked && allowed(r.rule.target)).map(r => r.rule.target.sessionId))];
        plan = { id: randomUUID(), ownerId: actor, targets, at: Date.now() };
        result = { id: plan.id, ownerId: actor, targets: [...targets] };
      }
    } else {
      const v = input as ConnectorAutomationBackgroundCommands['automationBackgroundPoll']['input'], p = plan;
      plan = undefined; // Consume before any async work, including failure.
      if (!p || p.id !== v.planId || Date.now() < p.at || Date.now() - p.at > 5000
        || v.observations.length !== p.targets.length || v.observations.some(o => !p.targets.includes(o.sessionKey))
        || v.completions.some(e => e.actorId !== p.ownerId || !p.targets.includes(e.sessionKey))) throw Error('connector_storage_unavailable');
      local = new Map(structuredClone(v.observations).map(o => [o.sessionKey, o]));
      completed = structuredClone(v.completions); queued = [];
      try {
        const s = service(p.ownerId);
        await s.pollCompleted(); await s.scheduler.tick();
        result = { queued: queued.filter(h => allowed({ ownerId: p.ownerId, connectionId: owner.nodeId, runtime: 'codex', sessionId: h.sessionKey })) };
      } finally { local.clear(); completed = []; queued = []; }
    }
    if (!validConnectorAutomationBackgroundOutput(kind, result)) throw Error('connector_storage_unavailable');
    return result as ConnectorAutomationBackgroundCommands[K]['output'];
  };
  return Object.assign(execute, { dispose });
}
