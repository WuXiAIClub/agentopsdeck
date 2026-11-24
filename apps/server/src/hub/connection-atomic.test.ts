import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubStore } from './hub-store.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';

const input = { id: 'synthetic-node', label: 'before', connectorUrl: 'http://synthetic.invalid', credentialToken: 'synthetic-before' };
type Action = 'create' | 'update' | 'rename' | 'delete' | 'maintenance';
const actions: Action[] = ['create', 'update', 'rename', 'delete', 'maintenance'];
function change(store: HubStore, action: Action) {
  switch (action) {
    case 'create': return store.upsertConnection(input);
    case 'update': return store.upsertConnection({ ...input, label: 'after', credentialToken: 'synthetic-after' });
    case 'rename': return store.renameConnection(input.id, { label: 'after' });
    case 'delete': return store.deleteConnection(input.id);
    case 'maintenance': return store.updateMaintenanceCredential(input.id, 'synthetic-maintenance');
  }
}
function snapshot(store: HubStore) {
  return JSON.stringify({ connection: store.getConnection(input.id), version: store.connectionAuthority(input.id),
    credential: store.getCredentialToken(input.id), maintenance: store.getMaintenanceCredentialToken(input.id),
    audit: (store as any).db.prepare('SELECT * FROM audit_logs ORDER BY id').all() });
}
function lastObservation() {
  return performanceDiagnostics.snapshot().events.filter(event => event.operation === 'hub-connection-change').at(-1)!;
}

for (const action of ['create', 'update', 'rename', 'delete', 'maintenance'] as const) {
  test(`connection ${action} must not partially apply when audit insert fails`, async () => {
    const store = new HubStore(':memory:', 'synthetic');
    const db = (store as any).db;
    const input = { id: 'synthetic-node', label: 'before', connectorUrl: 'http://synthetic.invalid', credentialToken: 'synthetic-before' };
    try {
      if (action !== 'create') store.upsertConnection(input);
      const before = JSON.stringify(store.getConnection(input.id));
      const version = store.connectionAuthority(input.id);
      const audits = db.prepare('SELECT count(*) AS n FROM audit_logs').get().n;
      db.exec("CREATE TEMP TRIGGER synthetic_audit_failure BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END");
      assert.throws(() => {
        switch (action) {
          case 'create': return store.upsertConnection(input);
          case 'update': return store.upsertConnection({ ...input, label: 'after', credentialToken: 'synthetic-after' });
          case 'rename': return store.renameConnection(input.id, { label: 'after' });
          case 'delete': return store.deleteConnection(input.id);
          case 'maintenance': return store.updateMaintenanceCredential(input.id, 'synthetic-maintenance');
        }
      }, /synthetic audit failure/);
      assert.equal(JSON.stringify(store.getConnection(input.id)), before);
      assert.equal(store.connectionAuthority(input.id), version);
      assert.equal(store.getCredentialToken(input.id), action === 'create' ? undefined : 'synthetic-before');
      assert.equal(store.getMaintenanceCredentialToken(input.id), undefined);
      assert.equal(db.prepare('SELECT count(*) AS n FROM audit_logs').get().n, audits);
      assert.equal(db.isTransaction, false);
    } finally { await store.close(); }
  });
}

for (const action of actions) {
  for (const failure of ['release-before', 'release-after', 'rollback'] as const) {
    test(`connection ${action} retains original ${failure} outcome without replay`, async () => {
      const store = new HubStore(':memory:', 'synthetic'), db = (store as any).db;
      const exec = db.exec.bind(db), audit = (store as any).appendAudit.bind(store);
      const original = Error('synthetic-original-private-error');
      let releases = 0, audits = 0;
      try {
        if (action !== 'create') store.upsertConnection(input);
        const before = snapshot(store);
        (store as any).appendAudit = (...args: unknown[]) => {
          audits++; audit(...args);
          if (failure === 'rollback') throw original;
        };
        db.exec = (sql: string) => {
          if (sql === 'RELEASE hub_connection_write') {
            releases++;
            if (failure === 'release-after') exec(sql);
            throw original;
          }
          if (sql === 'ROLLBACK' && failure === 'rollback') throw Error('synthetic-secondary-error');
          return exec(sql);
        };
        assert.throws(() => change(store, action), error => error === original);
        const observation = lastObservation();
        assert.equal(observation.category, 'failed');
        assert.equal(observation.unknown, 1);
        assert.equal(observation.step, failure === 'rollback' ? 2 : 3);
        assert.equal(observation.nested, 0);
        assert.equal(releases, failure === 'rollback' ? 0 : 1);
        if (failure === 'rollback') {
          assert.equal(observation.rollbackFailed, 1);
          assert.equal(store.storageRecovery().state, 'owner-rollback-required');
        }
        // Restore the original owner, not a replacement connection. Next-access
        // recovery may roll back the old transaction but must not replay writes.
        db.exec = exec;
        if (failure === 'rollback') {
          assert.throws(() => snapshot(store), /recovery required/);
          assert.equal(store.storageRecovery().state, 'ready');
        }
        const after = snapshot(store);
        assert.equal(after === before, failure !== 'release-after');
        assert.equal(audits, (action === 'create' || action === 'update') && failure !== 'rollback' ? 2 : 1);
        assert.equal(store.storageRecovery().state, 'ready');
        const text = JSON.stringify(observation);
        for (const secret of ['synthetic-original-private-error', 'synthetic-secondary-error', 'synthetic-before', 'synthetic-after', 'synthetic-node'])
          assert.equal(text.includes(secret), false);
      } finally { db.exec = exec; (store as any).appendAudit = audit; await store.close(); }
    });
  }

  test(`connection ${action} remains part of its enclosing transaction`, async () => {
    const store = new HubStore(':memory:', 'synthetic'), db = (store as any).db;
    try {
      if (action !== 'create') store.upsertConnection(input);
      const before = snapshot(store);
      db.exec('BEGIN');
      change(store, action);
      assert.equal(db.isTransaction, true);
      assert.notEqual(snapshot(store), before);
      db.exec('ROLLBACK');
      assert.equal(snapshot(store), before);
    } finally { if (db.isTransaction) db.exec('ROLLBACK'); await store.close(); }
  });

  test(`connection ${action} audit failure preserves enclosing owner work`, async () => {
    const store = new HubStore(':memory:', 'synthetic'), db = (store as any).db;
    try {
      if (action !== 'create') store.upsertConnection(input);
      const before = snapshot(store);
      db.exec("CREATE TEMP TRIGGER synthetic_audit_failure BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END");
      db.exec("BEGIN; UPDATE users SET label='synthetic-outer' WHERE id='default'");
      assert.throws(() => change(store, action), /synthetic audit failure/);
      assert.equal(db.isTransaction, true);
      assert.equal(db.prepare("SELECT label FROM users WHERE id='default'").get().label, 'synthetic-outer');
      assert.equal(snapshot(store), before);
      assert.equal(lastObservation().nested, 1);
      assert.equal(lastObservation().step, 2);
      db.exec('ROLLBACK');
    } finally { if (db.isTransaction) db.exec('ROLLBACK'); await store.close(); }
  });
}

for (const participant of ['storeCredential', 'appendAudit'] as const) {
  test(`connection refuses an asynchronous ${participant} before any settlement`, async () => {
    const store = new HubStore(':memory:', 'synthetic'), db = (store as any).db;
    const original = (store as any)[participant].bind(store);
    const exec = db.exec.bind(db);
    let releases = 0;
    try {
      db.exec = (sql: string) => { if (sql === 'RELEASE hub_connection_write') releases++; return exec(sql); };
      (store as any)[participant] = (...args: unknown[]) => {
        original(...args); return Promise.reject(Error('synthetic-private-rejection'));
      };
      assert.throws(() => store.upsertConnection(input), /synchronous/);
      assert.equal(releases, 0);
      assert.equal(store.storageRecovery().state, 'close-required');
      assert.equal(lastObservation().unknown, 1);
      assert.throws(() => store.getConnection(input.id), /recovery required/);
      await new Promise(resolve => setImmediate(resolve));
    } finally { db.exec = exec; (store as any)[participant] = original; await store.close(); }
  });
}

for (const action of actions) {
  for (const outcome of ['success', 'body-failure', 'ack-failure'] as const) {
    test(`connection ${action} ${outcome} survives same-data owner reopen`, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-connection-atomic-'));
      const file = join(directory, 'hub.sqlite');
      let store = new HubStore(file, 'synthetic');
      try {
        if (action !== 'create') store.upsertConnection(input);
        const before = snapshot(store), db = (store as any).db, exec = db.exec.bind(db);
        const original = Error('synthetic-private-ack-error');
        if (outcome === 'body-failure') db.exec("CREATE TEMP TRIGGER synthetic_audit_failure BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END");
        if (outcome === 'ack-failure') db.exec = (sql: string) => {
          const result = exec(sql);
          if (sql === 'RELEASE hub_connection_write') throw original;
          return result;
        };
        try {
          if (outcome === 'success') change(store, action);
          else assert.throws(() => change(store, action), error => outcome === 'ack-failure'
            ? error === original : /synthetic audit failure/.test(String(error)));
        } finally { db.exec = exec; }
        assert.equal(db.isTransaction, false);
        const settled = snapshot(store);
        assert.equal(settled === before, outcome === 'body-failure');
        await store.close();
        store = new HubStore(file, 'synthetic');
        assert.equal(snapshot(store), settled, 'reopen reads original durable effects without retrying the mutation');
        assert.equal(store.storageRecovery().state, 'ready');
      } finally { await store.close(); rmSync(directory, { recursive: true, force: true }); }
    });
  }
}

test('remote deletion removes both scoped credentials without affecting other owners or local connections', async () => {
  const store = new HubStore(':memory:', 'synthetic');
  try {
    store.upsertConnection(input);
    store.updateMaintenanceCredential(input.id, 'synthetic-maintenance');
    store.createUser('Other');
    const other = store.listUsers().find(user => user.id !== 'default')!;
    store.upsertConnection({ ...input, ownerUserId: other.id });
    store.updateMaintenanceCredential(input.id, 'synthetic-other-maintenance', other.id);
    store.upsertConnection({ ...input, id: 'synthetic-local', kind: 'local' });
    store.updateMaintenanceCredential('synthetic-local', 'synthetic-local-maintenance');
    assert.equal(store.deleteConnection('synthetic-local'), false);
    assert.equal(store.getMaintenanceCredentialToken('synthetic-local'), 'synthetic-local-maintenance');
    assert.equal(store.deleteConnection(input.id), true);
    assert.equal(store.getCredentialToken(input.id), undefined);
    assert.equal(store.getMaintenanceCredentialToken(input.id), undefined);
    assert.equal(store.getCredentialToken(input.id, other.id), 'synthetic-before');
    assert.equal(store.getMaintenanceCredentialToken(input.id, other.id), 'synthetic-other-maintenance');
  } finally { await store.close(); }
});

test('rejected deletion restores daily and maintenance credentials with the original authority', async () => {
  const store = new HubStore(':memory:', 'synthetic');
  try {
    store.upsertConnection(input);
    store.updateMaintenanceCredential(input.id, 'synthetic-maintenance');
    const before = snapshot(store), db = (store as any).db;
    db.exec("CREATE TEMP TRIGGER synthetic_audit_failure BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END");
    assert.throws(() => store.deleteConnection(input.id), /synthetic audit failure/);
    assert.equal(snapshot(store), before);
  } finally { await store.close(); }
});

test('reopening and recreating a deleted alias never resurrects its maintenance credential', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-connection-deletion-'));
  const file = join(directory, 'hub.sqlite');
  let store = new HubStore(file, 'synthetic');
  try {
    store.upsertConnection(input);
    store.updateMaintenanceCredential(input.id, 'synthetic-maintenance');
    const authority = store.connectionAuthority(input.id)!;
    assert.equal(store.deleteConnection(input.id), true);
    await store.close();
    store = new HubStore(file, 'synthetic');
    assert.equal(store.getConnection(input.id), undefined);
    assert.equal(store.getMaintenanceCredentialToken(input.id), undefined);
    store.upsertConnection({ ...input, credentialToken: 'synthetic-new-daily' });
    assert.ok(store.connectionAuthority(input.id)! > authority);
    assert.equal(store.getCredentialToken(input.id), 'synthetic-new-daily');
    assert.equal(store.getMaintenanceCredentialToken(input.id), undefined);
  } finally { await store.close(); rmSync(directory, { recursive: true, force: true }); }
});
