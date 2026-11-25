import { createHash, randomUUID } from 'node:crypto';

const tags = { final: '[codex-final-history-failed]', refresh: '[codex-history-refresh-failed]',
  recovery: '[codex-terminal-recovery]' } as const;
const stages = ['startup', 'native-read', 'native-snapshot', 'rollout-snapshot', 'history-projection',
  'history-ownership', 'history-completeness',
  'cold-recovery-goal', 'cold-recovery-recheck', 'cold-recovery-resume', 'cold-recovery-confirm', 'history-storage-read',
  'terminal-cleanup-proof', 'rollout-cleanup', 'projection-apply', 'assistant-projection-wait',
  'execution-verification', 'final-history', 'terminal-reload'];
const faults = ['schema', 'system-error', 'identity', 'item-view', 'native-read', 'incomplete',
  'rollout-pending', 'background-terminals', 'interrupted-dispatch', 'authority-changed', 'unavailable', 'protected', 'recovered'];
const recoveryGates = ['eligibility', 'single-attempt', 'native-schema', 'path', 'head', 'active-history',
  'child-work', 'goal', 'background-work', 'rollout', 'journal-prepare', 'journal-begin', 'unsubscribe',
  'resume', 'resume-ack', 'archive', 'unarchive', 'journal-finish', 'confirm',
  'confirm-status', 'confirm-history', 'confirm-goal', 'recovered'];
const member = (value: unknown, allowed: readonly string[]) => typeof value === 'string' && allowed.includes(value) ? value : 'unknown';
const fingerprint = (value: unknown) => typeof value === 'string' && value
  ? createHash('sha256').update(value).digest('hex').slice(0, 16) : null;
type Failure = { stage: string; fault: string; attempts?: number; outcome?: string; gate?: string;
  ownership?: { total: number; owned: number; unattributed: number };
  lifecycle?: { declaredTemporary: number; declaredService: number; undeclaredOwned: number; unattributed: number } };

/** Bounded history/recovery observations: one O(1) budget across all sessions.
 * A throwing/reentrant sink or clock never replaces the native
 * failure, retires an execution owner, releases admission or starts a retry.
 * Preserve existing event tags without raw identifiers or exception strings. */
export class HistoryDiagnostics {
  private readonly instance = randomUUID();
  private sequence = 0;
  private since = 0;
  private count = 0;
  private suppressed = 0;
  private observing = false;
  constructor(private readonly sink: (tag: string, row: Record<string, unknown>) => void = (tag, row) => console.error(tag, row),
    private readonly clock: () => number = () => performance.now()) {}

  failure(kind: keyof typeof tags, session: string, connection: string | undefined, turn: string | undefined, fields: Failure) {
    if (this.observing) { this.suppressed = Math.min(Number.MAX_SAFE_INTEGER, this.suppressed + 1); return; }
    this.observing = true;
    try {
      if (!Object.hasOwn(tags, kind)) return;
      const now = this.clock();
      if (!Number.isFinite(now)) return;
      if (now - this.since >= 60_000 || now < this.since) { this.since = now; this.count = 0; }
      if (this.count >= 120) { this.suppressed = Math.min(Number.MAX_SAFE_INTEGER, this.suppressed + 1); return; }
      this.count++;
      const row: Record<string, unknown> = { component: 'codex-history', instance: this.instance, sequence: ++this.sequence,
        event: kind === 'recovery' ? 'terminal_recovery_observed' : kind === 'final' ? 'final_history_failed' : 'history_refresh_failed',
        session: fingerprint(session), connection: fingerprint(connection), turn: fingerprint(turn),
        stage: member(fields.stage, stages), fault: member(fields.fault, faults), suppressed: this.suppressed };
      if (fields.outcome !== undefined) row.outcome = member(fields.outcome, ['completed', 'failed', 'interrupted']);
      if (fields.gate !== undefined) row.gate = member(fields.gate, recoveryGates);
      if (Number.isSafeInteger(fields.attempts) && fields.attempts! >= 0) row.attempts = fields.attempts;
      for (const [field, names] of [
        ['ownership', ['total', 'owned', 'unattributed']],
        ['lifecycle', ['declaredTemporary', 'declaredService', 'undeclaredOwned', 'unattributed']],
      ] as const) {
        const input = fields[field];
        if (input) {
          const counts: Record<string, number> = {};
          for (const name of names) {
            const value = (input as unknown as Record<string, unknown>)[name];
            if (Number.isSafeInteger(value) && (value as number) >= 0) counts[name] = value as number;
          }
          row[field] = counts;
        }
      }
      // Clear before calling the sink: a nested observation belongs to the
      // next report instead of being erased on return from the original sink.
      this.suppressed = 0;
      this.sink(tags[kind], row);
    } catch { /* Observation cannot change native history or execution safety. */ }
    finally { this.observing = false; }
  }
}
