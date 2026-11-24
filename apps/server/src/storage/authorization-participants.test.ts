import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ExecutionGrants, createTurnAuthorizer } from '../connector/execution-grants.js';
import { ContentProposalStore } from '../hub/content-proposal-store.js';
import { observedParticipant } from './observed-participant.js';
import { observedSavepoint } from './observed-savepoint.js';
import { observedTransaction } from './observed-transaction.js';
import { connectionRecoverySnapshot, recoverableConnection, StorageConnectionUnavailable } from './connection-recovery.js';
import { performanceDiagnostics, PerformanceDiagnostics } from '../diagnostics/performance.js';

const binding = { issuerTokenId: 'synthetic', hubId: 'hub', principalId: 'actor', grantKey: 'grant', version: 1,
  runtime: 'codex' as const, sessionKey: 'codex:synthetic' };

for (const outerKind of ['transaction', 'savepoint'] as const) {
  for (const innerKind of ['transaction', 'savepoint'] as const) {
    for (const escape of ['return', 'participant'] as const) {
      test(`direct nested ${innerKind} ${escape} escape rolls back original ${outerKind}`, async () => {
        const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
        db.exec('CREATE TABLE effects(value INTEGER)');
        const statement = db.prepare('INSERT INTO effects VALUES(?)');
        const diagnostics = new PerformanceDiagnostics(() => {});
        let release!: () => void, late: Promise<void> | undefined;
        const held = new Promise<void>(resolve => { release = resolve; });
        const inner = (inspect: (value: unknown) => void) => {
          statement.run(2);
          late = (async () => { await held; statement.run(4); })();
          if (escape === 'participant') inspect(late);
          return late as never;
        };
        const outer = () => {
          statement.run(1);
          assert.throws(() => innerKind === 'transaction'
            ? observedTransaction(db, 'execution-grant-change', (_commit, inspect) => inner(inspect), diagnostics, true)
            : observedSavepoint(db, 'session-share-change', inspect => inner(inspect), diagnostics));
          // A caught inner error must latch the ORIGINAL owner's settlement.
          statement.run(3);
          return true;
        };
        try {
          assert.throws(() => outerKind === 'transaction'
            ? observedTransaction(db, 'execution-grant-change', outer, diagnostics)
            : observedSavepoint(db, 'session-share-change', outer, diagnostics));
          assert.equal(raw.isTransaction, false, 'original rollback must precede facade retirement');
          assert.deepEqual(raw.prepare('SELECT * FROM effects').all(), []);
          assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
          const rejected = assert.rejects(late!, StorageConnectionUnavailable);
          release(); await rejected;
          assert.deepEqual(raw.prepare('SELECT * FROM effects').all(), []);
        } finally { release(); if (late) await late.catch(() => {}); db.close(); }
      });
    }
  }
}

for (const boundary of ['transaction', 'savepoint'] as const) {
  test(`caught direct nested escape fences later nested bodies (${boundary})`, () => {
    const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
    const diagnostics = new PerformanceDiagnostics(() => {});
    let calls = 0;
    const outer = () => {
      assert.throws(() => observedSavepoint(db, 'session-share-change', () => Promise.resolve() as never, diagnostics));
      assert.throws(() => observedTransaction(db, 'execution-grant-change', () => { calls++; }, diagnostics, true));
      assert.throws(() => observedSavepoint(db, 'session-share-change', () => { calls++; }, diagnostics));
    };
    try {
      assert.throws(() => boundary === 'transaction'
        ? observedTransaction(db, 'execution-grant-change', outer, diagnostics)
        : observedSavepoint(db, 'session-share-change', outer, diagnostics));
      assert.equal(calls, 0); assert.equal(raw.isTransaction, false);
      assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
    } finally { db.close(); }
  });
}

for (const boundary of ['standalone', 'transaction', 'savepoint', 'transaction-savepoint', 'savepoint-transaction'] as const) {
  test(`authorization participant rolls back ORIGINAL owner before fencing late SQL (${boundary})`, async () => {
    const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
    db.exec('CREATE TABLE effects(value INTEGER)'); const statement = db.prepare('INSERT INTO effects VALUES(?)');
    let release!: () => void, late!: Promise<boolean>, calls = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    const lines: string[] = [], diagnostics = new PerformanceDiagnostics(line => lines.push(line));
    const hook = () => observedParticipant(db, 'execution-issuer-check', () => {
      calls++; statement.run(3);
      return late = (async () => { await held; statement.run(4); return true; })();
    });
    const inner = () => { statement.run(2); hook(); };
    const outer = () => {
      statement.run(1);
      if (boundary === 'transaction-savepoint') observedSavepoint(db, 'session-share-change', inner, diagnostics);
      else if (boundary === 'savepoint-transaction') observedTransaction(db, 'execution-grant-change', inner, diagnostics, true);
      else inner();
    };
    try {
      assert.throws(() => {
        if (boundary === 'standalone') hook();
        else if (boundary.startsWith('transaction')) observedTransaction(db, 'execution-grant-change', outer, diagnostics);
        else observedSavepoint(db, 'session-share-change', outer, diagnostics);
      }, /must be synchronous/);
      assert.equal(calls, 1); assert.equal(raw.isTransaction, false);
      assert.deepEqual(raw.prepare('SELECT * FROM effects').all(), []);
      assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
      if (boundary !== 'standalone') {
        const events = lines.map(line => JSON.parse(line));
        assert.ok(events.some(event => event.unknown === 1 && event.step === 2 && event.nested === 0));
        assert.ok(events.every(event => event.settled !== 1));
        assert.ok(lines.every(line => !line.includes('INSERT') && !line.includes('effects')));
      }
      const rejected = assert.rejects(late, StorageConnectionUnavailable); release(); await rejected;
      assert.deepEqual(raw.prepare('SELECT * FROM effects').all(), []);
    } finally { release(); if (late) await late.catch(() => {}); db.close(); }
  });
}

test('a caught nested authorization rejection cannot commit outer policy writes', () => {
  const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
  db.exec('CREATE TABLE effects(value INTEGER)');
  try {
    assert.throws(() => observedTransaction(db, 'execution-grant-change', () => {
      db.exec('INSERT INTO effects VALUES(1)');
      assert.throws(() => observedSavepoint(db, 'session-share-change', () => {
        observedParticipant(db, 'node-authority-check', () => Promise.resolve(false));
      }), /must be synchronous/);
      db.exec('INSERT INTO effects VALUES(2)');
      return true;
    }), /must be synchronous/);
    assert.equal(raw.isTransaction, false); assert.deepEqual(raw.prepare('SELECT * FROM effects').all(), []);
    assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
  } finally { db.close(); }
});

test('a caught authority escape cannot invoke a subsequent callback on the same original owner', () => {
  const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw); let calls = 0;
  try {
    assert.throws(() => observedTransaction(db, 'execution-grant-change', () => {
      assert.throws(() => observedParticipant(db, 'execution-issuer-check', () => Promise.resolve(false)), /must be synchronous/);
      assert.throws(() => observedParticipant(db, 'node-authority-check', () => { calls++; return true; }), /must be synchronous/);
      return true;
    }), /must be synchronous/);
    assert.equal(calls, 0); assert.equal(raw.isTransaction, false);
    assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
  } finally { db.close(); }
});

for (const result of ['promise', 'hidden-promise', 'rejected-promise', 'thenable', 'throwing-getter'] as const) {
  test(`standalone authority result rejects ${result} with safe original-owner diagnostics`, () => {
    const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
    db.exec('CREATE TABLE effects(value INTEGER)'); let thenCalls = 0;
    const before = performanceDiagnostics.snapshot().events.at(-1)?.sequence ?? 0;
    try {
      assert.throws(() => observedParticipant(db, 'content-authority-check', () => {
        db.exec('INSERT INTO effects VALUES(1)');
        if (result === 'promise') return Promise.resolve(false);
        if (result === 'rejected-promise') return Promise.reject(Error('synthetic private callback error'));
        if (result === 'hidden-promise') { const value = Promise.resolve(false); Object.defineProperty(value, 'then', { value: undefined }); return value; }
        if (result === 'thenable') return { then: () => { thenCalls++; } };
        return { get then() { throw Error('synthetic private getter error'); } };
      }));
      assert.equal(thenCalls, 0); assert.equal(raw.isTransaction, false);
      assert.deepEqual(raw.prepare('SELECT * FROM effects').all(), []);
      assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
      const event = performanceDiagnostics.snapshot().events.find(event => event.sequence > before && event.operation === 'content-authority-check');
      assert.ok(event); assert.equal(event.unknown, 1); assert.equal(event.step, 2); assert.equal(event.settled, undefined);
      assert.ok(!JSON.stringify(event).includes('synthetic private'));
    } finally { db.close(); }
  });
}

for (const operation of ['issue', 'authorize', 'usage', 'turn-scope', 'content-bind', 'content-read'] as const) {
  test(`runtime Promise cannot become a truthy authorization/usage result (${operation})`, async () => {
    const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
    let enabled = false, release!: () => void, late!: Promise<boolean>, calls = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    db.exec('CREATE TABLE effects(value INTEGER)'); const insert = db.prepare('INSERT INTO effects VALUES(1)');
    const authority = (() => {
      if (!enabled) return true;
      calls++; insert.run(); return late = (async () => { await held; insert.run(); return false; })();
    }) as unknown as () => boolean;
    const grants = new ExecutionGrants(db, authority, () => 1000);
    const ref = operation === 'authorize' || operation === 'usage' ? grants.issue(binding, ['messages:send'], 2000) : undefined;
    const content = new ContentProposalStore(db, text => text, authority);
    content.initialize('owner', 'resource', 'epoch', 'Original');
    const bound = operation === 'content-read' ? content.bind('owner', 'resource', 'binding', 'authority') : undefined;
    try {
      const grantRows = raw.prepare('SELECT * FROM connector_execution_grants').all();
      const contentRows = raw.prepare('SELECT * FROM v2_proposal_bindings').all();
      enabled = operation !== 'usage';
      assert.throws(() => {
        if (operation === 'issue') grants.issue(binding, ['messages:send'], 2000);
        else if (operation === 'authorize') grants.authorize(ref!, binding.issuerTokenId, binding, 'messages:send');
        else if (operation === 'usage') grants.usage([ref!.id], binding.issuerTokenId, binding.hubId, () => { enabled = true; return authority(); });
        else if (operation === 'turn-scope') createTurnAuthorizer(grants, authority)('local:daily', binding, 'messages:send');
        else if (operation === 'content-bind') content.bind('owner', 'resource', 'binding', 'authority');
        else content.bindingRecord('owner', 'resource', bound!.id);
      }, /must be synchronous/);
      assert.equal(calls, 1); assert.equal(raw.isTransaction, false);
      assert.deepEqual(raw.prepare('SELECT * FROM connector_execution_grants').all(), grantRows);
      assert.deepEqual(raw.prepare('SELECT * FROM v2_proposal_bindings').all(), contentRows);
      assert.deepEqual(raw.prepare('SELECT * FROM effects').all(), []);
      assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
      const rejected = assert.rejects(late, StorageConnectionUnavailable); release(); await rejected;
      assert.deepEqual(raw.prepare('SELECT * FROM effects').all(), []);
    } finally { release(); if (late) await late.catch(() => {}); db.close(); }
  });
}

test('only literal true authorizes; settled denial never retires or memoizes authority', () => {
  const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw); let allowed: unknown = true;
  const grants = new ExecutionGrants(db, (() => allowed) as () => boolean, () => 1000);
  try {
    const ref = grants.issue(binding, ['messages:send'], 2000);
    for (const denied of [false, undefined, null, 1, 'true', {}, { then: undefined }]) {
      allowed = denied;
      assert.equal(grants.authorize(ref, binding.issuerTokenId, binding, 'messages:send'), false);
      assert.throws(() => grants.issue({ ...binding, version: 2 }, ['messages:send'], 2000), /not authorized/);
      assert.equal(connectionRecoverySnapshot(db).state, 'ready');
    }
    allowed = true; assert.equal(grants.authorize(ref, binding.issuerTokenId, binding, 'messages:send'), true);
  } finally { db.close(); }
});

test('standalone authority RELEASE lost ACK preserves original error and never replays callback', () => {
  const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
  db.exec('CREATE TABLE effects(value INTEGER)'); const exec = db.exec.bind(db);
  const original = Object.assign(Error('synthetic private release error'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
  let calls = 0;
  db.exec = sql => { exec(sql); if (sql === 'RELEASE execution_issuer_check') throw original; };
  const before = performanceDiagnostics.snapshot().events.at(-1)?.sequence ?? 0;
  try {
    assert.throws(() => observedParticipant(db, 'execution-issuer-check', () => {
      calls++; db.exec('INSERT INTO effects VALUES(1)'); return true;
    }), error => error === original);
    assert.equal(calls, 1); assert.equal(raw.isTransaction, false);
    assert.equal(raw.prepare('SELECT count(*) n FROM effects').get()!.n, 1);
    const event = performanceDiagnostics.snapshot().events.find(event => event.sequence > before && event.operation === 'execution-issuer-check');
    assert.ok(event); assert.equal(event.unknown, 1); assert.equal(event.step, 3); assert.equal(event.sqlErrorCode, 10);
    assert.equal(event.settled, undefined); assert.ok(!JSON.stringify(event).includes('private release'));
  } finally { db.close(); }
});

test('standalone authority rollback failure fences SQL without replaying the rejected callback', () => {
  const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
  db.exec('CREATE TABLE effects(value INTEGER)'); const exec = db.exec.bind(db);
  const original = Error('synthetic private authority error'); let calls = 0, failRollback = true;
  db.exec = sql => { if (sql === 'ROLLBACK' && failRollback) throw Object.assign(Error('private cleanup'), { errcode: 5 }); exec(sql); };
  try {
    assert.throws(() => observedParticipant(db, 'content-authority-check', () => {
      calls++; db.exec('INSERT INTO effects VALUES(1)'); throw original;
    }), error => error === original);
    assert.equal(calls, 1); assert.equal(connectionRecoverySnapshot(db).state, 'owner-rollback-required');
    failRollback = false;
    assert.throws(() => db.prepare('SELECT 1'), StorageConnectionUnavailable);
    assert.equal(connectionRecoverySnapshot(db).state, 'ready'); assert.equal(raw.isTransaction, false);
    assert.equal(db.prepare('SELECT count(*) n FROM effects').get()!.n, 0); assert.equal(calls, 1);
  } finally { db.close(); }
});
