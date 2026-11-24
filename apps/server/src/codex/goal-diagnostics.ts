import { createHash, randomUUID } from 'node:crypto';

const events = [
  'read_started', 'read_joined', 'read_completed', 'read_conflict', 'read_failed',
  'change_started', 'local_write_conflict', 'preflight_failed', 'prewrite_failed', 'dispatch_started', 'write_returned',
  'write_timeout', 'outcome_unknown', 'post_ack_failed', 'control_conflict', 'rpc_error', 'ack_received', 'late_ack_received',
  'ack_invalid', 'ack_persist_failed', 'ack_persisted', 'projection_skipped',
  'ack_expired', 'ack_connection_lost', 'transport_unavailable',
  'owned_terminal_recovered',
  'terminal_history_readable_protected',
  'terminal_history_readable_during_activity',
  'native_identity_rejected',
  'terminal_load_started', 'terminal_load_completed', 'terminal_recovery_failed',
] as const;
type Event = typeof events[number];
const failureEvents: ReadonlySet<Event> = new Set([
  'read_conflict', 'read_failed', 'local_write_conflict', 'preflight_failed', 'prewrite_failed',
  'write_timeout', 'outcome_unknown', 'post_ack_failed', 'control_conflict', 'rpc_error',
  'ack_invalid', 'ack_persist_failed', 'ack_expired', 'ack_connection_lost', 'transport_unavailable',
  'native_identity_rejected', 'terminal_recovery_failed',
]);
type Fields = { rpcId?: number | undefined; version?: number | undefined; currentVersion?: number | undefined };
export type GoalDiagnosticTrace = (event: Event, fields?: Fields) => void;
const actions = ['read', 'create', 'edit', 'pause', 'resume', 'clear', 'recovery', 'invalid'];
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

/** Diagnostic-only, bounded O(1) state. No payloads, exception strings, revisions,
 * objectives or paths. Separate read budget keeps routine polling from using
 * the control/failure budgets. Faults have a process-wide reserve independent
 * of repeated readable-but-protected history. No per-session growing map.
 * Sink or clock failure must never affect a dispatch fence. */
export class GoalDiagnostics {
  private readonly instance = randomUUID();
  private sequence = 0;
  private readonly buckets = {
    read: { since: 0, count: 0, suppressed: 0 },
    control: { since: 0, count: 0, suppressed: 0 },
    failed: { since: 0, count: 0, suppressed: 0 },
  };
  constructor(private readonly sink: (line: string) => void = line => console.info(line),
    private readonly clock: () => number = () => performance.now()) {}

  private readingClock = false;
  private readClock(): number {
    if (this.readingClock) return NaN;
    this.readingClock = true;
    try { return this.clock(); }
    finally { this.readingClock = false; }
  }

  trace(session: string, connection: string | undefined, action: string): GoalDiagnosticTrace {
    const operation = ++this.sequence;
    let started: number | undefined;
    // Trace creation is also on execution/control paths. A broken observation
    // clock must not prevent a Goal change, history read or identity rejection.
    try { const now = this.readClock(); if (Number.isFinite(now)) started = now; } catch { /* Observation only. */ }
    const context = { component: 'codex-goal', instance: this.instance, operation,
      session: fingerprint(session), connection: connection ? fingerprint(connection) : null,
      action: actions.includes(action) ? action : 'invalid' };
    return (event, fields = {}) => {
      try {
        if (!events.includes(event)) return;
        const now = this.readClock();
        if (!Number.isFinite(now)) return;
        const routine = ['read_started', 'read_joined', 'read_completed'].includes(event);
        const bucket = routine ? this.buckets.read : failureEvents.has(event) ? this.buckets.failed : this.buckets.control;
        if (now - bucket.since >= 60_000 || now < bucket.since) { bucket.since = now; bucket.count = 0; }
        if (bucket.count >= (routine ? 20 : 120)) {
          bucket.suppressed = Math.min(Number.MAX_SAFE_INTEGER, bucket.suppressed + 1); return;
        }
        bucket.count++;
        const numbers: Fields = {};
        for (const key of ['rpcId', 'version', 'currentVersion'] as const) {
          if (Number.isSafeInteger(fields[key]) && fields[key]! >= 0) numbers[key] = fields[key];
        }
        this.sink(JSON.stringify({ ...context, event, elapsedMs: started === undefined ? 0 : Math.max(0, Math.round(now - started)),
          ...numbers, suppressed: bucket.suppressed }));
        bucket.suppressed = 0;
      } catch { /* Diagnostics cannot change Goal or receipt semantics. */ }
    };
  }
}
