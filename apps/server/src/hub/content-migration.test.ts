import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ContentProposalStore } from './content-proposal-store.js';
import { NativeWorkspaceCardFileProjection } from './workspace-card-file-projection.js';
import { WorkspaceBoards } from './workspace-boards.js';
import { WorkspaceCards } from './workspace-cards.js';
import { WorkspaceDrawings } from './workspace-drawings.js';
import { WorkspaceNativeDrawio } from './workspace-native-drawio.js';
import { WorkspaceCardConfigurations } from './workspace-card-configurations.js';
import { SessionNotebooks } from './session-notebooks.js';
import { WorkspaceNativeFileLocks } from './workspace-native-file-locks.js';
import { parseCardFile, serializeCardFile } from '../connector/workspace-file-card-format.js';

function fixture() {
  const db = new DatabaseSync(':memory:');
  const stores = { boards: new WorkspaceBoards(db), cards: new WorkspaceCards(db), drawings: new WorkspaceDrawings(db),
    nativeDrawio: new WorkspaceNativeDrawio(db), configurations: new WorkspaceCardConfigurations(db),
    notebooks: new SessionNotebooks(db), sessionNotebook: () => undefined };
  const projection = new NativeWorkspaceCardFileProjection(db, stores), locks = new WorkspaceNativeFileLocks(db);
  const proposals = new ContentProposalStore(db, text => {
    const parsed = parseCardFile(Buffer.from(serializeCardFile(JSON.parse(text)))); if (!parsed) throw Error('invalid-card');
    return JSON.stringify(parsed.content);
  }, () => true);
  const resource = JSON.stringify(['taskboard', 'default']);
  const write = (revision = 0) => ({ title: 'Owned board', tasks: [], revision, mutationId: randomUUID() });
  return { db, stores, projection, proposals, locks, resource, write };
}
test('native migration freezes ordinary writers and atomically advances destination CAS', () => {
  const f = fixture(); try {
    assert.equal(f.stores.boards.save('owner', 'default', f.write()).status, 'saved');
    const result = f.proposals.migrateNative('owner', f.resource, 1, f.projection);
    assert.equal(result.revision, 0); assert.equal(JSON.parse(result.content).content.title, 'Owned board');
    assert.equal(f.stores.boards.get('owner', 'default').revision, 2);
    assert.equal(f.locks.binding('owner', 'taskboard', 'default'), `v2:${result.epoch}`);
    assert.equal(f.stores.boards.save('owner', 'default', f.write(2)).status, 'file-managed');
    assert.equal(f.projection.claim('owner', f.resource, 'legacy'), false);
    assert.throws(() => f.proposals.migrateNative('owner', f.resource, 2, f.projection), /resource-exists/);
    assert.equal(f.proposals.resource('other', f.resource), undefined);
  } finally { f.db.close(); }
});
test('stale revision, legacy lock, pending notebook move and foreign connection cannot cut over', () => {
  const f = fixture(), other = fixture(); try {
    assert.throws(() => f.proposals.migrateNative('owner', f.resource, 1, f.projection), /revision/);
    assert.equal(f.locks.claim('owner', 'legacy', [{kind:'taskboard',id:'default'}]), true);
    assert.throws(() => f.proposals.migrateNative('owner', f.resource, 0, f.projection), /managed/);
    assert.equal(f.proposals.resource('owner', f.resource), undefined);
    assert.throws(() => f.proposals.migrateNative('owner', f.resource, 0, other.projection), /owning transaction/);
    const note = JSON.stringify(['hub-notebook',1]);
    f.db.prepare('INSERT INTO hub_notebook_bound_moves VALUES(?,?,?,?,?,?,?,?)').run('owner',note,'move','legacy','note','{}','{}','pending');
    assert.throws(() => f.proposals.migrateNative('owner', JSON.stringify(['notebook','hub:default']), 0, f.projection));
    assert.equal(f.stores.notebooks.get('owner',note).revision, 0);
    assert.equal(f.locks.managed('owner','notebook',note), false);
  } finally { f.db.close(); other.db.close(); }
});
test('post-fence validation failure rolls back native CAS and lock, not only content authority', () => {
  const f = fixture(); try {
    const proposals = new ContentProposalStore(f.db, () => { throw Error('invalid-fixture'); }, () => true);
    assert.throws(() => proposals.migrateNative('owner', f.resource, 0, f.projection), /invalid-fixture/);
    assert.equal(f.stores.boards.get('owner','default').revision, 0);
    assert.equal(f.locks.managed('owner','taskboard','default'), false);
    assert.equal(f.db.isTransaction, false);
    assert.equal(f.stores.boards.save('owner','default',f.write()).status,'saved');
  } finally { f.db.close(); }
});
test('outer transaction cannot roll back a visible migration and reopen a second writer', () => {
  const f = fixture(); try {
    f.db.exec('BEGIN');
    assert.throws(() => f.proposals.migrateNative('owner',f.resource,0,f.projection), /outer-transaction/);
    f.db.exec('ROLLBACK'); assert.equal(f.locks.managed('owner','taskboard','default'),false);
  } finally { f.db.close(); }
});
test('migration lost response recovers immutable owner-scoped receipt without repeating native cutover', () => {
  const f = fixture(); try {
    const id = randomUUID();
    assert.equal(f.proposals.migration('owner', id), undefined);
    const receipt = f.proposals.migrateNativeRequest('owner', f.resource, 0, id, f.projection);
    assert.deepEqual(f.proposals.migration('owner', id), receipt);
    assert.deepEqual(f.proposals.migrateNativeRequest('owner', f.resource, 0, id, f.projection), receipt);
    assert.equal(f.stores.boards.get('owner','default').revision, 1);
    assert.equal(f.proposals.migration('other',id), undefined);
    assert.throws(() => f.proposals.migrateNativeRequest('owner', f.resource, 1, id, f.projection), /migration-reused/);
    assert.throws(() => f.proposals.migrateNativeRequest('owner', JSON.stringify(['taskboard','another']), 0, id, f.projection), /migration-reused/);
    assert.throws(() => f.proposals.migrateNativeRequest('owner', f.resource, 1, randomUUID(), f.projection), /resource-exists/);
  } finally { f.db.close(); }
});
test('migration receipt failure rolls back native lock, CAS and authoritative resource together', () => {
  const f = fixture(); try {
    // Create the schema before installing a deterministic failure at the final
    // durable write, after the native fence and resource insert have happened.
    f.proposals.initialize('fixture','unrelated','epoch',JSON.stringify({kind:'taskboard',content:{title:'Fixture',tasks:[]}}));
    f.db.exec("CREATE TRIGGER fail_migration BEFORE INSERT ON v2_content_migrations BEGIN SELECT RAISE(ABORT,'receipt-failure'); END;");
    const id=randomUUID();
    assert.throws(()=>f.proposals.migrateNativeRequest('owner',f.resource,0,id,f.projection),/receipt-failure/);
    assert.equal(f.proposals.resource('owner',f.resource),undefined);
    assert.equal(f.proposals.migration('owner',id),undefined);
    assert.equal(f.stores.boards.get('owner','default').revision,0);
    assert.equal(f.locks.managed('owner','taskboard','default'),false);
    assert.equal(f.db.isTransaction,false);
    f.db.exec('DROP TRIGGER fail_migration');
    assert.ok(f.proposals.migrateNativeRequest('owner',f.resource,0,id,f.projection));
  } finally { f.db.close(); }
});
