import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { readCodexGoal } from '@agentopsdeck/shared';
import type { DatabaseSync } from 'node:sqlite';
import { isRecord } from '../commands/turn-queue.js';

export function registerNativeHistoryWriter(db: DatabaseSync) {
  db.function('agentopsdeck_codex_native_history_epoch', { deterministic: true }, () => 1);
}

/** Installed lazily in the same transaction as the first checkpoint. Older
 * runtimes must fail at startup, not ignore the new independent admission
 * guard. Standalone execution stores also reject old direct writers. */
export function requireNativeHistoryWriter(db: DatabaseSync) {
  const tables = ['connector_codex_executions', 'connector_users'];
  for (const table of tables) {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table)) continue;
    for (const operation of table === 'connector_users' ? ['INSERT'] : ['INSERT', 'UPDATE', 'DELETE']) {
      const name = `codex_native_history_${table}_${operation.toLowerCase()}`;
      const sql = `CREATE TRIGGER ${name} BEFORE ${operation} ON ${table}
        WHEN agentopsdeck_codex_native_history_epoch() IS NOT 1
        BEGIN SELECT RAISE(ABORT, 'Incompatible native history writer; use a compatible release'); END`;
      const existing = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?").get(name) as { sql: string } | undefined;
      if (existing && existing.sql.replace(/\s+/g, ' ').trim() !== sql.replace(/\s+/g, ' ').trim()) {
        throw new Error('Native history writer compatibility guard changed');
      }
      if (!existing) db.exec(sql);
    }
  }
}

/** An observation, NEVER a command/run binding or permission to replay work. */
export type NativeHistoryCheckpoint = {
  turnId: string;
  fingerprint: string;
  connectionId: string;
  state: 'verified' | 'blocked';
  reason: 'settled' | 'goal-active' | 'goal-paused' | 'goal-blocked' | 'goal-usageLimited'
    | 'goal-budgetLimited' | 'goal-unknown' | 'native-unavailable' | 'background-work'
    | 'subagent-review' | 'cleanup-unconfirmed' | 'changed' | 'restarted';
};

// Stream one turn at a time: do not retain a second whole transcript. Include
// contents, not just turn IDs, so late tool results invalidate the observation.
export function nativeHistoryFingerprint(thread: any): string {
  const hash = createHash('sha256');
  const ordinaryWindowsPath = process.platform === 'win32' && typeof thread.path === 'string'
    && !thread.path.startsWith('\\\\?\\') && !thread.path.startsWith('\\\\.\\')
    && (/^[A-Za-z]:[\\/]/.test(thread.path) || /^\\\\[^\\/]+\\[^\\/]+(?:\\|$)/.test(thread.path));
  const rolloutPath = ordinaryWindowsPath
    ? win32.toNamespacedPath(thread.path) : thread.path ?? null;
  hash.update(JSON.stringify([thread.id, rolloutPath]));
  for (const turn of thread.turns) hash.update('\n').update(JSON.stringify(turn));
  return hash.digest('hex');
}

/** Hashes goal text and usage without persisting their plaintext. An
 * unsupported/malformed query is not proof that there is no continuing goal. */
export function nativeGoalEvidence(result: unknown, threadId: string): { status: string; version: string } {
  // Drain/interaction evidence cannot trust a weaker shape than presentation.
  // In particular a malformed `complete` is unknown, never proof of safety.
  const observed = readCodexGoal(result, threadId);
  if (observed === undefined) return { status: 'unknown', version: '' };
  if (observed === null) return { status: 'absent', version: 'absent' };
  const goal = (result as { goal: Record<string, unknown> }).goal;
  // Native timestamps have finite precision. Replacing an objective or budget
  // within the same timestamp must still invalidate an earlier drain proof.
  // Keep content out of checkpoints/logs; counters also pin the full snapshot.
  return { status: observed.status, version: createHash('sha256').update(JSON.stringify([
    threadId, goal.status, goal.createdAt, goal.updatedAt, goal.objective ?? null,
    goal.tokenBudget ?? null, goal.timeBudgetSeconds ?? null, goal.tokensUsed ?? null, goal.timeUsedSeconds ?? null,
  ])).digest('hex') };
}

/** Self-targeted `/root` collaboration activity on the root thread itself is
 * not a child thread and must not deadlock child-drain proof as a cycle. */
export function isSelfRootSubAgentActivity(item: unknown, rootThreadId?: string): boolean {
  return isRecord(item)
    && item.type === 'subAgentActivity'
    && typeof rootThreadId === 'string'
    && rootThreadId.length > 0
    && item.agentThreadId === rootThreadId
    && item.agentPath === '/root';
}

/** Both legacy collaboration items and the newer activity-only representation
 * imply child work. Neither a finished tool nor an interrupted activity proves
 * child shutdown; unknown child ownership must stay protected. */
export function hasNativeChildWork(items: readonly { type?: unknown; [key: string]: unknown }[], rootThreadId?: string): boolean {
  return items.some(item => !isSelfRootSubAgentActivity(item, rootThreadId)
    && ['collabAgentToolCall', 'collabToolCall', 'subAgentActivity'].includes(String(item?.type)));
}

export function nativeGoalProtection(status: string): NativeHistoryCheckpoint['reason'] | undefined {
  if (status === 'absent' || status === 'complete') return;
  if (['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited'].includes(status)) {
    return `goal-${status}` as NativeHistoryCheckpoint['reason'];
  }
  return 'goal-unknown';
}
