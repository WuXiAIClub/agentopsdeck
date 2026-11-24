import { createHash, randomUUID } from 'node:crypto';
import type { AgentRuntime } from '@agentopsdeck/shared';

const sources = ['runtime', 'native-activity', 'native-snapshot', 'disconnect', 'final-history', 'final-history-error'] as const;
export type RuntimeDiagnosticSource = typeof sources[number];
const fingerprint = (value: unknown) => typeof value === 'string' && value
  ? createHash('sha256').update(value).digest('hex').slice(0, 16) : null;
const member = (value: unknown, allowed: readonly string[]) => typeof value === 'string' && allowed.includes(value) ? value : 'unknown';
const protectionReasons = ['settled', 'native-unavailable', 'goal-unknown', 'goal-blocked', 'goal-active', 'goal-paused',
  'goal-usageLimited', 'goal-budgetLimited', 'cleanup-unconfirmed', 'background-work', 'subagent-review', 'changed', 'restarted'];

/** All fields are allowlisted: never emit runtime.reason, payloads or raw IDs. */
function snapshot(runtime: AgentRuntime | undefined) {
  if (!runtime) return null;
  const protection = runtime.executionProtection;
  return {
    turn: fingerprint(runtime.turnId),
    operation: runtime.operation === undefined ? 'missing' : member(runtime.operation, ['message', 'compact']),
    phase: member(runtime.phase, ['starting', 'running', 'waiting', 'finalizing', 'completed', 'failed', 'interrupted', 'unknown']),
    activity: runtime.threadActivity === undefined ? 'missing' : member(runtime.threadActivity, ['idle', 'running', 'waiting', 'unknown']),
    connection: member(runtime.connection, ['connected', 'disconnected']),
    sync: member(runtime.sync, ['current', 'syncing', 'error']),
    protection: protection ? member(protection.state, ['verified', 'blocked']) : 'missing',
    protectionReason: protection ? member(protection.reason, protectionReasons) : 'missing',
    nativeTurn: fingerprint(protection?.nativeTurnId),
  };
}

/** Constant-size global limiter, no per-session cache. Compare committed states,
 * not timestamps or text reasons, so reads/token updates do not spam logs. */
export class RuntimeDiagnostics {
  private readonly instance = randomUUID();
  private sequence = 0;
  private since = 0;
  private count = 0;
  private suppressed = 0;
  constructor(private readonly sink: (line: string) => void = line => console.info(line),
    private readonly clock: () => number = () => performance.now()) {}

  transition(session: string, connection: string | undefined, previous: AgentRuntime | undefined,
    next: AgentRuntime, source: RuntimeDiagnosticSource = 'runtime',
    owner?: { commandId: string; runId?: string | undefined; revision: number }) {
    try {
      const before = snapshot(previous), after = snapshot(next);
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      const now = this.clock();
      if (now - this.since >= 60_000 || now < this.since) { this.since = now; this.count = 0; }
      if (this.count >= 120) { this.suppressed = Math.min(Number.MAX_SAFE_INTEGER, this.suppressed + 1); return; }
      this.count++;
      const age = Number.isFinite(next.lastEventAt) ? Date.now() - next.lastEventAt : NaN;
      this.sink(JSON.stringify({ component: 'codex-runtime', instance: this.instance, sequence: ++this.sequence,
        event: 'runtime_transition', session: fingerprint(session), connection: fingerprint(connection),
        source: member(source, sources), before, after,
        command: fingerprint(owner?.commandId), ownedTurn: fingerprint(owner?.runId),
        ...(Number.isSafeInteger(owner?.revision) && owner!.revision >= 0 ? { revision: owner!.revision } : {}),
        ...(Number.isFinite(age) ? { eventAgeMs: Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(age))) } : {}),
        suppressed: this.suppressed }));
      this.suppressed = 0;
    } catch { /* Logging must not change runtime projection or execution safety. */ }
  }
}
