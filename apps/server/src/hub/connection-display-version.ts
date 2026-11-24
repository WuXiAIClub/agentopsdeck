import type { DatabaseSync } from 'node:sqlite';
import { observedSavepoint } from '../storage/observed-savepoint.js';

const changedDirectories = new WeakSet<object>();
/** A completed readonly snapshot crossed an original-writer generation.
 * Only this refusal permits another directory read; SQL/owner/transaction
 * failures with the same public message are not recovery evidence. */
export class ConnectionDirectoryChanged extends Error {
  constructor() { super('hub_delivery_read_unavailable'); changedDirectories.add(this); }
}
export function isConnectionDirectoryChanged(error: unknown): boolean {
  return typeof error === 'object' && error !== null && changedDirectories.has(error);
}

/** Display invalidation only, never command authorization. The original SQLite
 * writer owns these triggers, including older binaries and other handles.
 * Versions roll back with facts and survive deletion/recreation (no ABA).
 * Unrelated journal/Goal writes cannot invalidate the connection directory. */
export function migrateConnectionDisplayVersions(db: DatabaseSync) {
  const bump = (owner: string) => `
    INSERT INTO hub_connection_display_versions(user_id, version) VALUES (${owner}, 1)
    ON CONFLICT(user_id) DO UPDATE SET version = version + 1;`;
  const credentialBump = (row: 'OLD' | 'NEW') => `
    INSERT INTO hub_connection_display_versions(user_id, version)
    SELECT owner_user_id, 1 FROM env_connections
    WHERE id = ${row}.connection_id AND owner_user_id = ${row}.owner_user_id AND deleted_at IS NULL
    ON CONFLICT(user_id) DO UPDATE SET version = version + 1;`;
  // One atomic, idempotent migration. No scan/copy of existing connection rows,
  // no writer handoff, no credential contents read into application memory.
  observedSavepoint(db, 'hub-connection-display-migration', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hub_connection_display_versions (
        user_id TEXT PRIMARY KEY NOT NULL,
        version INTEGER NOT NULL CHECK(typeof(version) = 'integer' AND version BETWEEN 1 AND 9007199254740991)
      );
      CREATE TRIGGER IF NOT EXISTS hub_connection_display_insert AFTER INSERT ON env_connections
      BEGIN ${bump('NEW.owner_user_id')} END;
      CREATE TRIGGER IF NOT EXISTS hub_connection_display_delete AFTER DELETE ON env_connections
      BEGIN ${bump('OLD.owner_user_id')} END;
      CREATE TRIGGER IF NOT EXISTS hub_connection_display_update AFTER UPDATE ON env_connections
      WHEN ${['id', 'owner_user_id', 'kind', 'label', 'connector_url', 'status', 'node_id',
        'environment_id', 'environment_label', 'capabilities_json', 'created_at', 'updated_at', 'deleted_at']
        .map(column => `OLD.${column} IS NOT NEW.${column}`).join(' OR ')}
      BEGIN
        ${bump('OLD.owner_user_id')}
        INSERT INTO hub_connection_display_versions(user_id, version)
        SELECT NEW.owner_user_id, 1 WHERE OLD.owner_user_id IS NOT NEW.owner_user_id
        ON CONFLICT(user_id) DO UPDATE SET version = version + 1;
      END;
      CREATE TABLE IF NOT EXISTS hub_connection_authority_versions (
        user_id TEXT PRIMARY KEY NOT NULL,
        version INTEGER NOT NULL CHECK(typeof(version) = 'integer' AND version BETWEEN 1 AND 9007199254740991)
      );
      CREATE TRIGGER IF NOT EXISTS hub_connection_authority_version_update
        AFTER UPDATE OF authority_version ON env_connections
      WHEN OLD.authority_version IS NOT NEW.authority_version
      BEGIN
        INSERT INTO hub_connection_authority_versions(user_id, version) VALUES (OLD.owner_user_id, 1)
        ON CONFLICT(user_id) DO UPDATE SET version = version + 1;
        INSERT INTO hub_connection_authority_versions(user_id, version)
        SELECT NEW.owner_user_id, 1 WHERE OLD.owner_user_id IS NOT NEW.owner_user_id
        ON CONFLICT(user_id) DO UPDATE SET version = version + 1;
      END;
      CREATE TRIGGER IF NOT EXISTS hub_connection_credential_display_insert AFTER INSERT ON env_credentials
      BEGIN ${credentialBump('NEW')} END;
      CREATE TRIGGER IF NOT EXISTS hub_connection_credential_display_delete AFTER DELETE ON env_credentials
      BEGIN ${credentialBump('OLD')} END;
      CREATE TRIGGER IF NOT EXISTS hub_connection_credential_display_update AFTER UPDATE ON env_credentials
      WHEN OLD.connection_id IS NOT NEW.connection_id OR OLD.owner_user_id IS NOT NEW.owner_user_id
      BEGIN ${credentialBump('OLD')} ${credentialBump('NEW')} END;
    `);
  });
}

export const CONNECTION_DISPLAY_VERSION_SQL = 'SELECT version FROM hub_connection_display_versions WHERE user_id = ?';
