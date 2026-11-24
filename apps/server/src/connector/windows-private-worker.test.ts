import assert from 'node:assert/strict';
import test from 'node:test';
import { powershellArguments, windowsPowerShell, windowsControlEnvironment, windowsPrivateControlScript, windowsPrivateControl } from './windows-private-worker.js';

test('Windows control uses a trusted absolute executable and excludes inherited secrets/PATH', () => {
  const host = { SystemRoot: 'C:\\Windows', PATH: 'untrusted', ANTHROPIC_API_KEY: 'synthetic-only' };
  assert.equal(windowsPowerShell(host), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(windowsControlEnvironment({ TEMP: 'C:\\用户\\tmp' }, host), {
    SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', TEMP: 'C:\\用户\\tmp',
  });
  for (const root of ['', 'relative', 'C:\\Windows"', 'C:\\Windows%PATH%']) assert.throws(() => windowsPowerShell({ SystemRoot: root }));
});
test('encoded control scripts preserve Unicode and set redirected UTF8 before output', () => {
  const body = "[Console]::Write('C:\\用户\\工作区')";
  const script = windowsPrivateControlScript(body), args = powershellArguments(script);
  assert.equal(Buffer.from(args.at(-1)!, 'base64').toString('utf16le'), script);
  assert.ok(script.indexOf('OutputEncoding') < script.indexOf(body));
  assert.match(script, /UTF8Encoding.*\$false/);
});
test('native Windows control round-trips a non-ASCII path', { skip: process.platform !== 'win32' }, () => {
  assert.equal(windowsPrivateControl("[Console]::Write($env:AOD_PATH)", { AOD_PATH: 'C:\\用户\\工作区' }), 'C:\\用户\\工作区');
});
