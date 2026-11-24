import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ClaudeConfig } from './config.js';
import { claudeToolPolicy } from './tool-policy.js';

test('trusted-exec admits foreground Bash only, with native callbacks and a live owner', async () => {
  let active = true;
  const config = { workspace: '/work', toolPolicy: 'trusted-exec' } as ClaudeConfig;
  const policy = claudeToolPolicy(config, () => active);
  assert.ok(policy.tools.includes('Bash'));
  assert.deepEqual(policy.permissions.ask, policy.tools);
  assert.deepEqual(policy.permissions.allow, []);
  const command = { command: 'printf fixture', timeout: 1000 };
  assert.deepEqual(await policy.canUseTool('Bash', command), { behavior: 'allow', updatedInput: { ...command, run_in_background: false, dangerouslyDisableSandbox: false } });
  for (const patch of [{ command: '' }, { command: 'x\0' }, { command: 'x'.repeat(100_001) }, { run_in_background: true },
    { run_in_background: 'false' }, { dangerouslyDisableSandbox: true }, { timeout: 600_001 }, { timeout: -1 }, { timeout: NaN }]) {
    assert.equal((await policy.canUseTool('Bash', { ...command, ...patch })).behavior, 'deny');
  }
  for (const name of ['Agent', 'Task', 'mcp/foo', 'BashOutput', 'KillShell']) assert.equal((await policy.canUseTool(name, command)).behavior, 'deny');
  for (const toolPolicy of ['none', 'workspace-read', 'workspace-edit'] as const) {
    assert.equal((await claudeToolPolicy({ ...config, toolPolicy }).canUseTool('Bash', command)).behavior, 'deny');
  }
  assert.equal((await policy.canUseTool('Bash', command, { signal: AbortSignal.abort() })).behavior, 'deny');
  active = false;
  assert.equal((await policy.canUseTool('Bash', command)).behavior, 'deny');
});

test('workspace tools default off; explicit tiers force native permission callbacks', async () => {
  const config = { workspace: '/work' } as ClaudeConfig;
  assert.deepEqual(claudeToolPolicy(config).tools, []);
  assert.equal((await claudeToolPolicy(config).canUseTool('Read', { file_path: '/work/file' })).behavior, 'deny');
  const read = claudeToolPolicy({ ...config, toolPolicy: 'workspace-read' });
  assert.deepEqual(read.tools, ['Read', 'Glob', 'Grep']);
  assert.deepEqual(read.permissions.ask, read.tools); assert.deepEqual(read.permissions.allow, []);
  assert.equal((await read.canUseTool('Write', { file_path: '/work/file' })).behavior, 'deny');
  assert.throws(() => claudeToolPolicy({ ...config, toolPolicy: 'all' as never }));
});

test('file tool policy checks canonical scope, symlinks, metadata and search paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-tool-policy-')), workspace = join(root, 'work');
  await mkdir(workspace); await mkdir(join(workspace, '.git'));
  await writeFile(join(workspace, 'file'), 'fixture'); await writeFile(join(root, 'outside'), 'private');
  await symlink(join(root, 'outside'), join(workspace, 'link'));
  await symlink(join(root, 'not-created'), join(workspace, 'dangling'));
  await symlink(root, join(workspace, 'parent-link'));
  await symlink(join(workspace, '.git'), join(workspace, 'metadata-link'));
  const policy = claudeToolPolicy({ workspace, toolPolicy: 'workspace-edit' } as ClaudeConfig);
  try {
    for (const [name, input] of [
      ['Read', { file_path: 'file' }], ['Edit', { file_path: 'file', old_string: 'fixture', new_string: 'changed' }],
      ['Write', { file_path: 'new', content: 'fixture' }], ['Glob', { pattern: '*.ts' }], ['Grep', { pattern: 'text' }],
    ] as const) assert.equal((await policy.canUseTool(name, input)).behavior, 'allow');
    for (const [name, input] of [
      ['Read', { file_path: '../outside' }], ['Read', { file_path: 'link' }], ['Read', { file_path: 'parent-link/outside' }],
      ['Write', { file_path: 'dangling' }], ['Write', { file_path: 'parent-link/new' }], ['Write', { file_path: '.git/config' }],
      ['Write', { file_path: 'metadata-link/config' }], ['Read', { file_path: workspace }],
      ['Glob', { pattern: '../*' }], ['Glob', { pattern: '/tmp/*' }], ['Grep', { path: root, pattern: 'private' }],
      ['Bash', { command: 'echo unsafe' }], ['Agent', { prompt: 'spawn' }], ['Read', { file_path: 'file\0' }],
    ] as const) assert.equal((await policy.canUseTool(name, input)).behavior, 'deny', `${name}: ${JSON.stringify(input)}`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('permission cancellation before or during path checks never grants a late Claude tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-tool-stop-'));
  try {
    await writeFile(join(root, 'file'), 'fixture');
    for (const name of ['Read', 'Edit', 'Write', 'Glob', 'Grep']) {
      const input = ['Glob', 'Grep'].includes(name) ? { path: root, pattern: '*' } : { file_path: 'file' };
      let active = true;
      const policy = claudeToolPolicy({ workspace: root, toolPolicy: 'workspace-edit' } as ClaudeConfig, () => active);
      const pending = policy.canUseTool(name, input);
      active = false;
      assert.equal((await pending).behavior, 'deny', name);
      assert.equal((await policy.canUseTool(name, input)).behavior, 'deny');
      active = true;
      const controller = new AbortController();
      const cancelled = policy.canUseTool(name, input, { signal: controller.signal });
      controller.abort();
      assert.equal((await cancelled).behavior, 'deny');
      assert.equal((await policy.canUseTool(name, input, { signal: controller.signal })).behavior, 'deny');
      assert.equal((await policy.canUseTool(name, input)).behavior, 'allow');
    }
    const broken = claudeToolPolicy({ workspace: root, toolPolicy: 'workspace-read' } as ClaudeConfig, () => { throw new Error('closed'); });
    assert.equal((await broken.canUseTool('Read', { file_path: 'file' })).behavior, 'deny');
  } finally { await rm(root, { recursive: true, force: true }); }
});
