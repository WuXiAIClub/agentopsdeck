import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('./verify-candidate-member-permissions.mjs', import.meta.url), 'utf8');
const cleanup = source.slice(source.lastIndexOf('} finally {') + '} finally {'.length, source.lastIndexOf('}'));

function stat(pid, parent, start, state = 'S') {
  const fields = Array(20).fill('0');
  fields[0] = state; fields[1] = String(parent); fields[19] = String(start);
  return `${pid} (synthetic process (name)) ${fields.join(' ')}`;
}

async function teardown(options = {}) {
  const calls = [], result = { passed: true, errors: options.originalError ? ['Original verification failed'] : [] };
  if (options.originalError) result.passed = false;
  const missing = () => Object.assign(new Error('synthetic missing process'), { code: 'ENOENT' });
  const denied = () => Object.assign(new Error('synthetic unreadable process'), { code: 'EACCES' });
  let draining = false, evidence;
  const sandbox = {
    assert, join, directory: '/synthetic/fixture', result, process: {},
    exit: options.alreadyExited ? { code: 0, signal: null } : undefined,
    browser: { close() {
      calls.push('browser-close');
      if (options.browserSynchronous) throw new Error('synthetic private browser error');
      if (options.browserReject !== false) return Promise.reject(new Error('synthetic private browser error'));
    } },
    child: { pid: 100, kill(signal) {
      calls.push(`signal:${signal}`);
      if (options.signalReject) throw new Error('synthetic signal failure');
      if (!options.originalTimeout) sandbox.exit = { code: options.exitCode ?? 0, signal: null };
      return true;
    } },
    readdir: async path => {
      assert.equal(path, '/proc'); calls.push('collect');
      if (options.collectionReject) throw denied();
      return ['100', '101', '102', '200'];
    },
    readFile: async path => {
      const match = path.match(/^\/proc\/(\d+)\/(stat|environ)$/);
      assert.ok(match, 'Only synthetic proc reads are allowed');
      const pid = Number(match[1]);
      if (options.collectionUnknown && !draining && pid === 200) throw denied();
      if (match[2] === 'environ') return pid === 100 ? 'HOME=/synthetic/fixture/home\0' : '';
      if (options.collectionMalformed && !draining && pid === 101) return 'malformed synthetic stat';
      if (draining) {
        if (options.drainMalformed && pid === 101) return 'malformed synthetic stat';
        if (options.drainUnknown && pid === 101) throw denied();
        if (options.descendantTimeout && pid === 101) return stat(101, 1, 1001);
        if (pid === 102) return stat(102, 1, 9999);
        if (pid === 101) return stat(101, 1, 1001, 'Z');
        throw missing();
      }
      return stat(pid, pid === 101 ? 100 : pid === 102 ? 101 : 1, pid + 900);
    },
    until: async (label, check, timeout) => {
      calls.push(label);
      assert.equal(timeout, label === 'graceful stop' ? 120000 : 10000);
      if (label === 'fixture descendants exit') draining = true;
      const value = await check();
      if (!value) throw new Error('Synthetic timeout, not physical stop');
      return value;
    },
    writeFile: async (file, text, options) => {
      calls.push('evidence'); assert.equal(file, '/synthetic/fixture/result.json');
      assert.equal(options.mode, 0o600); evidence = JSON.parse(text);
    },
    console: { log(text) {
      calls.push('diagnostic'); assert.deepEqual(JSON.parse(text), evidence);
    } },
  };
  await runInNewContext(`(async () => { ${cleanup} })()`, sandbox);
  assert.equal(calls.at(-2), 'evidence'); assert.equal(calls.at(-1), 'diagnostic');
  assert.doesNotMatch(JSON.stringify(evidence), /synthetic private|HOME=|CODEX_HOME=/);
  return { calls, evidence, exitCode: sandbox.process.exitCode };
}

for (const browserSynchronous of [false, true]) {
  test(`browser close failure preserves original exit, descendant identity drain and evidence (sync=${browserSynchronous})`, async () => {
    const { calls, evidence, exitCode } = await teardown({ browserSynchronous });
    assert.equal(evidence.passed, false);
    assert.equal(exitCode, 1);
    assert.deepEqual(evidence.errors, ['Browser cleanup failed']);
    assert.ok(calls.indexOf('signal:SIGTERM') > calls.indexOf('browser-close'));
    assert.equal(evidence.originalExitProven, true);
    assert.equal(evidence.descendantDrainProven, true);
    assert.deepEqual(evidence.remainingDescendants, []);
    assert.deepEqual(evidence.trackedDescendants, [
      { pid: 100, parent: 1, start: '1000' }, { pid: 101, parent: 100, start: '1001' },
      { pid: 102, parent: 101, start: '1002' },
    ]);
    assert.deepEqual(evidence.descendantsExited, [100, 101, 102]);
  });
}

test('normal browser teardown preserves successful independently proven cleanup', async () => {
  const { evidence, exitCode } = await teardown({ browserReject: false });
  assert.equal(evidence.passed, true); assert.equal(exitCode, undefined);
  assert.equal(evidence.originalExitProven, true); assert.equal(evidence.descendantDrainProven, true);
});

test('original host timeout cannot skip an independently provable descendant drain or claim host stop', async () => {
  const { evidence, calls } = await teardown({ originalTimeout: true });
  assert.equal(evidence.originalExitProven, false);
  assert.equal(evidence.descendantDrainProven, true);
  assert.equal(evidence.passed, false);
  assert.ok(calls.includes('fixture descendants exit'));
  assert.ok(!Object.hasOwn(evidence, 'exit'));
});

test('nonzero original exit retains its identity evidence and still attempts descendant drain', async () => {
  const { evidence } = await teardown({ exitCode: 2 });
  assert.deepEqual(evidence.exit, { code: 2, signal: null });
  assert.equal(evidence.originalExitProven, true);
  assert.equal(evidence.descendantDrainProven, true);
  assert.equal(evidence.passed, false);
});

for (const options of [{ descendantTimeout: true }, { drainUnknown: true }, { drainMalformed: true }]) {
  test(`unproven descendant drain remains failed and retains original tracked identities (${Object.keys(options)[0]})`, async () => {
    const { evidence, exitCode, calls } = await teardown(options);
    assert.equal(evidence.descendantDrainProven, false);
    assert.equal(evidence.passed, false); assert.equal(exitCode, 1);
    assert.ok(evidence.remainingDescendants.includes(101));
    assert.ok(!Object.hasOwn(evidence, 'descendantsExited'));
    assert.deepEqual(calls.filter(call => call.startsWith('signal:')), ['signal:SIGTERM']);
  });
}

for (const options of [{ collectionReject: true }, { collectionUnknown: true }, { collectionMalformed: true }]) {
  test(`ownership collection failure does not skip the original host or fabricate descendant stop (${Object.keys(options)[0]})`, async () => {
    const { evidence, calls } = await teardown(options);
    assert.ok(calls.includes('signal:SIGTERM'));
    assert.equal(evidence.originalExitProven, true);
    assert.equal(evidence.descendantDrainProven, false);
    assert.ok(!Object.hasOwn(evidence, 'descendantsExited'));
    assert.equal(evidence.passed, false);
  });
}

test('original signal rejection still attempts both original exit and descendant observations', async () => {
  const { evidence, calls } = await teardown({ signalReject: true });
  assert.ok(calls.includes('graceful stop')); assert.ok(calls.includes('fixture descendants exit'));
  assert.equal(evidence.originalExitProven, false); assert.equal(evidence.passed, false);
});

test('already proven original exit does not signal a replacement or erase the first verification failure', async () => {
  const { evidence, calls } = await teardown({ alreadyExited: true, originalError: true });
  assert.equal(evidence.errors[0], 'Original verification failed');
  assert.equal(evidence.originalExitProven, true); assert.equal(evidence.descendantDrainProven, true);
  assert.ok(!calls.some(call => call.startsWith('signal:')));
  assert.equal(evidence.passed, false);
});
