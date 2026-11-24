import { lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pathsOverlap } from '../claude/config.js';
import { readPrivateWorkerCredential } from '../connector/private-worker-credential.js';
import type { CopilotConfig } from './config.js';
import { COPILOT_CLI_VERSION, COPILOT_SDK_VERSION } from './dispatch-adapter.js';
import { copilotToolPolicy } from './tool-policy.js';
import { verifyPrivateWorkerScope, WORKER_SCOPE_ENV } from '../connector/private-worker-scope.js';
import { assertWindowsPrivatePath, canonicalPrivatePath, windowsWorkerEnvironment, assertPrivateWorkerEnvironment } from '../connector/windows-private-worker.js';
import { WindowsWorkerJob } from '../connector/windows-worker-job.js';
import { boardToolsDirectory } from '../tools/workspace-board-worker.js';

const denied = () => new Error('Copilot private worker configuration could not be verified');

export function copilotWorkerEnvironment(config: CopilotConfig, platform: NodeJS.Platform = process.platform,
  host: { execPath: string; env: NodeJS.ProcessEnv } = process): NodeJS.ProcessEnv {
  if (platform === 'win32') {
    return { ...windowsWorkerEnvironment(config.homeDirectory, host),
      COPILOT_HOME: win32.join(config.homeDirectory, 'copilot'), COPILOT_DISABLE_KEYTAR: '1' };
  }
  return { PATH: `${dirname(host.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8', HOME: config.homeDirectory,
    COPILOT_HOME: join(config.homeDirectory, 'copilot'), COPILOT_DISABLE_KEYTAR: '1',
    XDG_CONFIG_HOME: join(config.homeDirectory, 'config'), XDG_CACHE_HOME: join(config.homeDirectory, 'cache'),
    TMPDIR: join(config.homeDirectory, 'tmp') };
}

export function assertCopilotWorkerEnvironment(config: CopilotConfig, env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform, host: { execPath: string; env: NodeJS.ProcessEnv } = process) {
  assertPrivateWorkerEnvironment(copilotWorkerEnvironment(config, platform, host), env, platform,
    config.toolPolicy === 'trusted-exec' ? [WORKER_SCOPE_ENV] : []);
}

/** Must run in the private worker before importing SDK or reading credentials.
 * Environment and canonical owner checks are not an OS filesystem sandbox. */
export async function verifyCopilotWorker(config: CopilotConfig, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    boardToolsDirectory(config.boardToolsDirectory, [config.homeDirectory, config.sdkDirectory, config.workspace, config.auth.credentialFile]);
    verifyPrivateWorkerScope(config.toolPolicy, env);
    if (!['linux', 'win32'].includes(process.platform) || process.platform === 'linux' && process.getuid?.() === undefined
      || process.platform === 'win32' && !WindowsWorkerJob.active()) throw denied();
    assertCopilotWorkerEnvironment(config, env);
    const directory = async (path: string, privateDirectory = false) => {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !canonicalPrivatePath(path)) throw denied();
      if (!privateDirectory) return;
      if (process.platform === 'win32') assertWindowsPrivatePath(path);
      else if (stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) throw denied();
    };
    await directory(config.homeDirectory, true);
    await directory(config.sdkDirectory);
    await directory(config.workspace);
    if (pathsOverlap(config.homeDirectory, config.workspace) || pathsOverlap(config.homeDirectory, config.sdkDirectory)
      || pathsOverlap(config.workspace, config.sdkDirectory)
      || pathsOverlap(config.workspace, config.auth.credentialFile) || pathsOverlap(config.sdkDirectory, config.auth.credentialFile)) throw denied();
    for (const name of ['copilot', 'config', 'cache', 'tmp']) {
      const path = join(config.homeDirectory, name);
      try { await mkdir(path, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      await directory(path, true);
    }
    const manifest = JSON.parse(await readFile(join(config.sdkDirectory, 'package.json'), 'utf8'));
    if (manifest.name !== '@github/copilot-sdk' || manifest.version !== COPILOT_SDK_VERSION
      || manifest.copilotCliVersion !== COPILOT_CLI_VERSION) throw denied();
    const entry = join(config.sdkDirectory, 'dist', 'index.js'), stat = await lstat(entry);
    if (!stat.isFile() || stat.isSymbolicLink() || !canonicalPrivatePath(entry)) throw denied();
    return pathToFileURL(entry).href;
  } catch { throw denied(); }
}

/** Call only after verifyCopilotWorker inside the worker. Do not serialize the
 * result, which contains a secret, into IPC/logs/persistent configuration. */
export async function copilotWorkerOptions(config: CopilotConfig, active: () => boolean = () => true, boardSessionId?: string, taskFiles: string[] = [], questionSessionId?: string) {
  const policy = copilotToolPolicy(config, active, boardSessionId, taskFiles, questionSessionId);
  let key: string;
  try { key = await readPrivateWorkerCredential(config.auth.credentialFile); } catch { throw denied(); }
  const client = { mode: 'empty' as const, workingDirectory: config.workspace,
    baseDirectory: join(config.homeDirectory, 'copilot'), env: copilotWorkerEnvironment(config),
    builtinPluginDirectories: [], useLoggedInUser: false, logLevel: 'none' as const,
    ...(config.auth.mode === 'github' ? { gitHubToken: key } : {}) };
  const session = { model: config.model, streaming: true, workingDirectory: config.workspace,
    enableConfigDiscovery: false, enableSessionTelemetry: false, enableFileChangeTracking: false,
    enableOnDemandInstructionDiscovery: false, enableFileHooks: false, enableHostGitOperations: false,
    enableSessionStore: false, enableSkills: false, skipEmbeddingRetrieval: true,
    embeddingCacheStorage: 'in-memory' as const, remoteSession: 'off' as const,
    availableTools: policy.availableTools, excludedTools: policy.excludedTools, tools: [], mcpServers: {},
    customAgents: [], hooks: { onPreToolUse: policy.onPreToolUse }, skillDirectories: [], pluginDirectories: [], instructionDirectories: [], includedBuiltinSkills: [],
    onPermissionRequest: policy.onPermissionRequest,
    ...(config.auth.mode === 'provider' ? { provider: { type: config.auth.providerType, baseUrl: config.auth.baseUrl,
      apiKey: key, ...(config.auth.wireApi ? { wireApi: config.auth.wireApi, transport: 'http' as const } : {}) } } : {}) };
  return { client, session };
}
