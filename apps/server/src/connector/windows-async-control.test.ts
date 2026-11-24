import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { windowsAsyncControl } from './windows-async-control.js';

test('Windows async control yields, pins executable and never inherits secrets/PATH', async t => {
  let finish!: () => void;
  const mock = t.mock.method(cp, 'execFile', ((file: string, args: string[], options: any, callback: any) => {
    assert.equal(file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.deepEqual(options.env, { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', AOD_SECRET_DIRECTORY: 'C:\\用户\\private' });
    assert.equal(options.timeout, 10_000);
    assert.equal(options.maxBuffer, 8192);
    assert.equal(options.windowsHide, true);
    assert.match(Buffer.from(args.at(-1)!, 'base64').toString('utf16le'), /OutputEncoding/);
    finish = () => callback(null, '', '');
    return {};
  }) as any);
  syncBuiltinESMExports();
  try {
    let settled = false;
    const pending = windowsAsyncControl("[Console]::Write('synthetic')", { AOD_SECRET_DIRECTORY: 'C:\\用户\\private' },
      { SystemRoot: 'C:\\Windows', PATH: 'untrusted', SYNTHETIC_SECRET: 'not-inherited' }).then(() => { settled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'unrelated IO proceeds before the control process finishes');
    finish(); await pending;
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

for (const failure of ['timeout', 'launch']) {
  test(`Windows async control masks host output on ${failure} failure`, async t => {
    const mock = t.mock.method(cp, 'execFile', ((...args: any[]) => {
      const error = new Error('synthetic private output must not escape');
      if (failure === 'launch') throw error;
      setImmediate(() => args.at(-1)(error, 'private stdout', 'private stderr'));
      return {};
    }) as any);
    syncBuiltinESMExports();
    try {
      await assert.rejects(windowsAsyncControl('synthetic', {}, { SystemRoot: 'C:\\Windows' }),
        error => error instanceof Error && error.message === 'Windows private control failed');
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  });
}
