import type { DatabaseSync } from 'node:sqlite';
import { observedSavepoint } from '../storage/observed-savepoint.js';

const BUCKET = 1024;
type Runtime = 'claude-code' | 'ghcp' | 'antigravity';
const config = {
  'claude-code': { table: 'claude_transcript_messages', index: 'claude_transcript_block_counts', size: 'json_array_length(data)' },
  ghcp: { table: 'copilot_transcript_messages', index: 'copilot_transcript_page', size: '1' },
  antigravity: { table: 'antigravity_transcript_messages', index: 'antigravity_transcript_page', size: '1' },
} as const;

/** Transactional display counts, NOT execution/readiness facts. One small row
 * per session per 1024 native sequences: latest reads sum bucket integers;
 * cursor reads sum older buckets plus at most 1024 rows in the boundary bucket.
 * This avoids an O(history rows) scan per viewer, including older-page counts.
 * Uses only the existing owning connection; no second live DB connection.
 * All identifiers/expressions below are fixed source constants, not user SQL. */
export class TranscriptCounts {
  constructor(private readonly db: DatabaseSync, private readonly runtime: Runtime) {
    const { table, index, size } = config[runtime];
    const value = (prefix: string) => size === '1' ? '1' : `json_array_length(${prefix}.data)`;
    const add = (prefix: string) => `INSERT INTO sdk_transcript_counts(runtime,session_key,bucket,blocks)
      VALUES ('${runtime}',${prefix}.session_key,${prefix}.sequence / ${BUCKET},${value(prefix)})
      ON CONFLICT(runtime,session_key,bucket) DO UPDATE SET blocks=blocks+excluded.blocks;`;
    const subtract = `UPDATE sdk_transcript_counts SET blocks=blocks-${value('OLD')}
      WHERE runtime='${runtime}' AND session_key=OLD.session_key AND bucket=OLD.sequence / ${BUCKET};
      DELETE FROM sdk_transcript_counts WHERE runtime='${runtime}' AND session_key=OLD.session_key
        AND bucket=OLD.sequence / ${BUCKET} AND blocks=0;`;
    observedSavepoint(db, 'sdk-transcript-counts-install', () => {
      db.exec(`CREATE TABLE IF NOT EXISTS sdk_transcript_counts (
          runtime TEXT NOT NULL, session_key TEXT NOT NULL, bucket INTEGER NOT NULL,
          blocks INTEGER NOT NULL CHECK(typeof(blocks)='integer' AND blocks>=0),
          PRIMARY KEY(runtime,session_key,bucket)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS sdk_transcript_counts_bootstrap(runtime TEXT PRIMARY KEY NOT NULL);
        CREATE TRIGGER IF NOT EXISTS ${table}_count_insert AFTER INSERT ON ${table}
          BEGIN ${add('NEW')} END;
        CREATE TRIGGER IF NOT EXISTS ${table}_count_delete AFTER DELETE ON ${table}
          BEGIN ${subtract} END;
        CREATE TRIGGER IF NOT EXISTS ${table}_count_update AFTER UPDATE OF session_key,sequence,data ON ${table}
          BEGIN ${subtract} ${add('NEW')} END;`);
      // The explicit marker gates the entire GROUP BY, not just its inserts.
      // Empty databases bootstrap once too. Installation/backfill/marker share
      // a savepoint, including when the caller already owns a transaction.
      if (!db.prepare('SELECT 1 FROM sdk_transcript_counts_bootstrap WHERE runtime=?').get(runtime)) {
        db.prepare('DELETE FROM sdk_transcript_counts WHERE runtime=?').run(runtime);
        db.exec(`INSERT INTO sdk_transcript_counts(runtime,session_key,bucket,blocks)
          SELECT '${runtime}',session_key,sequence / ${BUCKET},sum(${size})
          FROM ${table} INDEXED BY ${index} GROUP BY session_key,sequence / ${BUCKET}`);
        db.prepare('INSERT INTO sdk_transcript_counts_bootstrap VALUES (?)').run(runtime);
      }
    });
  }

  count(key: string, before?: number): number {
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new Error('Invalid transcript count boundary');
    const row = before === undefined
      ? this.db.prepare('SELECT coalesce(sum(blocks),0) AS total FROM sdk_transcript_counts WHERE runtime=? AND session_key=?')
        .get(this.runtime, key)
      : this.db.prepare('SELECT coalesce(sum(blocks),0) AS total FROM sdk_transcript_counts WHERE runtime=? AND session_key=? AND bucket<?')
        .get(this.runtime, key, Math.floor(before / BUCKET));
    let total = Number(row!.total);
    if (before !== undefined && before % BUCKET !== 0) {
      const { table, index, size } = config[this.runtime];
      total += Number(this.db.prepare(`SELECT coalesce(sum(${size}),0) AS total FROM ${table} INDEXED BY ${index}
        WHERE session_key=? AND sequence>=? AND sequence<?`)
        .get(key, Math.floor(before / BUCKET) * BUCKET, before)!.total);
    }
    if (!Number.isSafeInteger(total) || total < 0) throw new Error('Invalid transcript display count');
    return total;
  }
}
