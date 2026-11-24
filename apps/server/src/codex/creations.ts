import type { DatabaseSync } from 'node:sqlite';
import { observedTransaction } from '../storage/observed-transaction.js';
import type { CodexExecutions } from './executions.js';

type Creation = { receipt: string; state: 'reserved' | 'ready' | 'identified' | 'naming' | 'blocked'; thread: string | null; tools: number };

/** Same connection as receipts and original tool enrollment. Unknown native
 * effects survive restart and consume their reservation until explicitly resolved.
 * No TTL or restart replay is allowed to turn an unknown start into a new start. */
export class CodexCreations {
  constructor(private readonly db: DatabaseSync, private readonly executions: CodexExecutions) {
    db.exec(`CREATE TABLE IF NOT EXISTS connector_codex_creations (
      receipt TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('reserved','ready','identified','naming','blocked')),
      thread TEXT, tools INTEGER NOT NULL CHECK(tools IN (0,1)));
      CREATE UNIQUE INDEX IF NOT EXISTS connector_codex_creation_identity
        ON connector_codex_creations(thread) WHERE state IN ('identified','naming')`);
  }
  get(receipt: string): Creation | undefined {
    return this.db.prepare('SELECT receipt,state,thread,tools FROM connector_codex_creations WHERE receipt=?').get(receipt) as Creation | undefined;
  }
  available(tools: boolean): boolean {
    const n = this.db.prepare(`SELECT count(*) AS total, coalesce(sum(CASE WHEN tools=1 AND (thread IS NULL OR state='blocked') THEN 1 ELSE 0 END),0) AS slots
      FROM connector_codex_creations`).get() as { total: number; slots: number };
    return n.total < 128 && (!tools || this.executions.canEnrollBoardTools(n.slots));
  }
  reserve(receipt: string, tools: boolean) {
    if (!this.db.isTransaction || !this.available(tools)) throw Error('Codex creation capacity unavailable');
    this.db.prepare("INSERT INTO connector_codex_creations(receipt,state,tools) VALUES (?,'reserved',?)").run(receipt, Number(tools));
  }
  transition(receipt: string, from: Creation['state'], to: Creation['state'], check: () => void): boolean {
    return observedTransaction(this.db, 'codex-creation-change', (_commit, inspect) => {
      inspect(check());
      return Number(this.db.prepare('UPDATE connector_codex_creations SET state=? WHERE receipt=? AND state=?').run(to, receipt, from).changes) === 1;
    });
  }
  identify(receipt: string, thread: string, check: () => boolean): boolean {
    return observedTransaction(this.db, 'codex-creation-change', (_commit, inspect) => {
      const row = this.get(receipt);
      if (!row || row.state !== 'ready') return false;
      const checked = check(); inspect(checked);
      const known = this.db.prepare(`SELECT 1 FROM connector_codex_creations WHERE thread=? AND receipt<>? LIMIT 1`).get(thread, receipt)
        || this.db.prepare(`SELECT 1 FROM command_receipts WHERE state='accepted' AND json_valid(result)
          AND json_extract(result,'$.body.agentId')='codex' AND json_extract(result,'$.body.key')=? LIMIT 1`).get(`codex:${thread}`);
      const allowed = checked && !known;
      if (allowed && row.tools) inspect(this.executions.enrollBoardTools(thread));
      this.db.prepare('UPDATE connector_codex_creations SET thread=?,state=? WHERE receipt=?').run(thread, allowed ? 'identified' : 'blocked', receipt);
      return allowed;
    });
  }
  accept(receipt: string, commit: (db: DatabaseSync, thread: string, inspect: (value: unknown) => void) => void): boolean {
    return observedTransaction(this.db, 'codex-creation-change', (_commit, inspect) => {
      const row = this.get(receipt);
      if (!row || row.state !== 'naming' || !row.thread) return false;
      inspect(commit(this.db, row.thread, inspect));
      this.db.prepare('DELETE FROM connector_codex_creations WHERE receipt=?').run(receipt);
      return true;
    });
  }
  abandon(receipt: string): void {
    // Only an intent which never crossed the native-effect handoff is releasable.
    observedTransaction(this.db, 'codex-creation-change', () => {
      this.db.prepare("DELETE FROM connector_codex_creations WHERE receipt=? AND state='reserved'").run(receipt);
    });
  }
}
