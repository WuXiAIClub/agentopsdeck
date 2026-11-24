import { normalize, win32 } from 'node:path';
import { claudePrivatePath, pathsOverlap } from '../claude/config.js';
import { parseSdkModelChoices } from '../connector/sdk-models.js';
import { sdkCompactTimeout } from '../connector/sdk-compact-config.js';
import { boardToolsDirectory } from '../tools/workspace-board-worker.js';

export type CopilotAuth = { mode: 'github'; credentialFile: string }
  | { mode: 'provider'; credentialFile: string; providerType: 'openai' | 'azure' | 'anthropic';
      baseUrl: string; wireApi?: 'completions' | 'responses' };
/** Paths only, never credential values. Connector-local, not Hub supplied. */
export type CopilotConfig = {
  sdkDirectory: string; homeDirectory: string; workspace: string;
  model: string; startupTimeoutMs: number; auth: CopilotAuth;
  modelChoices?: string[];
  compactTimeoutMs?: number;
  boardToolsDirectory?: string;
  toolPolicy?: 'none' | 'workspace-read' | 'workspace-edit' | 'trusted-exec';
};
const prefix = 'AOD_COPILOT_';

export function copilotConfig(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): CopilotConfig | undefined {
  const enabled = env[`${prefix}ENABLED`];
  if (!enabled || enabled === 'false') return;
  if (enabled !== 'true') throw new Error('AOD_COPILOT_ENABLED must be true or false');
  if (env[`${prefix}DEDICATED`] !== 'true') throw new Error('Copilot requires an exclusively owned private home');
  const absolute = (name: string) => {
    const value = env[`${prefix}${name}`];
    try { return claudePrivatePath(value, platform); }
    catch {
      throw new Error(`${prefix}${name} must be an absolute, non-root path`);
    }
  };
  const sdkDirectory = absolute('SDK_DIR'), homeDirectory = absolute('HOME'), workspace = absolute('WORKSPACE');
  const model = env[`${prefix}MODEL`];
  if (!model || model.length > 256 || /\s|[\x00-\x1f\x7f]/.test(model)) throw new Error('AOD_COPILOT_MODEL is required');
  const modelChoices = parseSdkModelChoices(model, env[`${prefix}MODEL_CHOICES`]);
  const rawTimeout = env[`${prefix}STARTUP_TIMEOUT_MS`] ?? '30000';
  const startupTimeoutMs = Number(rawTimeout);
  if (!/^\d+$/.test(rawTimeout) || !Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1000 || startupTimeoutMs > 120000) {
    throw new Error('AOD_COPILOT_STARTUP_TIMEOUT_MS must be between 1000 and 120000');
  }
  let auth: CopilotAuth;
  const mode = env[`${prefix}AUTH_MODE`];
  if (mode === 'github') {
    if (['API_KEY_FILE', 'BASE_URL', 'PROVIDER_TYPE', 'WIRE_API'].some(name => env[`${prefix}${name}`] !== undefined)) {
      throw new Error('Copilot GitHub authentication cannot include custom provider settings');
    }
    auth = { mode, credentialFile: absolute('GITHUB_TOKEN_FILE') };
  } else if (mode === 'provider') {
    if (env[`${prefix}GITHUB_TOKEN_FILE`] !== undefined) throw new Error('Copilot provider authentication cannot include a GitHub token');
    const providerType = env[`${prefix}PROVIDER_TYPE`];
    if (providerType !== 'openai' && providerType !== 'azure' && providerType !== 'anthropic') throw new Error('Invalid Copilot provider type');
    const wireApi = env[`${prefix}WIRE_API`];
    if (providerType === 'anthropic' ? wireApi !== undefined : wireApi !== 'completions' && wireApi !== 'responses') {
      throw new Error('Copilot openai/azure providers require an explicit WIRE_API; anthropic must omit it');
    }
    let url: URL;
    try { url = new URL(env[`${prefix}BASE_URL`] ?? ''); } catch { throw new Error('Invalid Copilot provider URL'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || url.protocol === 'http:' && env[`${prefix}ALLOW_HTTP`] !== 'true') {
      throw new Error('Copilot provider requires HTTPS, or explicit ALLOW_HTTP for a trusted private endpoint; no URL credentials');
    }
    auth = { mode, credentialFile: absolute('API_KEY_FILE'), providerType, baseUrl: url.href.replace(/\/$/, ''),
      ...(wireApi ? { wireApi: wireApi as 'completions' | 'responses' } : {}) };
  } else throw new Error('AOD_COPILOT_AUTH_MODE must explicitly select github or provider');
  if (pathsOverlap(homeDirectory, workspace, platform) || pathsOverlap(homeDirectory, sdkDirectory, platform)
    || pathsOverlap(workspace, sdkDirectory, platform)
    || pathsOverlap(workspace, auth.credentialFile, platform) || pathsOverlap(sdkDirectory, auth.credentialFile, platform)
    || [env.HOME, env.USERPROFILE].some(path => path && (platform === 'win32' ? win32.normalize(path).toLowerCase() === homeDirectory.toLowerCase() : normalize(path) === homeDirectory))) {
    throw new Error('Copilot private home, SDK, workspace and credential locations must be separated');
  }
  const toolPolicy = env[`${prefix}TOOL_POLICY`] ?? 'none';
  if (!['none', 'workspace-read', 'workspace-edit', 'trusted-exec'].includes(toolPolicy)) throw new Error('Invalid AOD_COPILOT_TOOL_POLICY');
  const boardDirectory = boardToolsDirectory(env[`${prefix}BOARD_TOOLS_DIR`], [sdkDirectory, homeDirectory, workspace, auth.credentialFile], platform);
  return { sdkDirectory, homeDirectory, workspace, model, modelChoices, startupTimeoutMs, auth, ...(boardDirectory ? { boardToolsDirectory: boardDirectory } : {}), compactTimeoutMs: sdkCompactTimeout(env, prefix),
    toolPolicy: toolPolicy as NonNullable<CopilotConfig['toolPolicy']> };
}
