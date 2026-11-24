import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
const compiled = import.meta.url.endsWith('.js');
const target = new URL(compiled ? './observed-savepoint.js' : './observed-savepoint.ts', import.meta.url).href;
function run(body: string) {
  const result = spawnSync(process.execPath, [
    '--unhandled-rejections=strict', ...(compiled ? [] : ['--import', import.meta.resolve('tsx')]),
    '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { DatabaseSync } from 'node:sqlite';
      const module = await import(${JSON.stringify(target)});
      const { observedSavepoint } = module.default ?? module;
      import { recoverableConnection, connectionRecoverySnapshot } from ${JSON.stringify(new URL(compiled ? './connection-recovery.js' : './connection-recovery.ts', import.meta.url).href)};
      ${body}
      await new Promise(done => setImmediate(done));
      console.log('savepoint-rejections-observed');
    `], { cwd: new URL('../../', import.meta.url), encoding: 'utf8', timeout: 15000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, 'denied savepoint work must not crash the server through an unobserved original rejection');
  assert.match(result.stdout, /savepoint-rejections-observed/);
  assert.equal(result.stdout.includes('PRIVATE_REJECTION'), false);
}
for (const nested of [false, true]) test(`savepoint observes repeated original rejections after fencing (nested=${nested})`, () => {
  run(`
    const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
    db.exec('CREATE TABLE evidence(value INTEGER)');
    const body = inspect => {
      db.prepare('INSERT INTO evidence VALUES(1)').run();
      for (const value of [Promise.reject(Error('PRIVATE_REJECTION_FIRST')), Promise.reject(Error('PRIVATE_REJECTION_SECOND'))]) {
        try { inspect(value); } catch {}
      }
      return 1;
    };
    assert.throws(() => observedSavepoint(db, 'hub-identity-change', inspect => {
      ${nested ? "try { observedSavepoint(db, 'auth-audit-append', body); } catch {}" : 'body(inspect);'}
      return 1;
    }), /Savepoint work must be synchronous/);
    assert.equal(raw.isTransaction, false);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM evidence').get().n, 0);
    assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
    db.close();
  `);
});
for (const nested of [false, true]) for (const repeated of [false, true])
  test(`native observation cannot revive a refused savepoint (nested=${nested}, repeated=${repeated})`, () => {
    run(`
      const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
      db.exec('CREATE TABLE evidence(value INTEGER)'); let attempts = 0, admitted = false;
      const body = inspect => {
        db.prepare('INSERT INTO evidence VALUES(1)').run();
        ${repeated ? "try { inspect(Promise.reject(Error('PRIVATE_REJECTION_FIRST'))); } catch {}" : ''}
        const value = Promise.reject(Error('PRIVATE_REJECTION_SECOND'));
        Object.defineProperty(value, 'then', { value: undefined });
        Object.defineProperty(value, 'constructor', { get() {
          attempts++;
          try { observedSavepoint(db, 'auth-audit-list', () => { admitted = true; return 1; }); } catch {}
          return Promise;
        } });
        try { inspect(value); } catch {}
        return 1;
      };
      assert.throws(() => observedSavepoint(db, 'hub-identity-change', inspect => {
        ${nested ? "try { observedSavepoint(db, 'auth-audit-append', body); } catch {}" : 'body(inspect);'}
        return 1;
      }), /Savepoint work must be synchronous/);
      assert.ok(attempts > 0);
      assert.equal(admitted, false);
      assert.equal(raw.isTransaction, false);
      assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM evidence').get().n, 0);
      assert.equal(connectionRecoverySnapshot(db).state, 'close-required'); db.close();
    `);
  });
test('expired savepoint inspection observes rejection without settling a later transaction', () => {
  run(`
    const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw); let inspect;
    observedSavepoint(db, 'hub-identity-change', original => { inspect = original; return 1; });
    db.exec('BEGIN');
    assert.throws(() => inspect(Promise.reject(Error('PRIVATE_REJECTION_EXPIRED'))), /participant callback ended/);
    assert.equal(raw.isTransaction, true);
    assert.equal(connectionRecoverySnapshot(db).state, 'ready');
    db.exec('ROLLBACK'); db.close();
  `);
});
