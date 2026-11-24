import assert from 'node:assert/strict';
import test from 'node:test';
import { claudePrivatePath, type ClaudeConfig } from './config.js';
import { claudeWorkerEnvironment } from './worker-environment.js';
import { powershellArguments, windowsPowerShell, windowsControlEnvironment, windowsPrivateTemporaryDirectory, PRIVATE_ACL_SCRIPT } from '../connector/windows-private-worker.js';
import { WINDOWS_JOB_SOURCE, WindowsWorkerJob } from '../connector/windows-worker-job.js';

test('Windows private paths normalize drive paths but reject ambiguous roots, shares and alternate streams', () => {
  assert.equal(claudePrivatePath('C:/AgentOpsDeck/private home', 'win32'), 'C:\\AgentOpsDeck\\private home');
  for (const path of ['C:\\', 'C:relative', '\\private', '\\\\server\\share\\home', '\\\\?\\C:\\home',
    'C:\\home:stream', 'C:\\home.', 'C:\\home ', 'C:\\home\n', 'C:\\home\\..']) {
    assert.throws(() => claudePrivatePath(path, 'win32'), /Invalid Claude private path/, path);
  }
  assert.equal(claudePrivatePath('/private/home', 'linux'), '/private/home');
});
test('Windows child environment isolates user settings, temp paths, Bash and credentials', () => {
  const config = { homeDirectory: 'D:\\Private Claude', baseUrl: 'https://fixture.invalid', gitBashPath: 'C:\\Git\\bin\\bash.exe' } as ClaudeConfig;
  const env = claudeWorkerEnvironment(config, 'win32', { execPath: 'C:\\node\\node.exe', env: {
    SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\personal', PATH: 'unsafe',
    ANTHROPIC_API_KEY: 'never inherit', NODE_OPTIONS: 'never inherit', HTTPS_PROXY: 'never inherit',
  } });
  assert.equal(env.PATH, 'C:\\node;C:\\Windows\\System32');
  assert.equal(env.USERPROFILE, config.homeDirectory);
  assert.equal(env.APPDATA, 'D:\\Private Claude\\config');
  assert.equal(env.LOCALAPPDATA, 'D:\\Private Claude\\cache');
  assert.equal(env.TEMP, 'D:\\Private Claude\\tmp');
  assert.equal(env.TMP, env.TEMP);
  assert.equal(env.CLAUDE_CODE_GIT_BASH_PATH, config.gitBashPath);
  for (const key of ['ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'HTTPS_PROXY']) assert.equal(key in env, false);
  const { gitBashPath: _gitBashPath, ...defaultConfig } = config;
  const defaultEnv = claudeWorkerEnvironment(defaultConfig, 'win32', { execPath: 'C:\\node\\node.exe', env: { SYSTEMROOT: 'C:\\Windows' } });
  assert.equal(defaultEnv.CLAUDE_CODE_GIT_BASH_PATH, 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.throws(() => claudeWorkerEnvironment(config, 'win32', { execPath: 'node', env: {} }));
});
test('Windows control uses a fixed executable and encoded script, no profile or PATH shell lookup', () => {
  assert.equal(windowsPowerShell({ SystemRoot: 'D:\\Windows' }), 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  for (const value of ['', 'Windows', '%SystemRoot%', 'C:\\Windows"bad']) assert.throws(() => windowsPowerShell({ SystemRoot: value }));
  const script = '[Console]::Write("fixed")';
  const args = powershellArguments(script);
  assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(Buffer.from(args[4]!, 'base64').toString('utf16le'), script);
  assert.match(PRIVATE_ACL_SCRIPT, /GetOwner/);
  assert.match(PRIVATE_ACL_SCRIPT, /ReparsePoint/);
});
test('Windows supervision is fail-closed before assignment and never permits detached breakaway', async () => {
  assert.equal(WindowsWorkerJob.active(), false);
  await assert.rejects(WindowsWorkerJob.empty(), /unconfirmed/);
  await assert.rejects(WindowsWorkerJob.release(), /unconfirmed/);
  assert.match(WINDOWS_JOB_SOURCE, /limits.Basic.Flags=0x2000/);
  assert.match(WINDOWS_JOB_SOURCE, /actual.ToString\(\)==created/);
  assert.match(WINDOWS_JOB_SOURCE, /Require\(count.ActiveProcesses==1\)/);
  assert.doesNotMatch(WINDOWS_JOB_SOURCE, /taskkill|0x800|0x1000000/i);
});
test('Windows compiler control keeps only explicitly supplied private temp and system environment', () => {
  const temporary = 'D:\\Private Claude\\tmp';
  const env = windowsControlEnvironment({ TEMP: temporary, TMP: temporary }, {
    SystemRoot: 'C:\\Windows', TEMP: 'C:\\Users\\personal\\Temp', PATH: 'unsafe',
    ANTHROPIC_API_KEY: 'never inherit', NODE_OPTIONS: 'never inherit',
  });
  assert.deepEqual(env, { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', TEMP: temporary, TMP: temporary });
  if (process.platform !== 'win32') assert.throws(() => windowsPrivateTemporaryDirectory('/tmp'), /ownership could not be verified/);
});

test('R18 Windows compatibility: Copilot config and worker environment isolate paths case-insensitively on win32', async () => {
  const { copilotConfig } = await import('../copilot/config.js');
  const { copilotWorkerEnvironment } = await import('../copilot/worker-environment.js');
  const { pathsOverlap } = await import('./config.js');
  const { boardToolsDirectory } = await import('../tools/workspace-board-worker.js');
  const { sameTaskFilePath } = await import('../connector/sdk-turn-context.js');
  const { syncUpdateDirectory } = await import('../connector/update-journal.js');

  assert.equal(pathsOverlap('C:\\Private\\Home', 'c:\\private\\home\\sub', 'win32'), true);
  assert.equal(pathsOverlap('C:\\Private\\Home', 'D:\\Private\\Home', 'win32'), false);

  const winEnv: NodeJS.ProcessEnv = {
    AOD_COPILOT_ENABLED: 'true',
    AOD_COPILOT_DEDICATED: 'true',
    AOD_COPILOT_HOME: 'C:/Private/Copilot',
    AOD_COPILOT_SDK_DIR: 'C:/Opt/Copilot-SDK',
    AOD_COPILOT_WORKSPACE: 'D:/Work/Projects',
    AOD_COPILOT_MODEL: 'gpt-5',
    AOD_COPILOT_AUTH_MODE: 'github',
    AOD_COPILOT_GITHUB_TOKEN_FILE: 'C:/Credentials/copilot-key',
    USERPROFILE: 'C:\\Users\\Operator',
  };
  const cfg = copilotConfig(winEnv, 'win32');
  assert.equal(cfg?.homeDirectory, 'C:\\Private\\Copilot');
  assert.equal(cfg?.sdkDirectory, 'C:\\Opt\\Copilot-SDK');
  assert.equal(cfg?.workspace, 'D:\\Work\\Projects');

  assert.throws(() => copilotConfig({ ...winEnv, USERPROFILE: 'c:\\private\\copilot' }, 'win32'));
  assert.throws(() => copilotConfig({ ...winEnv, AOD_COPILOT_WORKSPACE: 'c:\\private\\copilot\\work' }, 'win32'));

  const childEnv = copilotWorkerEnvironment(cfg!, 'win32', {
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    env: { SystemRoot: 'C:\\Windows', GITHUB_TOKEN: 'leak', USERPROFILE: 'C:\\Users\\Operator' },
  });
  assert.equal(childEnv.USERPROFILE, 'C:\\Private\\Copilot');
  assert.equal(childEnv.COPILOT_HOME, 'C:\\Private\\Copilot\\copilot');
  assert.equal(childEnv.COPILOT_DISABLE_KEYTAR, '1');
  assert.equal('GITHUB_TOKEN' in childEnv, false);

  assert.equal(boardToolsDirectory('C:\\Private\\Grants', ['D:\\Work\\Projects', 'C:\\Private\\Copilot'], 'win32'), 'C:\\Private\\Grants');
  assert.throws(() => boardToolsDirectory('d:\\work\\projects\\grants', ['D:\\Work\\Projects'], 'win32'));
  assert.equal(copilotConfig({ ...winEnv, AOD_COPILOT_BOARD_TOOLS_DIR: 'C:/Private/Grants' }, 'win32')?.boardToolsDirectory, 'C:\\Private\\Grants');
  assert.throws(() => copilotConfig({ ...winEnv, AOD_COPILOT_BOARD_TOOLS_DIR: 'd:/work/projects/grants' }, 'win32'));

  assert.equal(sameTaskFilePath('C:\\Private\\Grants\\task.json', 'c:\\private\\grants\\TASK.JSON', 'win32'), true);
  assert.equal(sameTaskFilePath('/private/grants/task.json', '/private/grants/TASK.JSON', 'linux'), false);

  await assert.doesNotReject(syncUpdateDirectory('C:\\NonExistent\\Directory', 'win32'));
});
