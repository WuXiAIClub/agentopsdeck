import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCandidateFailureDiagnostic, hasTurnBoundAssistantReply, parseProcessStat,
  processTerminationProof, readProcessIdentity, sanitizeApiErrorSummary, snapshotProcessOwnership,
  verifyCandidateShutdown } from './verify-candidate-http-codex.mjs';
import { hasTurnBoundFileBoardReply } from './verify-candidate-file-boards.mjs';

const fixtureHomes = ['HOME=/synthetic/home', 'CODEX_HOME=/synthetic/native'];
const failure = code => Object.assign(new Error('synthetic omitted payload'), { code });
function statText({ pid = 40, parent = 1, start = '100', state = 'S', name = 'fixture' } = {}) {
  const fields = [state, String(parent), ...Array(17).fill('0'), start];
  return `${pid} (${name}) ${fields.join(' ')}\n`;
}

function fixture({ exited = false, exitCode = 0 } = {}) {
  const processes = new Map();
  if (!exited) processes.set(40, { pid: 40, parent: 1, start: '100', environment: fixtureHomes[0] + '\0' });
  processes.set(41, { pid: 41, parent: 40, start: '101', environment: '' });
  const lifetime = { pid: 40, start: '100', closed: exited, ...(exited ? { code: exitCode, signal: null } : {}) };
  const calls = [];
  const child = { pid: 40, exitCode: exited ? exitCode : null, signalCode: null,
    kill(signal) {
      calls.push(['kill', signal]);
      processes.delete(40);
      child.exitCode = exitCode;
      Object.assign(lifetime, { closed: true, code: exitCode, signal: null });
      return true;
    } };
  let onPoll = () => {};
  const options = {
    child, lifetime, closed: Promise.resolve(lifetime), fixtureHomes,
    async readDirectory(directory) {
      assert.equal(directory, '/proc');
      calls.push(['directory', child.exitCode]);
      return [...processes.keys()].map(String);
    },
    async readText(filename, encoding) {
      assert.equal(encoding, 'utf8');
      calls.push(['read', filename]);
      const match = filename.match(/^\/proc\/(\d+)\/(stat|environ)$/);
      assert.ok(match, 'Only injected synthetic proc reads are allowed');
      const process = processes.get(Number(match[1]));
      if (!process) throw failure('ENOENT');
      return match[2] === 'stat' ? statText(process) : process.environment;
    },
    async wait(label, check, timeout) {
      assert.equal(timeout, label === 'graceful server shutdown' ? 120000 : 10000);
      calls.push(['wait', label]);
      for (let index = 0; index < 3; index++) {
        if (label === 'native descendants exit') await onPoll(index);
        const result = await check();
        if (result) return result;
      }
      throw failure('SYNTHETIC_TIMEOUT');
    },
  };
  return { options, processes, lifetime, calls, poll(callback) { onPoll = callback; } };
}

function assertUnknown(value) {
  assert.equal(value.lifetime.shutdownProof, 'unknown');
  assert.equal(Object.hasOwn(value.lifetime, 'descendantsExited'), false);
  assert.equal(value.calls.filter(call => call[0] === 'directory').length >= 2, true,
    'Failure must not bypass the post-shutdown rescan');
}

test('offline import exposes helpers without entering candidate/provider main', () => {
  assert.equal(typeof verifyCandidateShutdown, 'function');
  assert.equal(typeof snapshotProcessOwnership, 'function');
});

test('stat parser keeps exact PID/start identity across parentheses and spaces in comm', () => {
  assert.deepEqual(parseProcessStat(statText({ name: 'fixture ) ( child', start: '90071992547409930' }), 40),
    { pid: 40, parent: 1, start: '90071992547409930', state: 'S' });
});

for (const [name, text] of [
  ['empty', ''], ['wrong PID', statText({ pid: 41 })], ['short fields', '40 (fixture) S 1 100'],
  ['invalid state', statText({ state: '?' })], ['negative parent', statText({ parent: -1 })],
  ['fractional parent', statText({ parent: 1.5 })], ['unsafe parent', statText({ parent: '9007199254740993' })],
  ['missing start', statText({ start: '' })], ['nonnumeric start', statText({ start: 'unknown' })],
  ['negative start', statText({ start: '-1' })], ['missing delimiter', statText().replace(') S', ')S')],
  ['invalid intermediate field', statText().replace(' S 1 0 ', ' S 1 invalid ')],
  ['invalid trailing field', statText().trimEnd() + ' invalid\n'],
  ['oversized', statText({ name: 'x'.repeat(8192) })], ['nontext', null],
]) test(`malformed ${name} stat is unknown, never a replaced process`, () => {
  assert.throws(() => parseProcessStat(text, 40), { code: 'ERR_INVALID_PROC_STAT' });
});

test('only stat ENOENT establishes absence', async () => {
  assert.equal(await readProcessIdentity(40, async () => { throw failure('ENOENT'); }), undefined);
  assert.deepEqual(await processTerminationProof({ pid: 40, start: '100' }, async () => { throw failure('ENOENT'); }),
    { pid: 40, start: '100', reason: 'absent' });
});

for (const code of ['EACCES', 'EIO', 'ENOTDIR']) test(`${code} stat read rejects stop proof`, async () => {
  await assert.rejects(processTerminationProof({ pid: 40, start: '100' }, async () => { throw failure(code); }), { code });
});

test('validated different start proves replacement, not same live PID absence', async () => {
  assert.deepEqual(await processTerminationProof({ pid: 40, start: '100' }, async () => statText({ start: '101' })),
    { pid: 40, start: '100', reason: 'identity-replaced' });
  assert.equal(await processTerminationProof({ pid: 40, start: '100' }, async () => statText()), undefined);
});

test('zombie is explicit non-executing proof, not claimed proc disappearance', async () => {
  assert.deepEqual(await processTerminationProof({ pid: 40, start: '100' }, async () => statText({ state: 'Z' })),
    { pid: 40, start: '100', reason: 'zombie' });
});

test('malformed current or expected identity cannot prove PID replacement', async () => {
  await assert.rejects(processTerminationProof({ pid: 40, start: '100' }, async () => '40 (fixture) S 1'),
    { code: 'ERR_INVALID_PROC_STAT' });
  await assert.rejects(processTerminationProof({ pid: 40, start: '' }, async () => statText()),
    { code: 'ERR_INVALID_PROC_STAT' });
});

for (const code of ['EACCES', 'EIO']) {
  for (const part of ['stat', 'environ']) test(`${code} initial ${part} inspection retains unknown but still shuts down/rescans`, async () => {
    const value = fixture();
    const readText = value.options.readText;
    value.options.readText = async (filename, encoding) => {
      if (filename === `/proc/41/${part}` && value.options.child.exitCode === null) throw failure(code);
      return readText(filename, encoding);
    };
    value.poll(() => value.processes.delete(41));
    await assert.rejects(verifyCandidateShutdown(value.options), { code: 'ERR_PROCESS_STOP_UNKNOWN' });
    assertUnknown(value);
    assert.deepEqual(value.calls.filter(call => call[0] === 'kill'), [['kill', 'SIGTERM']]);
    assert.ok(value.lifetime.shutdownUnknown.some(item => item.code === code));
  });
  test(`${code} proc directory failure still shuts down and attempts rescan`, async () => {
    const value = fixture();
    value.options.readDirectory = async () => { value.calls.push(['directory']); throw failure(code); };
    await assert.rejects(verifyCandidateShutdown(value.options), { code: 'ERR_PROCESS_STOP_UNKNOWN' });
    assertUnknown(value);
    assert.ok(value.calls.some(call => call[0] === 'kill'));
  });
  test(`${code} descendant recheck is unknown even after successful ownership snapshots`, async () => {
    const value = fixture();
    const readText = value.options.readText;
    let reads = 0;
    value.options.readText = async (filename, encoding) => {
      if (filename === '/proc/41/stat' && ++reads === 5) throw failure(code);
      return readText(filename, encoding);
    };
    await assert.rejects(verifyCandidateShutdown(value.options), { code: 'ERR_PROCESS_STOP_UNKNOWN' });
    assertUnknown(value);
    assert.ok(value.lifetime.shutdownUnknown.some(item => item.operation === 'descendant-identity' && item.code === code));
  });
}

test('malformed initial stat retains unknown through a later clean rescan', async () => {
  const value = fixture();
  const readText = value.options.readText;
  value.options.readText = async (filename, encoding) => filename === '/proc/41/stat' && value.options.child.exitCode === null
    ? '41 (fixture) S 40' : readText(filename, encoding);
  value.poll(() => value.processes.delete(41));
  await assert.rejects(verifyCandidateShutdown(value.options), { code: 'ERR_PROCESS_STOP_UNKNOWN' });
  assertUnknown(value);
  assert.ok(value.lifetime.shutdownUnknown.some(item => item.code === 'ERR_INVALID_PROC_STAT'));
});

test('malformed descendant recheck is not a different-start termination proof', async () => {
  const value = fixture();
  const readText = value.options.readText;
  let reads = 0;
  value.options.readText = async (filename, encoding) => filename === '/proc/41/stat' && ++reads === 5
    ? '41 (fixture) S 40' : readText(filename, encoding);
  await assert.rejects(verifyCandidateShutdown(value.options), { code: 'ERR_PROCESS_STOP_UNKNOWN' });
  assertUnknown(value);
  assert.ok(value.lifetime.shutdownUnknown.some(item => item.operation === 'descendant-identity'));
});

test('environ ENOENT requires a positive stat absence or replacement recheck', async () => {
  const value = fixture();
  const readText = value.options.readText;
  value.options.readText = async (filename, encoding) => {
    if (filename === '/proc/41/environ') throw failure('ENOENT');
    return readText(filename, encoding);
  };
  const snapshot = await snapshotProcessOwnership(fixtureHomes, value.options);
  assert.ok(snapshot.unknown.some(item => item.pid === 41 && item.code === 'ENOENT'));
  value.options.readText = async (filename, encoding) => {
    if (filename === '/proc/41/environ') { value.processes.delete(41); throw failure('ENOENT'); }
    return readText(filename, encoding);
  };
  const gone = await snapshotProcessOwnership(fixtureHomes, value.options);
  assert.deepEqual(gone.unknown, []);
  assert.equal(gone.processes.some(item => item.pid === 41), false);
  value.processes.set(41, { pid: 41, parent: 40, start: '101', environment: '' });
  value.options.readText = async (filename, encoding) => {
    if (filename === '/proc/41/environ') { value.processes.get(41).start = '102'; throw failure('ENOENT'); }
    return readText(filename, encoding);
  };
  const replaced = await snapshotProcessOwnership(fixtureHomes, value.options);
  assert.deepEqual(replaced.unknown, []);
  assert.equal(replaced.processes.some(item => item.pid === 41), false);
});

for (const code of ['EACCES', 'EIO']) test(`environ ENOENT followed by stat ${code} cannot prove disappearance`, async () => {
  const value = fixture();
  const readText = value.options.readText;
  let environmentMissing = false;
  value.options.readText = async (filename, encoding) => {
    if (filename === '/proc/41/environ') { environmentMissing = true; throw failure('ENOENT'); }
    if (filename === '/proc/41/stat' && environmentMissing) throw failure(code);
    return readText(filename, encoding);
  };
  const snapshot = await snapshotProcessOwnership(fixtureHomes, value.options);
  assert.ok(snapshot.unknown.some(item => item.pid === 41 && item.code === code));
});

test('proc directory ENOENT is unavailable inspection, not proof of all processes absent', async () => {
  const snapshot = await snapshotProcessOwnership(fixtureHomes, {
    async readDirectory() { throw failure('ENOENT'); },
    async readText() { assert.fail('No process reads after directory failure'); },
  });
  assert.deepEqual(snapshot, { processes: [], unknown: [{ operation: 'proc-directory', code: 'ENOENT' }] });
});

test('identity change around environ cannot bind stale fixture ownership to a new PID', async () => {
  const value = fixture();
  const readText = value.options.readText;
  value.options.readText = async (filename, encoding) => {
    const text = await readText(filename, encoding);
    if (filename === '/proc/41/environ') value.processes.get(41).start = '102';
    return text;
  };
  const snapshot = await snapshotProcessOwnership(fixtureHomes, value.options);
  assert.ok(snapshot.unknown.some(item => item.code === 'ERR_PROCESS_IDENTITY_CHANGED'));
  assert.equal(snapshot.processes.some(item => item.pid === 41), false);
});

test('malformed environment and proc directory observations fail closed', async () => {
  const value = fixture();
  value.processes.get(41).environment = 'HOME=/synthetic/home';
  assert.ok((await snapshotProcessOwnership(fixtureHomes, value.options)).unknown.some(item => item.code === 'ERR_PROC_ENVIRONMENT'));
  value.options.readDirectory = async () => null;
  assert.ok((await snapshotProcessOwnership(fixtureHomes, value.options)).unknown.some(item => item.code === 'ERR_INVALID_PROC_STAT'));
});

test('clean shutdown waits for recorded child ENOENT before verified receipt', async () => {
  const value = fixture();
  value.poll(index => { if (index === 1) value.processes.delete(41); });
  await verifyCandidateShutdown(value.options);
  assert.equal(value.lifetime.shutdownProof, 'verified');
  assert.deepEqual(value.lifetime.descendantsExited.sort(), [40, 41]);
  assert.equal(value.lifetime.terminationProofs.every(proof => proof.reason === 'absent'), true);
  assert.equal(value.calls.filter(call => call[0] === 'directory').length, 3);
});

test('post-shutdown rescan adds new reparented fixture-owned process and waits', async () => {
  const value = fixture();
  value.poll(index => {
    value.processes.delete(41);
    if (index === 0) value.processes.set(42, { pid: 42, parent: 1, start: '102', environment: fixtureHomes[1] + '\0' });
    else value.processes.delete(42);
  });
  await verifyCandidateShutdown(value.options);
  assert.deepEqual(value.lifetime.descendantsExited.sort(), [40, 41, 42]);
});

test('live descendant timeout remains unknown and retains exact identities', async () => {
  const value = fixture();
  await assert.rejects(verifyCandidateShutdown(value.options), { code: 'SYNTHETIC_TIMEOUT' });
  assertUnknown(value);
  assert.deepEqual(value.lifetime.remainingDescendants, [41]);
  assert.ok(value.lifetime.shutdownDescendants.some(item => item.pid === 41 && item.start === '101'));
});

test('already exited nonzero server does not bypass generation verification or rescan', async () => {
  const value = fixture({ exited: true, exitCode: 1 });
  value.processes.delete(41);
  await assert.rejects(verifyCandidateShutdown(value.options), { code: 'ERR_PROCESS_STOP_UNKNOWN' });
  assertUnknown(value);
  assert.equal(value.calls.some(call => call[0] === 'kill'), false);
  assert.ok(value.lifetime.shutdownUnknown.some(item => item.operation === 'server-shutdown'));
});

test('already closed zero server still detects an orphaned fixture child', async () => {
  const value = fixture({ exited: true });
  Object.assign(value.processes.get(41), { parent: 1, environment: fixtureHomes[0] + '\0' });
  await assert.rejects(verifyCandidateShutdown(value.options), { code: 'SYNTHETIC_TIMEOUT' });
  assertUnknown(value);
  assert.deepEqual(value.lifetime.remainingDescendants, [41]);
});

test('validated reused root PID does not claim or signal the foreign replacement family', async () => {
  const value = fixture({ exited: true });
  value.processes.set(40, { pid: 40, parent: 1, start: '999', environment: '' });
  await verifyCandidateShutdown(value.options);
  assert.equal(value.calls.some(call => call[0] === 'kill'), false);
  assert.deepEqual(value.lifetime.descendantsExited, [40]);
  assert.deepEqual(value.lifetime.terminationProofs, [{ pid: 40, start: '100', reason: 'identity-replaced' }]);
});

test('unknown evidence stays sticky across repeated shutdown attempts', async () => {
  const value = fixture({ exited: true });
  value.processes.clear();
  value.lifetime.shutdownUnknown = [{ operation: 'proc-process', pid: 41, code: 'EIO' }];
  value.lifetime.descendantsExited = [40];
  await assert.rejects(verifyCandidateShutdown(value.options), { code: 'ERR_PROCESS_STOP_UNKNOWN' });
  assertUnknown(value);
  assert.equal(value.lifetime.shutdownUnknown[0].code, 'EIO');
});

test('signal request failure does not bypass rescan or produce a stop receipt', async () => {
  const value = fixture();
  value.options.child.kill = () => false;
  await assert.rejects(verifyCandidateShutdown(value.options), { code: 'ERR_PROCESS_STOP_UNKNOWN' });
  assertUnknown(value);
});

test('server close timeout still rescans and cannot infer stopped from elapsed time', async () => {
  const value = fixture();
  value.options.child.kill = () => true;
  await assert.rejects(verifyCandidateShutdown(value.options), { code: 'ERR_PROCESS_STOP_UNKNOWN' });
  assertUnknown(value);
  assert.equal(value.lifetime.closed, false);
  assert.ok(value.lifetime.shutdownUnknown.some(item => item.operation === 'server-shutdown'));
});

test('sanitizeApiErrorSummary permits only bounded error codes and redacts arbitrary payloads', () => {
  assert.equal(sanitizeApiErrorSummary(undefined), 'none');
  assert.equal(sanitizeApiErrorSummary(null), 'none');
  assert.equal(sanitizeApiErrorSummary('session_busy'), 'session_busy');
  assert.equal(sanitizeApiErrorSummary({ code: 'ERR_RATE_LIMIT' }), 'ERR_RATE_LIMIT');
  assert.equal(sanitizeApiErrorSummary('Bearer secret-token-123 at /private/workspace/state'), 'redacted-error');
  assert.equal(sanitizeApiErrorSummary({ message: 'provider payload dump', code: 'bad code with spaces' }), 'redacted-error');
});

test('formatCandidateFailureDiagnostic scrubs secrets, paths, URLs, and arbitrary cleanup messages', () => {
  const secretKey = 'a'.repeat(48);
  const assertionError = new assert.AssertionError({
    message: `POST /api/auth/login failed with key=${secretKey} Bearer secret_abc123456 at /srv/private/runtime/db.sqlite and https://user:pw@example.test/v1?key=123`,
  });
  const formattedAssertion = formatCandidateFailureDiagnostic(assertionError, 'login-step', [secretKey, '/srv/private/runtime']);
  assert.equal(formattedAssertion.name, 'AssertionError');
  assert.equal(formattedAssertion.message.includes(secretKey), false);
  assert.equal(formattedAssertion.message.includes('secret_abc123456'), false);
  assert.equal(formattedAssertion.message.includes('/srv/private/runtime'), false);
  assert.equal(formattedAssertion.message.includes('pw@'), false);
  assert.ok(formattedAssertion.message.length <= 200);

  const cleanupError = Object.assign(
    new Error(`provider raw payload ${secretKey} /opt/secret/tree`),
    { code: 'ECONNRESET' },
  );
  const formattedCleanup = formatCandidateFailureDiagnostic(cleanupError, 'cleanup', [secretKey]);
  assert.deepEqual(formattedCleanup, { name: 'Error', message: 'cleanup: Error (ECONNRESET)' });
});

test('turn-bound assistant reply helpers reject stale historical replies across runs and restarts', () => {
  const staleAndWrongHistory = [
    { id: 'msg-1', role: 'assistant', turnId: 'turn-1', text: 'JADE_47' },
    { id: 'msg-2', role: 'assistant', turnId: 'turn-2', text: 'WRONG_OUTPUT' },
  ];
  assert.equal(hasTurnBoundAssistantReply(staleAndWrongHistory, {
    turnId: 'turn-2',
    marker: 'JADE_47',
    priorMessageIds: new Set(['msg-1']),
  }), false);
  assert.equal(hasTurnBoundFileBoardReply(staleAndWrongHistory, {
    turnId: 'turn-2',
    marker: 'JADE_47',
    priorMessageIds: new Set(['msg-1']),
  }), false);

  const matchingNewTurn = [
    ...staleAndWrongHistory,
    { id: 'msg-3', role: 'assistant', turnId: 'turn-3', text: 'RESTART_JADE_47' },
  ];
  assert.equal(hasTurnBoundAssistantReply(matchingNewTurn, {
    turnId: 'turn-3',
    marker: 'RESTART_JADE_47',
    priorMessageIds: new Set(['msg-1', 'msg-2']),
  }), true);

  const fallbackWithoutTurnId = [
    { id: 'msg-old', role: 'assistant', text: 'FILE_BOARD_FIRST_OK' },
    { id: 'msg-new', role: 'assistant', text: 'Completed: FILE_BOARD_SECOND_OK' },
  ];
  assert.equal(hasTurnBoundFileBoardReply(fallbackWithoutTurnId, {
    turnId: 'turn-second',
    marker: 'FILE_BOARD_FIRST_OK',
    priorMessageIds: new Set(['msg-old']),
  }), false);
  assert.equal(hasTurnBoundFileBoardReply(fallbackWithoutTurnId, {
    turnId: 'turn-second',
    marker: 'FILE_BOARD_SECOND_OK',
    priorMessageIds: new Set(['msg-old']),
  }), true);
  assert.equal(hasTurnBoundFileBoardReply([
    { id: 'msg-failed', role: 'assistant', turnId: 'turn-second', status: 'failed', text: 'FILE_BOARD_SECOND_OK' },
  ], {
    turnId: 'turn-second',
    marker: 'FILE_BOARD_SECOND_OK',
    priorMessageIds: new Set(),
  }), false);
});
