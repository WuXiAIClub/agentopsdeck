// Opt-in native CLI contract check: no model request, credentials or live data.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { copilotToolPolicy } from '../apps/server/dist/copilot/tool-policy.js';

assert.ok(isAbsolute(process.argv[2] ?? ''), 'Pass installed Copilot SDK directory');
const { CopilotClient, RuntimeConnection } = await import(pathToFileURL(join(process.argv[2], 'dist/index.js')));
const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-native-file-tools-'));
const workspace = join(root, 'workspace'), board = join(root, 'board');
await mkdir(workspace); await mkdir(board);
const task = join(board, 'tasks.json'), other = join(board, 'other.txt');
await writeFile(task, 'before\n'); await writeFile(other, 'unchanged\n');
let active = true;
const policy = copilotToolPolicy({ workspace, toolPolicy: 'workspace-edit' }, () => active, undefined, [task]);
const client = new CopilotClient({ mode: 'empty', connection: RuntimeConnection.forStdio(), workingDirectory: workspace,
  baseDirectory: join(root, 'state'), useLoggedInUser: false, logLevel: 'none', builtinPluginDirectories: [],
  env: { PATH: '/usr/bin:/bin', HOME: root, COPILOT_HOME: join(root, 'state'), COPILOT_DISABLE_KEYTAR: '1',
    XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), TMPDIR: root } });
try {
  await client.start();
  const session = await client.createSession({ model: process.argv[3] ?? 'fixture-openai-model', workingDirectory: workspace,
    availableTools: policy.availableTools, excludedTools: policy.excludedTools, tools: [],
    enableConfigDiscovery: false, enableSkills: false, enableFileHooks: false, enableHostGitOperations: false,
    hooks: { onPreToolUse: policy.onPreToolUse }, onPermissionRequest: policy.onPermissionRequest,
    provider: { type: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-not-a-key', wireApi: 'completions' } });
  await session.rpc.tools.initializeAndValidate();
  const { tools } = await session.rpc.tools.getCurrentMetadata();
  assert.deepEqual(tools.map(t => t.name).sort(), ['apply_patch', 'view']);
  const update = (path, before, after) => `*** Update File: ${path}\n@@\n-${before}\n+${after}`;
  const patch = (...parts) => ['*** Begin Patch', ...parts, '*** End Patch'].join('\n');
  const run = arguments_ => session.rpc.tools.execute({ name: 'apply_patch', arguments: arguments_ });
  const accepted = await run(patch(update(task, 'before', 'after')));
  assert.equal(accepted.resultType, 'success'); assert.equal(await readFile(task, 'utf8'), 'after\n');
  const blocked = await run(patch(update(task, 'after', 'bad'), update(other, 'unchanged', 'bad')));
  assert.equal(blocked.resultType, 'denied'); assert.equal(await readFile(task, 'utf8'), 'after\n');
  assert.equal(await readFile(other, 'utf8'), 'unchanged\n');
  const deletion = await run(patch(`*** Delete File: ${task}`)); assert.equal(deletion.resultType, 'denied');
  active = false;
  const stopped = await run(patch(update(task, 'after', 'bad'))); assert.equal(stopped.resultType, 'denied');
  await session.disconnect();
  console.log(JSON.stringify({ passed: true, nativeCatalog: tools.map(t => t.name), exactFile: true,
    multiFileAtomicDenial: true, deletionDenied: true, stoppedDenied: true, modelRequests: 0, evidence: root }));
} finally { assert.deepEqual(await client.stop(), []); }
