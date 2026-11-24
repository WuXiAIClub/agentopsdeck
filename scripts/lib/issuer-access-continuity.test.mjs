import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { continueIssuerAccess, reviewIssuerAccess } from './issuer-access-continuity.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY);
    INSERT INTO users VALUES ('owner'),('member'),('disabled'),('other');
    CREATE TABLE hub_user_access(user_id TEXT PRIMARY KEY,status TEXT,version INTEGER);
    INSERT INTO hub_user_access VALUES ('disabled','disabled',2);
    CREATE TABLE env_connections(id TEXT,owner_user_id TEXT,node_id TEXT,authority_version INTEGER,
      connector_url TEXT,kind TEXT,status TEXT,deleted_at INTEGER);
    INSERT INTO env_connections VALUES ('local','owner','node',6,'local://connector','local','active',NULL);
    CREATE TABLE hub_execution_issuers(owner_id TEXT,connection_id TEXT,node_id TEXT,issuer_id TEXT,
      authority_version INTEGER,connector_url TEXT,kind TEXT,creation_allowed INTEGER,retired INTEGER);
    INSERT INTO hub_execution_issuers VALUES ('owner','local','node','old',6,'local://connector','local',1,0);
    CREATE TABLE connector_memberships(node_owner TEXT,connection_id TEXT,user_id TEXT,role TEXT,
      version INTEGER,node_version INTEGER,environments TEXT);
    INSERT INTO connector_memberships VALUES ('owner','local','member','developer',2,6,'{"codex":"developer","openclaw":"observer"}'),
      ('owner','local','disabled','developer',1,6,'{}');
    CREATE TABLE node_grants(id TEXT PRIMARY KEY,node_owner TEXT,connection_id TEXT,user_id TEXT,
      node_version INTEGER,version INTEGER,runtime TEXT,agent_id TEXT,session_key TEXT,actions TEXT,revoked INTEGER);
    INSERT INTO node_grants VALUES
      ('root','owner','local','member',6,1,'codex',NULL,NULL,'["sessions:create"]',0),
      ('child','owner','local','member',6,1,'codex',NULL,'codex:test','["messages:send","sessions:share"]',0),
      ('revoked','owner','local','member',6,2,'codex',NULL,'codex:old','["messages:read"]',1),
      ('stale','owner','local','member',4,1,'codex',NULL,'codex:stale','["messages:read"]',0),
      ('disabled','owner','local','disabled',6,1,'codex',NULL,NULL,'["sessions:create"]',0),
      ('unrelated','owner','remote','other',6,1,'codex',NULL,NULL,'["sessions:create"]',0);
    CREATE TABLE node_grant_dependencies(child_id TEXT,parent_id TEXT,parent_version INTEGER);
    INSERT INTO node_grant_dependencies VALUES ('child','root',1);
    CREATE TABLE role_grants(grant_id TEXT PRIMARY KEY,source TEXT);
    INSERT INTO role_grants VALUES ('root','creation');
    CREATE TABLE hub_session_owners(node_owner TEXT,connection_id TEXT,node_version INTEGER,session_key TEXT,
      user_id TEXT,grant_id TEXT,command_scope TEXT,command_key TEXT);
    INSERT INTO hub_session_owners VALUES ('owner','local',6,'codex:test','member','child','scope','once');
    CREATE TABLE hub_execution_leases(id TEXT,state TEXT,proof TEXT);
    INSERT INTO hub_execution_leases VALUES ('old','revoking','old-proof');
    CREATE TABLE retained_commands(id TEXT,state TEXT);
    INSERT INTO retained_commands VALUES ('uncertain','unknown');
    CREATE TRIGGER dependency_revoke AFTER UPDATE ON node_grants
      WHEN NEW.version<>OLD.version OR NEW.revoked<>OLD.revoked BEGIN
      UPDATE node_grants SET revoked=1,version=version+1 WHERE id IN
        (SELECT child_id FROM node_grant_dependencies WHERE parent_id=OLD.id); END;
  `);
  const parameters = { ownerId: 'owner', connectionId: 'local', fromVersion: 6, memberIds: ['member'] };
  const review = reviewIssuerAccess(db, parameters);
  const rotate = () => db.exec(`UPDATE env_connections SET authority_version=8;
    UPDATE hub_execution_issuers SET retired=1;
    INSERT INTO hub_execution_issuers VALUES ('owner','local','node','fresh',8,'local://connector','local',1,0);`);
  const apply = (changes = {}) => continueIssuerAccess(db, review, {
    stopped: true, expectedDigest: review.sha256, toVersion: 8, issuerId: 'fresh', ...changes });
  return { db, parameters, review, rotate, apply };
}
const all = (db, table) => db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all().map(row=>({...row}));

test('reviewed reauthorization preserves creator lineage without replay, resurrection or scope changes', t => {
  const f = fixture(t), unchanged = Object.fromEntries(['hub_execution_leases','retained_commands',
    'node_grant_dependencies','role_grants','hub_user_access'].map(table => [table, all(f.db, table)]));
  const old = all(f.db, 'node_grants'); f.rotate();
  const receipt = f.apply();
  assert.equal(receipt.grants, 2); assert.equal(receipt.creatorOwnerships, 1);
  for (const [table, before] of Object.entries(unchanged)) assert.deepEqual(all(f.db,table), before);
  assert.deepEqual(all(f.db,'node_grants'), old.map(row => ['root','child'].includes(row.id) ? {...row,node_version:8} : row));
  assert.equal(all(f.db,'connector_memberships')[0].node_version,8);
  assert.equal(all(f.db,'connector_memberships')[1].node_version,6);
  assert.equal(all(f.db,'hub_session_owners')[0].node_version,8);
  assert.equal(all(f.db,'operator_issuer_access_continuity').length,1);
  assert.throws(() => f.apply());
});

for (const [name, sql] of [
  ['membership role', "UPDATE connector_memberships SET role='observer' WHERE user_id='member'"],
  ['membership epoch', "UPDATE connector_memberships SET version=3 WHERE user_id='member'"],
  ['runtime ceiling', "UPDATE connector_memberships SET environments='{}' WHERE user_id='member'"],
  ['account disable', "INSERT INTO hub_user_access VALUES ('member','disabled',1)"],
  ['account restore epoch', "INSERT INTO hub_user_access VALUES ('member','enabled',2)"],
  ['grant revocation', "UPDATE node_grants SET revoked=1 WHERE id='child'"],
  ['grant policy', "UPDATE node_grants SET actions='[\"messages:read\"]' WHERE id='child'"],
  ['dependency epoch', 'UPDATE node_grant_dependencies SET parent_version=2'],
  ['creator identity', "UPDATE hub_session_owners SET user_id='other'"],
  ['new grant', "INSERT INTO node_grants SELECT 'new',node_owner,connection_id,user_id,node_version,version,runtime,agent_id,session_key,actions,revoked FROM node_grants WHERE id='root'"],
  ['node identity', "UPDATE env_connections SET node_id='replacement'"],
  ['origin', "UPDATE env_connections SET connector_url='http://elsewhere'"],
  ['disabled connection', "UPDATE env_connections SET status='disabled'"],
  ['fresh issuer', "UPDATE hub_execution_issuers SET issuer_id='impostor' WHERE authority_version=8"],
  ['unretired old issuer', 'UPDATE hub_execution_issuers SET retired=0 WHERE authority_version=6'],
]) test('refuses changed '+name+' atomically', t => {
  const f=fixture(t); f.rotate(); f.db.exec(sql);
  const before = ['connector_memberships','node_grants','hub_session_owners'].map(table => all(f.db,table));
  assert.throws(() => f.apply());
  assert.deepEqual(['connector_memberships','node_grants','hub_session_owners'].map(table => all(f.db,table)),before);
});

for (const changes of [{stopped:false},{expectedDigest:'0'.repeat(64)},{toVersion:7},{toVersion:9},{issuerId:'old'}])
  test('refuses missing stopped/reviewed rotation proof '+JSON.stringify(changes),t=>{
    const f=fixture(t);f.rotate();assert.throws(()=>f.apply(changes));
    assert.equal(all(f.db,'connector_memberships')[0].node_version,6);
  });

test('storage failure rolls back every reauthorization row', t=>{
  const f=fixture(t);f.rotate();f.db.exec(`CREATE TRIGGER refuse_owner BEFORE UPDATE ON hub_session_owners
    BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END;`);
  assert.throws(()=>f.apply());
  assert.equal(all(f.db,'connector_memberships')[0].node_version,6);
  assert.equal(all(f.db,'node_grants').find(row=>row.id==='child').node_version,6);
});

test('cycles, stale parents and disabled members never enter a review',t=>{
  const f=fixture(t);
  assert.throws(()=>reviewIssuerAccess(f.db,{...f.parameters,memberIds:['disabled']}));
  f.db.exec("INSERT INTO node_grant_dependencies VALUES ('root','child',1)");
  assert.throws(()=>reviewIssuerAccess(f.db,f.parameters));
});

test('owner workspace board and card file bindings follow reviewed issuer rotation without reviving revoked bindings', t => {
  const f = fixture(t);
  f.db.exec(`
    CREATE TABLE hub_workspace_board_file_bindings(
      binding_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, resource_id TEXT NOT NULL,
      session_id TEXT NOT NULL, connection_id TEXT NOT NULL, authority INTEGER NOT NULL,
      state TEXT NOT NULL, source_hash TEXT, problem TEXT, created_at INTEGER NOT NULL);
    INSERT INTO hub_workspace_board_file_bindings VALUES
      ('b-active', 'owner', 'default', 'local:s1', 'local', 6, 'active', 'h1', 'invalid', 10),
      ('b-revoked', 'owner', 'other', 'local:s2', 'local', 6, 'revoked', 'h2', NULL, 11),
      ('b-stale', 'owner', 'stale', 'local:s3', 'local', 4, 'active', 'h3', NULL, 12);
    CREATE TABLE hub_workspace_card_file_bindings(
      binding_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, resource_id TEXT NOT NULL,
      session_id TEXT NOT NULL, connection_id TEXT NOT NULL, authority INTEGER NOT NULL,
      state TEXT NOT NULL, source_hash TEXT, problem TEXT, created_at INTEGER NOT NULL);
    INSERT INTO hub_workspace_card_file_bindings VALUES
      ('c-active', 'owner', 'notebook:n1', 'local:s1', 'local', 6, 'active', 'ch1', NULL, 20);
  `);
  const review = reviewIssuerAccess(f.db, f.parameters);
  assert.equal(review.boardFileBindings.length, 1);
  assert.equal(review.cardFileBindings.length, 1);
  f.rotate();
  // Concurrent background problem/hash sync should not invalidate reviewed authority identity,
  // while state changes must fail closed.
  f.db.exec("UPDATE hub_workspace_board_file_bindings SET problem=NULL WHERE binding_id='b-active'");
  const receipt = continueIssuerAccess(f.db, review, {
    stopped: true, expectedDigest: review.sha256, toVersion: 8, issuerId: 'fresh',
  });
  assert.equal(receipt.boardFileBindings, 1);
  assert.equal(receipt.cardFileBindings, 1);
  assert.deepEqual(
    f.db.prepare('SELECT binding_id, authority, state FROM hub_workspace_board_file_bindings ORDER BY binding_id').all().map(r => ({ ...r })),
    [
      { binding_id: 'b-active', authority: 8, state: 'active' },
      { binding_id: 'b-revoked', authority: 6, state: 'revoked' },
      { binding_id: 'b-stale', authority: 4, state: 'active' },
    ]
  );
  assert.deepEqual(
    f.db.prepare('SELECT binding_id, authority, state FROM hub_workspace_card_file_bindings ORDER BY binding_id').all().map(r => ({ ...r })),
    [{ binding_id: 'c-active', authority: 8, state: 'active' }]
  );
});
