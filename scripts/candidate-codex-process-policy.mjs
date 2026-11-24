import assert from 'node:assert/strict';

/** The isolated verifier permits metadata and app-server initialization only. */
export function assertCandidateCodexProcess(method, arguments_, { command, home, nativeHome }) {
  const [target, args, options] = arguments_;
  assert.equal(target, command);
  assert.equal(options?.env?.CODEX_HOME, nativeHome);
  assert.equal(options?.env?.HOME, home);
  assert.equal(options?.shell, false);
  if (method === 'execFile') {
    assert.deepEqual(args, ['features', 'list'], 'Only read-only CLI feature metadata may be probed');
    assert.equal(options.timeout, 3000);
    assert.equal(options.maxBuffer, 64 * 1024);
  } else {
    assert.equal(method, 'spawn', 'Only the existing Codex app-server may be launched');
    assert.ok(Array.isArray(args));
    assert.equal(args.at(-1), 'app-server');
  }
}
