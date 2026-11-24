import { lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, win32 } from 'node:path';
import { assertWindowsPrivatePath, canonicalPrivatePath, windowsWorkerEnvironment, assertPrivateWorkerEnvironment } from '../connector/windows-private-worker.js';
import { WindowsWorkerJob } from '../connector/windows-worker-job.js';
import { pathToFileURL } from 'node:url';
import { CLAUDE_CLI_VERSION, CLAUDE_SDK_VERSION } from './dispatch-adapter.js';
import { pathsOverlap, type ClaudeConfig } from './config.js';
import { readPrivateWorkerCredential } from '../connector/private-worker-credential.js';
import { verifyPrivateWorkerScope, WORKER_SCOPE_ENV } from '../connector/private-worker-scope.js';
import { boardToolsDirectory } from '../tools/workspace-board-worker.js';

const denied = () => new Error('Claude private worker configuration could not be verified');
const uid = () => process.getuid?.();

/** No SDK import and no credentials read in the Connector/Hub process. This
 * builds an allowlisted environment for the worker BEFORE it starts. */
export function claudeWorkerEnvironment(config: ClaudeConfig, platform: NodeJS.Platform = process.platform,
  host: { execPath: string; env: NodeJS.ProcessEnv } = process): NodeJS.ProcessEnv {
  if (platform === 'win32') {
    const environment = windowsWorkerEnvironment(config.homeDirectory, host);
    return { ...environment,
      CLAUDE_CONFIG_DIR: win32.join(config.homeDirectory, 'claude'),
      CLAUDE_CODE_GIT_BASH_PATH: config.gitBashPath ?? win32.join(win32.parse(environment.SystemRoot!).root, 'Program Files', 'Git', 'bin', 'bash.exe'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ANTHROPIC_BASE_URL: config.baseUrl };
  }
  return { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8',
    HOME: config.homeDirectory, CLAUDE_CONFIG_DIR: join(config.homeDirectory, 'claude'),
    XDG_CONFIG_HOME: join(config.homeDirectory, 'config'), XDG_CACHE_HOME: join(config.homeDirectory, 'cache'),
    TMPDIR: join(config.homeDirectory, 'tmp'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ANTHROPIC_BASE_URL: config.baseUrl };
}

export function assertClaudeWorkerEnvironment(config: ClaudeConfig, env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform, host: { execPath: string; env: NodeJS.ProcessEnv } = process) {
  assertPrivateWorkerEnvironment(claudeWorkerEnvironment(config, platform, host), env, platform,
    config.toolPolicy === 'trusted-exec' ? [WORKER_SCOPE_ENV] : []);
}

/** Executed only in an already supervised private worker. Directory checks are
 * ownership/configuration checks, NOT an OS sandbox or defense against the
 * same OS user deliberately changing trusted deployment files concurrently. */
export async function verifyClaudeWorker(config: ClaudeConfig, env: NodeJS.ProcessEnv) {
  if (!['linux', 'win32'].includes(process.platform) || process.platform === 'linux' && uid() === undefined
    || process.platform === 'win32' && !WindowsWorkerJob.active()) throw denied();
  try {
    boardToolsDirectory(config.boardToolsDirectory, [config.homeDirectory, config.sdkDirectory, config.workspace, config.apiKeyFile]);
    verifyPrivateWorkerScope(config.toolPolicy, env);
    // Do not accept inherited credentials, config injection, proxies or Node
    // preload hooks. NODE_CHANNEL_FD and friends are supplied by node:fork.
    assertClaudeWorkerEnvironment(config, env);
    const directory = async (path: string, privateDirectory = false) => {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !canonicalPrivatePath(path)) throw denied();
      if (privateDirectory) {
        if (process.platform === 'win32') assertWindowsPrivatePath(path);
        else if (stat.uid !== uid() || (stat.mode & 0o077) !== 0) throw denied();
      }
    };
    await directory(config.homeDirectory, true);
    await directory(config.workspace);
    await directory(config.sdkDirectory);
    if (pathsOverlap(config.homeDirectory, config.workspace) || pathsOverlap(config.homeDirectory, config.sdkDirectory)
      || pathsOverlap(config.workspace, config.sdkDirectory)
      || pathsOverlap(config.workspace, config.apiKeyFile) || pathsOverlap(config.sdkDirectory, config.apiKeyFile)) throw denied();
    for (const name of ['claude', 'config', 'cache', 'tmp']) {
      const path = join(config.homeDirectory, name);
      try { await mkdir(path, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      await directory(path, true);
    }
    const manifest = JSON.parse(await readFile(join(config.sdkDirectory, 'package.json'), 'utf8'));
    if (manifest.name !== '@anthropic-ai/claude-agent-sdk' || manifest.version !== CLAUDE_SDK_VERSION
      || manifest.claudeCodeVersion !== CLAUDE_CLI_VERSION) throw denied();
    const entry = join(config.sdkDirectory, 'sdk.mjs');
    const stat = await lstat(entry);
    if (!stat.isFile() || stat.isSymbolicLink() || !canonicalPrivatePath(entry)) throw denied();
    if (process.platform === 'win32') {
      const bash = claudeWorkerEnvironment(config).CLAUDE_CODE_GIT_BASH_PATH!;
      const bashStat = await lstat(bash);
      if (!/\\bash\.exe$/i.test(bash) || !bashStat.isFile() || bashStat.isSymbolicLink() || !canonicalPrivatePath(bash)) throw denied();
    }
    return pathToFileURL(entry).href;
  } catch { throw denied(); }
}

/** Only call inside the private worker after verification. The raw key never
 * travels in IPC, CLI arguments, diagnostics, journal or public config. */
export async function readClaudeWorkerKey(path: string): Promise<string> {
  try { return await readPrivateWorkerCredential(path); } catch { throw denied(); }
}
