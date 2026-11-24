import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertPrivateSqlitePath, assertPrivateSqlitePaths, privateSqliteStatIsValid, PRIVATE_SQLITE_ACL_BATCH_SCRIPT } from './private-sqlite-path.js';
import { PRIVATE_ACL_SCRIPT } from '../connector/windows-private-worker.js';

test('native ACL snapshot is bounded and uses fixed script plus JSON path data', () => {
  assert.ok(PRIVATE_SQLITE_ACL_BATCH_SCRIPT.includes(PRIVATE_ACL_SCRIPT));
  assert.match(PRIVATE_SQLITE_ACL_BATCH_SCRIPT, /ConvertFrom-Json -InputObject \$env:AOD_PRIVATE_SQLITE_PATHS/);
  assert.match(PRIVATE_SQLITE_ACL_BATCH_SCRIPT, /foreach \(\$path in \$paths\)/);
  assert.throws(() => assertPrivateSqlitePaths([]));
  assert.throws(() => assertPrivateSqlitePaths(Array.from({ length: 6 }, () => ({ file: '/not-opened' }))));
  assert.throws(() => assertPrivateSqlitePaths([{ file: 'x'.repeat(4097) }]));
  assert.throws(() => assertPrivateSqlitePaths([{ file: 'x\0y' }]));
});

test('Windows stat policy rejects links and wrong types but never substitutes POSIX ownership for ACL proof', () => {
  const stat = { uid: 0, mode: 0o777, nlink: 1, isSymbolicLink: () => false,
    isFile: () => true, isDirectory: () => false } as Stats;
  assert.equal(privateSqliteStatIsValid(stat, false, 'win32'), true, 'Native ACL verification is still mandatory in the path verifier');
  assert.equal(privateSqliteStatIsValid(stat, false, 'linux', 0), false);
  assert.equal(privateSqliteStatIsValid({ ...stat, mode: 0o600 } as Stats, false, 'linux'), false, 'No uid proof is not authorization');
  assert.equal(privateSqliteStatIsValid({ ...stat, mode: 0o600 } as Stats, false, 'linux', 0), true);
  for (const patch of [{ nlink: 2 }, { isSymbolicLink: () => true }, { isFile: () => false }]) {
    assert.equal(privateSqliteStatIsValid({ ...stat, ...patch } as Stats, false, 'win32'), false);
  }
  assert.equal(privateSqliteStatIsValid(stat, true, 'win32'), false);
  assert.equal(privateSqliteStatIsValid({ ...stat, isDirectory: () => true } as Stats, true, 'win32'), true);
});

test('POSIX private path checks retain ownership, mode, canonical parent and hardlink protections',
  { skip: process.platform === 'win32' }, t => {
    const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-private-sqlite-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'auth.sqlite');
    writeFileSync(file, '', { mode: 0o600 });
    assert.ok(assertPrivateSqlitePath(dir, true).isDirectory());
    assert.ok(assertPrivateSqlitePath(file).isFile());
    chmodSync(file, 0o644); assert.throws(() => assertPrivateSqlitePath(file)); chmodSync(file, 0o600);
    const link = join(dir, 'link'); symlinkSync(file, link); assert.throws(() => assertPrivateSqlitePath(link));
    const hard = join(dir, 'hard'); linkSync(file, hard); assert.throws(() => assertPrivateSqlitePath(file));
    const alias = join(dir, 'alias'); symlinkSync(dir, alias); assert.throws(() => assertPrivateSqlitePath(alias, true));
    chmodSync(dir, 0o755); assert.throws(() => assertPrivateSqlitePath(dir, true));
  });
