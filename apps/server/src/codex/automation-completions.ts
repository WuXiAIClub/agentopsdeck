import type { CodexExecution } from './executions.js';

export type CodexAutomationCompletion = {
  actorId: string; sessionKey: string; commandId: string; connectionId: string;
  turnId: string; startedAt: number; completedAt: number;
};
type Candidate = Omit<CodexAutomationCompletion, 'turnId' | 'completedAt'> & {
  turnId?: string; live?: { turnId: string; at: number; outcome: string };
};
/** Ephemeral, current-process proof, never restored from history. A live
 * notification alone is insufficient: queue ownership, ACK identity and the
 * final native-history/Goal gates must independently agree. Losing this cache
 * skips a trigger; it must never recover/replay an automatic message. */
export class CodexAutomationCompletions {
  private readonly candidates = new Map<string, Candidate>();
  reset() { this.candidates.clear(); }
  begin(sessionKey: string, commandId: string, connectionId: string, actorId: string | undefined, at: number) {
    this.candidates.delete(sessionKey);
    if (!actorId || this.candidates.size >= 512) return;
    this.candidates.set(sessionKey, { sessionKey, commandId, connectionId, actorId, startedAt: at });
  }
  acknowledge(sessionKey: string, commandId: string, connectionId: string, turnId: string) {
    const c = this.candidates.get(sessionKey);
    if (!c || c.commandId !== commandId || c.connectionId !== connectionId) return;
    if (c.turnId && c.turnId !== turnId || c.live && c.live.turnId !== turnId) { this.candidates.delete(sessionKey); return; }
    c.turnId = turnId;
  }
  live(sessionKey: string, connectionId: string, turnId: string, outcome: string, at: number) {
    const c = this.candidates.get(sessionKey);
    if (!c || c.connectionId !== connectionId || c.turnId && c.turnId !== turnId) return;
    if (c.live) {
      if (c.live.turnId !== turnId || c.live.outcome !== outcome) this.candidates.delete(sessionKey);
      return; // Duplicate notification must not refresh the trigger's age.
    }
    c.live = { turnId, outcome, at };
  }
  take(actorId: string, connectionId: string | undefined, now: number,
    execution: (key: string) => CodexExecution | undefined, idle: (key: string) => boolean): CodexAutomationCompletion[] {
    const result: CodexAutomationCompletion[] = [];
    for (const [key, c] of this.candidates) {
      if (c.connectionId !== connectionId || c.live && (c.live.outcome !== 'completed' || now - c.live.at > 300000)) {
        this.candidates.delete(key); continue;
      }
      if (c.actorId !== actorId || !c.live || !c.turnId || now < c.live.at || c.live.at < c.startedAt) continue;
      const fact = execution(key);
      if (!fact || fact.commandId !== c.commandId || fact.connectionId !== c.connectionId || fact.runId !== c.turnId) {
        this.candidates.delete(key); continue;
      }
      if (fact.phase !== 'completed' || fact.nativeHistory?.state !== 'verified'
        || fact.nativeHistory.turnId !== c.turnId || fact.nativeHistory.connectionId !== connectionId || !idle(key)) continue;
      this.candidates.delete(key); // Consume before dispatch; failures never replay.
      result.push({ actorId, sessionKey: key, commandId: c.commandId, connectionId: c.connectionId,
        turnId: c.turnId, startedAt: c.startedAt, completedAt: c.live.at });
    }
    return result;
  }
}
