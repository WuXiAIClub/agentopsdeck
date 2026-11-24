import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ClaudeHomeLease } from './home-lease.js';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentopsdeck-claude-lease-')));
  const home = join(root, 'private-home'), file = join(root, 'connector.sqlite'), node = `node_${randomUUID()}`;
  mkdirSync(home, { mode: 0o700 }); writeFileSync(file, '', { mode: 0o600 });
  return { root, home, file, node, acquire: () => ClaudeHomeLease.acquire(home, file, node),
    lock: join(home, '.agentopsdeck-claude-owner'), binding: join(home, '.agentopsdeck-claude-binding'),
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('Claude private HOME has one owner and retains its store binding across clean releases', async () => {
  const f = fixture();
  try {
    const first = f.acquire(); first.assertHeld();
    assert.throws(f.acquire, /ownership is unconfirmed/);
    await first.releaseAfter(async () => {});
    assert.equal(existsSync(f.lock), false); assert.equal(existsSync(f.binding), true);
    assert.throws(() => first.assertHeld(), /ownership is unconfirmed/);
    const second = f.acquire(); second.assertHeld(); await second.releaseAfter(async () => {});
    assert.throws(() => ClaudeHomeLease.acquire(f.home, f.file, `node_${randomUUID()}`), /ownership is unconfirmed/);
    assert.equal(existsSync(f.lock), false, 'rejected acquire does not block the valid owner');
    const third = f.acquire(); await third.releaseAfter(async () => {});
  } finally { f.cleanup(); }
});

test('Claude HOME lease requires canonical private Linux paths and never follows aliases', () => {
  const f = fixture();
  try {
    const alias = join(f.root, 'alias'); symlinkSync(f.home, alias);
    assert.throws(() => ClaudeHomeLease.acquire(alias, f.file, f.node));
    assert.throws(() => ClaudeHomeLease.acquire(f.home, ':memory:', f.node));
    assert.throws(() => ClaudeHomeLease.acquire(f.home, f.file, 'invalid node'));
    chmodSync(f.home, 0o755); assert.throws(f.acquire); chmodSync(f.home, 0o700);
    chmodSync(f.file, 0o644); assert.throws(f.acquire); chmodSync(f.file, 0o600);
    const inner = join(f.home, 'db'); writeFileSync(inner, '', { mode: 0o600 });
    assert.throws(() => ClaudeHomeLease.acquire(f.home, inner, f.node));
    assert.equal(existsSync(f.lock), false);
  } finally { f.cleanup(); }
});

test('Claude HOME abandoned by an exited process is not reclaimed by PID or elapsed time', () => {
  const f = fixture();
  try {
    const source = new URL('./home-lease.js', import.meta.url).href;
    const script = `import { ClaudeHomeLease } from ${JSON.stringify(source)};
      ClaudeHomeLease.acquire(...JSON.parse(process.argv[1])); process.stdout.write('owned');`;
    const child = spawnSync(process.execPath, [...(import.meta.url.endsWith('.ts') ? ['--import', 'tsx'] : []), '--input-type=module', '--eval', script,
      JSON.stringify([f.home, f.file, f.node])], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 10000, encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: f.root, TMPDIR: f.root },
    });
    assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, 'owned');
    assert.equal(existsSync(f.lock), true); assert.throws(f.acquire, /offline recovery/);
  } finally { f.cleanup(); }
});

test('Claude HOME stays fenced until cleanup resolves; close is one-way and idempotent', async () => {
  const f = fixture();
  try {
    const lease = f.acquire(); let done!: () => void;
    const cleanup = new Promise<void>(resolve => { done = resolve; });
    const closed = lease.releaseAfter(() => cleanup);
    assert.equal(lease.releaseAfter(async () => { throw new Error('must not call twice'); }), closed);
    assert.throws(() => lease.assertHeld()); assert.throws(f.acquire);
    done(); await closed;
    const next = f.acquire(); await next.releaseAfter(async () => {});
  } finally { f.cleanup(); }
});

test('Claude HOME cleanup failure is sanitized and leaves a non-expiring fence', async () => {
  const f = fixture();
  try {
    const lease = f.acquire();
    const failed = lease.releaseAfter(async () => { throw new Error('synthetic sensitive native output'); });
    await assert.rejects(failed, error => error instanceof Error && /offline recovery/.test(error.message)
      && !/sensitive/.test(error.message));
    assert.equal(lease.releaseAfter(async () => {}), failed);
    assert.equal(existsSync(f.lock), true); assert.throws(f.acquire);
  } finally { f.cleanup(); }
});

test('Claude HOME replaced owner marker is not removed during cleanup', async () => {
  const f = fixture();
  try {
    const lease = f.acquire(); renameSync(f.lock, join(f.home, 'original-marker'));
    writeFileSync(f.lock, 'replacement', { mode: 0o600 }); let cleaned = false;
    assert.throws(() => lease.assertHeld());
    await assert.rejects(lease.releaseAfter(async () => { cleaned = true; }));
    assert.equal(cleaned, true, 'marker failure must not skip native cleanup');
    assert.equal(readFileSync(f.lock, 'utf8'), 'replacement');
  } finally { f.cleanup(); }
});

test('Claude HOME malformed/symlink bindings are not overwritten or followed', () => {
  const f = fixture();
  try {
    writeFileSync(f.binding, 'x'.repeat(9000), { mode: 0o600 });
    assert.throws(f.acquire); assert.equal(readFileSync(f.binding, 'utf8').length, 9000);
    renameSync(f.binding, join(f.home, 'original-binding'));
    symlinkSync(f.file, f.binding);
    assert.throws(f.acquire); assert.equal(readFileSync(f.file, 'utf8'), '');
    assert.equal(existsSync(f.lock), false);
  } finally { f.cleanup(); }
});

test('Claude HOME lease detects database path replacement without opening another SQLite fd', async () => {
  const f = fixture();
  try {
    const lease = f.acquire();
    renameSync(f.file, join(f.root, 'old-db')); writeFileSync(f.file, '', { mode: 0o600 });
    assert.throws(() => lease.assertHeld());
    await assert.rejects(lease.releaseAfter(async () => {}));
    assert.equal(existsSync(f.lock), true);
  } finally { f.cleanup(); }
});
