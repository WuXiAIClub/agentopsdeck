import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { assertMigrationPreserved, migrationTableInventory } from './verify-isolated-permissions-migration.mjs';

test('migration inventory includes every legacy table without exposing its contents', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE identities (id TEXT, secret TEXT); CREATE TABLE "odd""name" (value INTEGER);
      INSERT INTO identities VALUES ('a','synthetic-private-key'); INSERT INTO "odd""name" VALUES (1)`);
    const before = migrationTableInventory(db);
    assert.equal(before.length, 2);
    assert.equal(JSON.stringify(before).includes('synthetic-private-key'), false);
    db.exec('CREATE TABLE lifecycle (epoch INTEGER)');
    assertMigrationPreserved(before, migrationTableInventory(db));
    db.exec("UPDATE identities SET secret = 'changed'");
    assert.throws(() => assertMigrationPreserved(before, migrationTableInventory(db)), /Legacy table changed/);
    db.exec('DROP TABLE identities');
    assert.throws(() => assertMigrationPreserved(before, migrationTableInventory(db)), /Legacy table changed/);
  } finally { db.close(); }
});

test('migration row ordering is stable and equal-count modifications still fail', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE values_fixture (id INTEGER); INSERT INTO values_fixture VALUES (2),(1)');
    const before = migrationTableInventory(db);
    db.exec('DELETE FROM values_fixture; INSERT INTO values_fixture VALUES (1),(2)');
    assertMigrationPreserved(before, migrationTableInventory(db));
    db.exec('UPDATE values_fixture SET id = 3 WHERE id = 2');
    assert.throws(() => assertMigrationPreserved(before, migrationTableInventory(db)));
  } finally { db.close(); }
});
