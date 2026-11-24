import type { DatabaseSync } from 'node:sqlite';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { observedTransaction } from '../storage/observed-transaction.js';

/** Sole-writer startup only. Additive scalar indexes deliberately avoid JSON
 * expressions: an unrelated malformed legacy binding must not make startup
 * rewrite, discard or newly refuse existing sessions. All DDL is one original
 * transaction/savepoint, never a second writer or an asynchronous SQL facade. */
export function initializeSqliteAuthSchema(db: DatabaseSync,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics): void {
  observedTransaction(db, 'auth-passkey-schema', () => {
    db.exec(`CREATE TABLE IF NOT EXISTS shared_auth_credentials(id TEXT PRIMARY KEY,payload TEXT NOT NULL,version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS shared_auth_challenges(digest TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,expires INTEGER NOT NULL,claim TEXT);
      CREATE TABLE IF NOT EXISTS shared_auth_sessions(digest TEXT PRIMARY KEY,binding TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS shared_auth_audit(seq INTEGER PRIMARY KEY,kind TEXT NOT NULL,identity TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS shared_auth_limits(id INTEGER PRIMARY KEY CHECK(id=1),window INTEGER NOT NULL,count INTEGER NOT NULL,observed INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS shared_auth_challenges_expires ON shared_auth_challenges(expires);
      CREATE INDEX IF NOT EXISTS shared_auth_challenges_kind_expires ON shared_auth_challenges(kind,expires);
      CREATE INDEX IF NOT EXISTS shared_auth_sessions_expires ON shared_auth_sessions(expires);`);
  }, diagnostics, true);
}
