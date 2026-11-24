import type { SessionSummary } from '@agentopsdeck/shared';
import { hasQueueBlockingRun, sessionRunOutcome } from './live-session.js';

/** Track terminal identity, not lastEventAt (which changes on history sync).
 * Fast runs can start AND finish between metadata reads. Never replay the
 * initial historical Done, and defer attention until history is confirmed. */
export function createPaneCompletionTracker(onObservation?: (key: string, reason: string, facts: Record<string, string | number | boolean | undefined>) => void) {
  const seen = new Map<string, { running: boolean; empty: boolean; turnId: string | undefined; startedAt: number | undefined; completedAt: number | undefined }>();
  const observations = new Map<string, string>();
  return {
    prune(keys: ReadonlySet<string>) { for (const key of seen.keys()) if (!keys.has(key)) { seen.delete(key); observations.delete(key); } },
    observe(session: SessionSummary): 'running' | 'completed' | undefined {
      const previous = seen.get(session.sessionKey);
      const running = hasQueueBlockingRun(session) && session.runtime?.operation !== 'compact';
      const current = { running, turnId: session.runtime?.turnId, startedAt: session.runStartedAt, completedAt: session.runCompletedAt,
        empty: !running && (!session.runtime || session.runtime.phase === 'completed' && session.runtime.sync === 'current' && session.messageCount === 0)
          && session.status === 'idle' && !session.runtime?.turnId && !session.runStartedAt && !session.runCompletedAt };
      const report = (reason: string, result?: 'running' | 'completed') => {
        if (onObservation) {
          const runtime = session.runtime;
          const facts = { reason, status: session.status, phase: runtime?.phase, sync: runtime?.sync,
            connection: runtime?.connection, activity: runtime?.threadActivity, operation: runtime?.operation,
            protection: runtime?.executionProtection?.state, hasProtectionReason: !!runtime?.executionProtection?.reason,
            hasTurnId: !!current.turnId, hasCompletedAt: current.completedAt !== undefined, previousRunning: previous?.running ?? false };
          // Identity participates in deduplication only; it never leaves this tracker.
          const signature = JSON.stringify([facts, current.turnId, current.completedAt]);
          if (observations.get(session.sessionKey) !== signature) {
            observations.set(session.sessionKey, signature); onObservation(session.sessionKey, 'observe', facts);
          }
        }
        return result;
      };
      if (!previous) { seen.set(session.sessionKey, current); return report(running ? 'initial-running' : 'initial-history', running ? 'running' : undefined); }
      if (running) { seen.set(session.sessionKey, current); return report('running', !previous.running ? 'running' : undefined); }
      const outcome = sessionRunOutcome(session);
      if (!outcome) return report('awaiting-authoritative-outcome');
      // A late metadata response can carry the preceding terminal snapshot.
      // Keep the witnessed run until its outcome arrives; don't consume its
      // attention or celebrate a completion that predates its start. Different
      // turn IDs alone aren't stale: a fast successor may finish between reads.
      if (previous.running && previous.startedAt !== undefined && current.completedAt !== undefined
        && current.completedAt < previous.startedAt) return report('stale-terminal-before-run');
      if (!previous.running && previous.completedAt !== undefined && current.completedAt !== undefined && current.completedAt < previous.completedAt) return report('stale-terminal');
      const freshTerminal = (!!previous.turnId && !!current.turnId && previous.turnId !== current.turnId)
        || (previous.completedAt !== undefined && current.completedAt !== undefined && current.completedAt > previous.completedAt)
        // The first fast turn has no previous identity to compare against.
        // Only an observed empty idle baseline qualifies, never initial Done
        // or an uncertain runtime whose historical fields arrive later.
        || (previous.empty && (!!current.turnId || current.completedAt !== undefined));
      seen.set(session.sessionKey, current);
      if (outcome === 'completed' && (previous.running || freshTerminal)) return report('new-completion', 'completed');
      return report(outcome === 'completed' ? 'unchanged-terminal' : outcome);
    },
  };
}
