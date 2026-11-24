import assert from 'node:assert/strict';
import test from 'node:test';

test('trusted-exec admits synchronous Bash without managed or sandbox approval bypass', async () => {
  let active = true;
  const policy = copilotToolPolicy({ workspace: '/work', toolPolicy: 'trusted-exec' }, () => active);
  assert.deepEqual(policy.availableTools, ['view', 'edit', 'create', 'apply_patch', 'bash']);
  const input = { sessionId: 'root', toolName: 'bash', toolArgs: { command: 'printf fixture' } };
  const invocation = { sessionId: 'root' };
  assert.deepEqual(await policy.onPreToolUse(input, invocation), { permissionDecision: 'ask', modifiedArgs: { command: 'printf fixture', mode: 'sync' } });
  for (const patch of [{ command: '' }, { command: 'x\0' }, { command: 'x'.repeat(100_001) }, { mode: 'async' }, { requestSandboxBypass: true }]) {
    assert.equal((await policy.onPreToolUse({ ...input, toolArgs: { ...input.toolArgs, ...patch } }, invocation)).permissionDecision, 'deny');
  }
  for (const toolName of ['task', 'mcp/foo', 'write_bash', 'read_bash', 'stop_bash']) {
    assert.equal((await policy.onPreToolUse({ ...input, toolName }, invocation)).permissionDecision, 'deny');
  }
  assert.equal((await policy.onPreToolUse(input, { sessionId: 'other' })).permissionDecision, 'deny');
  const shell = { kind: 'shell', fullCommandText: 'printf fixture' };
  assert.equal((await policy.onPermissionRequest(shell)).kind, 'approve-once');
  for (const patch of [{ fullCommandText: '' }, { managedApprovalRequired: true }, { requestSandboxBypass: true }]) {
    assert.equal((await policy.onPermissionRequest({ ...shell, ...patch })).kind, 'reject');
  }
  assert.equal((await policy.onPermissionRequest(shell, { managedSettingsEnabled: true })).kind, 'reject');
  assert.equal((await policy.onPermissionRequest({ kind: 'hook', ...input })).kind, 'approve-once');
  active = false;
  assert.equal((await policy.onPreToolUse(input, invocation)).permissionDecision, 'deny');
  assert.equal((await policy.onPermissionRequest(shell)).kind, 'reject');
  assert.equal((await policy.onPermissionRequest({ kind: 'hook', ...input })).kind, 'reject');
});
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copilotToolPolicy } from './tool-policy.js';
import { copilotConfig } from './config.js';

test('Copilot file tiers check both native hooks and permissions, fail closed outside workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'copilot-tools-')), workspace = join(root, 'work');
  try {
    await mkdir(workspace); await mkdir(join(workspace, '.git'));
    await writeFile(join(workspace, 'file.txt'), 'fixture'); await writeFile(join(root, 'outside'), 'outside');
    await symlink(join(root, 'outside'), join(workspace, 'alias'));
    await symlink(root, join(workspace, 'dir-alias'));
    const read = copilotToolPolicy({ workspace, toolPolicy: 'workspace-read' });
    const edit = copilotToolPolicy({ workspace, toolPolicy: 'workspace-edit' });
    const call = (toolName: string, path: unknown) => ({ sessionId: 'root', toolName, toolArgs: { path } });
    const invoke = { sessionId: 'root' };
    assert.deepEqual(read.availableTools, ['view']);
    assert.deepEqual(edit.availableTools, ['view', 'edit', 'create', 'apply_patch']);
    assert.equal((await read.onPreToolUse(call('view', 'file.txt'), invoke)).permissionDecision, 'ask');
    assert.equal((await edit.onPreToolUse(call('create', 'new.txt'), invoke)).permissionDecision, 'ask');
    assert.equal((await edit.onPreToolUse(call('edit', 'file.txt'), invoke)).permissionDecision, 'ask');
    for (const path of ['../outside', join(root, 'outside'), 'alias', 'dir-alias/new', '.git/config', '.', 'new.txt', '', '\0']) {
      assert.equal((await read.onPreToolUse(call('view', path), invoke)).permissionDecision, 'deny', path);
      assert.equal((await read.onPermissionRequest({ kind: 'read', path })).kind, 'reject', path);
    }
    for (const name of ['bash', 'grep', 'glob', 'task', 'write', 'create', 'edit', 'mcp/tool']) {
      assert.equal((await read.onPreToolUse(call(name, 'file.txt'), invoke)).permissionDecision, 'deny', name);
    }
    assert.equal((await edit.onPreToolUse(call('view', 'file.txt'), { sessionId: 'other' })).permissionDecision, 'deny');
    const request = { kind: 'read', path: join(workspace, 'file.txt') };
    assert.equal((await read.onPermissionRequest(request)).kind, 'approve-once');
    for (const patch of [{ kind: 'shell' }, { managedApprovalRequired: true }, { requestSandboxBypass: true }, { resolvedPath: '/other' }]) {
      assert.equal((await read.onPermissionRequest({ ...request, ...patch })).kind, 'reject');
    }
    assert.equal((await read.onPermissionRequest(request, { managedSettingsEnabled: true })).kind, 'reject');
    assert.equal((await read.onPermissionRequest({ kind: 'hook', toolName: 'view', toolArgs: { path: 'file.txt' } })).kind, 'approve-once');
    for (const toolName of ['bash', 'create', 'edit', 'task', 'hook']) {
      assert.equal((await read.onPermissionRequest({ kind: 'hook', toolName, toolArgs: { path: 'file.txt' } })).kind, 'reject');
    }
    assert.equal((await read.onPermissionRequest({ kind: 'hook', toolName: 'view', toolArgs: { path: '../outside' } })).kind, 'reject');
    assert.equal((await read.onPermissionRequest({ kind: 'write', fileName: 'file.txt' })).kind, 'reject');
    assert.equal((await edit.onPermissionRequest({ kind: 'write', fileName: 'new.txt' })).kind, 'approve-once');
    const none = copilotToolPolicy({ workspace });
    assert.deepEqual(none.availableTools, []);
    assert.equal((await none.onPermissionRequest(request)).kind, 'reject');
    assert.equal((await none.onPreToolUse(call('view', 'file.txt'), invoke)).permissionDecision, 'deny');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Copilot configuration rejects implicit or unrecognized tool permission', () => {
  assert.throws(() => copilotToolPolicy({ workspace: '/work', toolPolicy: 'all' as 'none' }));
  const env = { AOD_COPILOT_ENABLED: 'true', AOD_COPILOT_DEDICATED: 'true', AOD_COPILOT_SDK_DIR: '/sdk',
    AOD_COPILOT_HOME: '/private/home', AOD_COPILOT_WORKSPACE: '/work', AOD_COPILOT_MODEL: 'fixture',
    AOD_COPILOT_AUTH_MODE: 'github', AOD_COPILOT_GITHUB_TOKEN_FILE: '/private/key' };
  assert.equal(copilotConfig(env)?.toolPolicy, 'none');
  assert.equal(copilotConfig({ ...env, AOD_COPILOT_TOOL_POLICY: 'workspace-edit' })?.toolPolicy, 'workspace-edit');
  assert.throws(() => copilotConfig({ ...env, AOD_COPILOT_TOOL_POLICY: 'all' }));
});

test('Copilot stop/disconnect fences both hooks and permissions across asynchronous path checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'copilot-tool-stop-'));
  try {
    await writeFile(join(root, 'file'), 'fixture');
    for (const toolName of ['view', 'edit', 'create']) {
      let active = true;
      const policy = copilotToolPolicy({ workspace: root, toolPolicy: 'workspace-edit' }, () => active);
      const input = { sessionId: 'root', toolName, toolArgs: { path: 'file' } };
      const pending = policy.onPreToolUse(input, { sessionId: 'root' });
      active = false;
      assert.equal((await pending).permissionDecision, 'deny');
      assert.equal((await policy.onPreToolUse(input, { sessionId: 'root' })).permissionDecision, 'deny');
      for (const request of [{ kind: 'hook', ...input }, { kind: 'read', path: 'file' }, { kind: 'write', fileName: 'file' }]) {
        active = true;
        const permission = policy.onPermissionRequest(request);
        active = false;
        assert.equal((await permission).kind, 'reject');
        assert.equal((await policy.onPermissionRequest(request)).kind, 'reject');
        active = true;
        assert.equal((await policy.onPermissionRequest(request)).kind, 'approve-once');
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
