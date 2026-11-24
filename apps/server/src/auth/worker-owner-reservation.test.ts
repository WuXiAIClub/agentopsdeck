import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthWorkerReservations } from './worker-owner-reservation.js';
import { AuthPersistenceError } from './private-store.js';
function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-auth-owner-admission-'));
  t.after(() => rmSync(directory, { recursive: true }));
  return { directory, file: join(directory, 'auth.sqlite'), gate: new AuthWorkerReservations() };
}
test('same file refuses until original release; release is idempotent', t => {
  const h = fixture(t), release = h.gate.acquire(h.file, () => assert.fail('unexpected refusal'));
  let refusals = 0;
  assert.throws(() => h.gate.acquire(h.file, () => refusals++), AuthPersistenceError);
  assert.equal(refusals, 1); release(); release();
  h.gate.acquire(h.file, () => assert.fail('unexpected refusal'))();
});
test('physical symlink and hard-link aliases cannot bypass admission', t => {
  const h = fixture(t); writeFileSync(h.file, 'offline-fixture');
  const hard = join(h.directory, 'hard.sqlite'), symbolic = join(h.directory, 'symbolic.sqlite');
  linkSync(h.file, hard); symlinkSync(h.file, symbolic);
  const release = h.gate.acquire(h.file, () => {});
  for (const alias of [hard, symbolic, join(h.directory, '.', 'auth.sqlite')])
    assert.throws(() => h.gate.acquire(alias, () => {}), AuthPersistenceError);
  release(); h.gate.acquire(hard, () => {})();
});
test('file created by original worker learns inode without opening a descriptor', t => {
  const h = fixture(t), release = h.gate.acquire(h.file, () => {});
  writeFileSync(h.file, 'offline-fixture'); const alias = join(h.directory, 'alias.sqlite'); linkSync(h.file, alias);
  assert.throws(() => h.gate.acquire(alias, () => {}), AuthPersistenceError);
  release(); h.gate.acquire(alias, () => {})();
});
test('missing directory and existing ancestor symlink remain the same reservation', t => {
  const h = fixture(t), alias = join(h.directory, 'ancestor');
  symlinkSync(h.directory, alias);
  const file = join(h.directory, 'new', 'nested', 'auth.sqlite'), release = h.gate.acquire(file, () => {});
  assert.throws(() => h.gate.acquire(join(alias, 'new', 'nested', 'auth.sqlite'), () => {}), AuthPersistenceError);
  mkdirSync(join(h.directory, 'new', 'nested'), { recursive: true }); writeFileSync(file, 'offline-fixture');
  assert.throws(() => h.gate.acquire(file, () => {}), AuthPersistenceError); release();
});
test('Windows lexical case aliases are conservatively refused (not native host acceptance)', t => {
  const h = fixture(t), gate = new AuthWorkerReservations('win32'), release = gate.acquire(h.file, () => {});
  assert.throws(() => gate.acquire(h.file.toUpperCase(), () => {}), AuthPersistenceError); release();
});
test('diagnostic sink reentrancy cannot recurse, release or admit original owner', t => {
  const h = fixture(t), release = h.gate.acquire(h.file, () => {}); let observations = 0;
  assert.throws(() => h.gate.acquire(h.file, () => {
    observations++;
    assert.throws(() => h.gate.acquire(h.file, () => { observations++; }), AuthPersistenceError);
    throw Error('private-diagnostic-error');
  }), AuthPersistenceError);
  assert.equal(observations, 1);
  assert.throws(() => h.gate.acquire(h.file, () => {}), AuthPersistenceError); release();
});
test('independent files retain independent admission; memory-looking auth names are still files', t => {
  const h = fixture(t), releases = [h.gate.acquire(h.file, () => {}),
    h.gate.acquire(join(h.directory, 'other.sqlite'), () => {}),
    h.gate.acquire(join(h.directory, ':memory:'), () => {})];
  assert.throws(() => h.gate.acquire(join(h.directory, ':memory:'), () => {}), AuthPersistenceError);
  releases.forEach(release => release());
});
test('relative configured path remains bound to admission cwd while learning its inode', t => {
  const h = fixture(t), initial = process.cwd();
  const other = join(h.directory, 'other'); mkdirSync(other);
  try {
    process.chdir(h.directory);
    const release = h.gate.acquire('auth.sqlite', () => {});
    try {
      writeFileSync(h.file, 'offline-fixture');
      const alias = join(h.directory, 'alias.sqlite'); linkSync(h.file, alias);
      process.chdir(other);
      assert.throws(() => h.gate.acquire(alias, () => {}), AuthPersistenceError);
    } finally { release(); }
  } finally { process.chdir(initial); }
});
