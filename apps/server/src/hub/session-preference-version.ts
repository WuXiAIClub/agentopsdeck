import type { DatabaseSync } from 'node:sqlite';
import { observedSavepoint } from '../storage/observed-savepoint.js';

/** Additive persistent generation; legacy applications keep updating it through
 * SQL triggers. No preference scan, normalization, deletion or second writer. */
export function migrateSessionPreferenceVersions(db: DatabaseSync) {
  const bump = (owner: string) => `INSERT INTO hub_session_preference_versions(user_id, version) VALUES (${owner}, 1)
    ON CONFLICT(user_id) DO UPDATE SET version=version+1;`;
  observedSavepoint(db, 'hub-preference-migration', () => db.exec(`
    CREATE TABLE IF NOT EXISTS hub_session_preference_versions (
      user_id TEXT PRIMARY KEY NOT NULL,
      version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991)
    );
    CREATE TRIGGER IF NOT EXISTS hub_session_preference_version_insert AFTER INSERT ON session_preferences
    BEGIN ${bump('NEW.user_id')} END;
    CREATE TRIGGER IF NOT EXISTS hub_session_preference_version_delete AFTER DELETE ON session_preferences
    BEGIN ${bump('OLD.user_id')} END;
    CREATE TRIGGER IF NOT EXISTS hub_session_preference_version_update AFTER UPDATE ON session_preferences
    WHEN ${['user_id', 'session_id', 'hidden', 'archived', 'pinned'].map(c => `OLD.${c} IS NOT NEW.${c}`).join(' OR ')}
    BEGIN
      ${bump('OLD.user_id')}
      INSERT INTO hub_session_preference_versions(user_id, version)
      SELECT NEW.user_id, 1 WHERE OLD.user_id IS NOT NEW.user_id
      ON CONFLICT(user_id) DO UPDATE SET version=version+1;
    END;
  `));
}
