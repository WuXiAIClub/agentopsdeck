import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { windowsCommand } from './windows-command.js';

const env = { SystemRoot: 'C:\\Windows', ComSpec: 'untrusted', PATH: 'untrusted' };
test('native Windows executable preserves argument boundaries without a shell', () => {
  assert.deepEqual(windowsCommand('C:\\用户\\Program Files\\codex.exe', ['-c', 'value="some text"'], env), {
    command: 'C:\\用户\\Program Files\\codex.exe', args: ['-c', 'value="some text"'], windowsVerbatimArguments: false,
  });
});
test('cmd shim quotes paths and every argument with a pinned, expansion-disabled interpreter', () => {
  const result = windowsCommand('C:\\用户\\Program Files\\codex.cmd', ['features', 'list'], env);
  assert.equal(result.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(result.args, ['/d', '/s', '/v:off', '/c', '""C:\\用户\\Program Files\\codex.cmd" "features" "list""']);
  assert.equal(result.windowsVerbatimArguments, true);
});
test('unrepresentable shim expansion and control characters fail closed', () => {
  for (const value of ['a&b', '%PATH%', '!value!', 'x"y', 'a\nb', 'x|y', 'a^b']) {
    assert.throws(() => windowsCommand('codex.cmd', [value], env));
  }
  assert.throws(() => windowsCommand('codex.exe', ['a\0b'], env));
});

for (const source of ['control-source', 'launcher']) {
  for (const extension of ['exe', 'cmd']) {
    test(`managed ${source} discovery passes a literal ${extension} path to the native command boundary`, async t => {
      const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-managed-codex-'));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const root = join(directory, 'program'), workspace = join(directory, 'workspace');
      await Promise.all([mkdir(root), mkdir(workspace)]);
      const command = `C:\\用户\\Program Files\\codex.${extension}`;
      const require = createRequire(import.meta.url);
      const { prepare, saveWorkspace } = require(`../../../../native/windows/${source}/desktop-launcher.cjs`);
      const ambient = { ...env, LOCALAPPDATA: directory, AOD_CODEX_DEFAULT_CWD: workspace, AOD_CODEX_ENABLED: 'true' };
      const disabled = prepare(root, ambient, { platform: 'win32', selectCodex: () => assert.fail('default-disabled plan must not discover Codex') });
      assert.equal(disabled.env.AOD_CODEX_ENABLED, 'false');
      assert.equal(disabled.env.AOD_CODEX_DEFAULT_CWD, undefined);
      saveWorkspace(root, ambient, workspace);
      const plan = prepare(root, ambient, {
        platform: 'win32', selectCodex: () => command,
      });
      assert.equal(plan.env.AOD_CODEX_ENABLED, 'true');
      assert.equal(plan.env.AOD_CODEX_COMMAND, command);
      assert.equal(plan.env.AOD_CODEX_RESOLVED_EXECUTABLE, command);
      const invocation = windowsCommand(plan.env.AOD_CODEX_COMMAND, ['app-server'], plan.env);
      assert.equal(invocation.command, extension === 'exe' ? command : 'C:\\Windows\\System32\\cmd.exe');
    });
  }
}
