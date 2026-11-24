import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function run(body: string) {
  const compiled = import.meta.url.endsWith('.js');
  const result = spawnSync(process.execPath, [
    '--unhandled-rejections=strict', ...(compiled ? [] : ['--import', 'tsx']), '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { DatabaseSync } from 'node:sqlite';
      import { observedTransaction } from ${JSON.stringify(new URL(compiled ? './observed-transaction.js' : './observed-transaction.ts', import.meta.url).href)};
      import { recoverableConnection, connectionRecoverySnapshot } from ${JSON.stringify(new URL(compiled ? './connection-recovery.js' : './connection-recovery.ts', import.meta.url).href)};
      import { synchronousAuthorizationCall } from ${JSON.stringify(new URL(compiled ? '../auth/synchronous-authorization.js' : '../auth/synchronous-authorization.ts', import.meta.url).href)};
      ${body}
      await new Promise(done => setImmediate(done));
      console.log('original-rejections-observed');
    `], { cwd: new URL('../../', import.meta.url), encoding: 'utf8', timeout: 15000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, 'a denied participant must not turn a second original Promise rejection into a process-level crash');
  assert.match(result.stdout, /original-rejections-observed/);
  assert.equal(result.stdout.includes('PRIVATE_REJECTION'), false);
}

for (const nested of [false, true]) test(`each escaped native rejection is observed after the original transaction is already fenced (nested: ${nested})`, () => {
  run(`
    const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
    db.exec('CREATE TABLE evidence(value INTEGER)');
    const body = (_commit, inspect) => {
      db.prepare('INSERT INTO evidence VALUES(1)').run();
      for (const value of [Promise.reject(Error('PRIVATE_REJECTION_FIRST')), Promise.reject(Error('PRIVATE_REJECTION_SECOND'))]) {
        try { inspect(value); } catch {}
      }
      return 1;
    };
    assert.throws(() => observedTransaction(db, 'turn-queue-change', (commit, inspect) => {
      ${nested ? "try { observedTransaction(db, 'automation-store-change', body, undefined, true); } catch {}" : 'body(commit, inspect);'}
      try { commit(); } catch {}
      return 1;
    }), /Transaction work must be synchronous/);
    assert.equal(raw.isTransaction, false);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM evidence').get().n, 0);
    assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
    assert.throws(() => db.prepare('SELECT 1'), /recovery required/);
    await new Promise(done => setImmediate(done));
    assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
    db.close();
  `);
});

test('authorization observes the original native rejection even when its participant inspector refuses it', () => {
  run(`
    let inspections = 0;
    const original = Promise.reject(Error('PRIVATE_REJECTION_AUTH'));
    assert.throws(() => synchronousAuthorizationCall(() => original, [], () => {
      inspections++; throw Error('PRIVATE_REJECTION_INSPECTOR');
    }), /auth_persistence_failed/);
    assert.equal(inspections, 1);
  `);
});

test('an expired participant callback observes refusal without acquiring a later transaction', () => {
  run(`
    const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw); let inspect;
    observedTransaction(db, 'turn-queue-change', (_commit, original) => { inspect = original; return 1; });
    db.exec('BEGIN');
    assert.throws(() => inspect(Promise.reject(Error('PRIVATE_REJECTION_EXPIRED'))), /participant callback ended/);
    assert.equal(raw.isTransaction, true, 'expired observation cannot settle the later owner');
    assert.equal(connectionRecoverySnapshot(db).state, 'ready');
    db.exec('ROLLBACK'); db.close();
  `);
});

for (const authorization of [false, true]) for (const repeated of [false, true])
  test(`native rejection observation cannot reenter original commit (authorization: ${authorization}, repeated: ${repeated})`, () => {
    run(`
      const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
      db.exec('CREATE TABLE evidence(value INTEGER)');
      let attempts = 0, committed = false;
      assert.throws(() => observedTransaction(db, 'turn-queue-change', (commit, inspect) => {
        db.prepare('INSERT INTO evidence VALUES(1)').run();
        ${repeated ? "try { inspect(Promise.reject(Error('PRIVATE_REJECTION_FIRST'))); } catch {}" : ''}
        const value = Promise.reject(Error('PRIVATE_REJECTION_REENTRANT'));
        Object.defineProperty(value, 'constructor', { get() {
          attempts++; try { commit(); committed = true; } catch {} return Promise;
        } });
        try {
          ${authorization ? 'synchronousAuthorizationCall(() => value, [], inspect);' : 'inspect(value);'}
        } catch {}
        return 1;
      }), /Transaction work must be synchronous/);
      assert.ok(attempts > 0, 'original rejection must actually be observed');
      assert.equal(committed, false, 'species observation cannot commit original transaction');
      assert.equal(raw.isTransaction, false);
      assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM evidence').get().n, 0);
      assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
      db.close();
    `);
  });
