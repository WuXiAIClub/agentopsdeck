import { isAbsolute, normalize, relative, sep, win32, posix } from 'node:path';
import { parseSdkModelChoices } from '../connector/sdk-models.js';
import { sdkCompactTimeout } from '../connector/sdk-compact-config.js';
import { boardToolsDirectory } from '../tools/workspace-board-worker.js';

/** Connector-local opt-in configuration. Never accepted from Hub commands. */
export type ClaudeConfig = {
  sdkDirectory: string; homeDirectory: string; workspace: string; apiKeyFile: string;
  baseUrl: string; model: string; startupTimeoutMs: number;
  modelChoices?: string[];
  compactTimeoutMs?: number;
  boardToolsDirectory?: string;
  gitBashPath?: string;
  toolPolicy?: 'none' | 'workspace-read' | 'workspace-edit' | 'trusted-exec';
};
const prefix = 'AOD_CLAUDE_';
export function claudePrivatePath(value: string | undefined, platform: NodeJS.Platform = process.platform) {
  const path = platform === 'win32' ? win32 : posix;
  if (!value || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid Claude private path');
  const normalized = path.normalize(value);
  if (platform !== 'win32' && normalized !== value) throw new Error('Invalid Claude private path');
  if (normalized === path.parse(normalized).root || platform === 'win32' &&
    (!/^[A-Za-z]:\\/.test(normalized) || /[:"<>|?*]/.test(normalized.slice(2)) || normalized.slice(3).split('\\').some(part => /[. ]$/.test(part)))) {
    throw new Error('Invalid Claude private path');
  }
  return normalized;
}
export const pathsOverlap = (a: string, b: string, platform: NodeJS.Platform = process.platform) => {
  const path = platform === 'win32' ? win32 : posix;
  const left = platform === 'win32' ? path.normalize(a).toLowerCase() : a;
  const right = platform === 'win32' ? path.normalize(b).toLowerCase() : b;
  const within = (root: string, target: string) => {
    const value = path.relative(root, target);
    return !value || (!path.isAbsolute(value) && value !== '..' && !value.startsWith(`..${path.sep}`));
  };
  return within(left, right) || within(right, left);
};

export function claudeConfig(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): ClaudeConfig | undefined {
  const enabled = env[`${prefix}ENABLED`];
  if (!enabled || enabled === 'false') return;
  if (enabled !== 'true') throw new Error('AOD_CLAUDE_ENABLED must be true or false');
  if (env[`${prefix}DEDICATED`] !== 'true') throw new Error('Claude requires an exclusively owned private home');
  const absolute = (name: string) => {
    const value = env[`${prefix}${name}`];
    try { return claudePrivatePath(value, platform); }
    catch {
      throw new Error(`${prefix}${name} must be an absolute, non-root path`);
    }
  };
  const sdkDirectory = absolute('SDK_DIR'), homeDirectory = absolute('HOME'), workspace = absolute('WORKSPACE');
  const apiKeyFile = absolute('API_KEY_FILE');
  if (pathsOverlap(homeDirectory, workspace, platform) || pathsOverlap(homeDirectory, sdkDirectory, platform)
    || pathsOverlap(workspace, sdkDirectory, platform)
    || pathsOverlap(workspace, apiKeyFile, platform) || pathsOverlap(sdkDirectory, apiKeyFile, platform)
    || [env.HOME, env.USERPROFILE].some(path => path && (platform === 'win32' ? win32.normalize(path).toLowerCase() === homeDirectory.toLowerCase() : normalize(path) === homeDirectory))) {
    throw new Error('Claude private home, SDK, workspace and credential locations must be separated');
  }
  const model = env[`${prefix}MODEL`];
  if (!model || model.length > 256 || /\s|[\x00-\x1f\x7f]/.test(model)) throw new Error('AOD_CLAUDE_MODEL is required');
  const modelChoices = parseSdkModelChoices(model, env[`${prefix}MODEL_CHOICES`]);
  let url: URL;
  try { url = new URL(env[`${prefix}BASE_URL`] ?? 'https://api.anthropic.com'); }
  catch { throw new Error('Invalid Claude provider URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || url.protocol === 'http:' && env[`${prefix}ALLOW_HTTP`] !== 'true') {
    throw new Error('Claude provider requires HTTPS, or explicit ALLOW_HTTP for a trusted private endpoint; no URL credentials');
  }
  const rawTimeout = env[`${prefix}STARTUP_TIMEOUT_MS`] ?? '30000';
  const startupTimeoutMs = Number(rawTimeout);
  if (!/^\d+$/.test(rawTimeout) || !Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1000 || startupTimeoutMs > 120000) {
    throw new Error('AOD_CLAUDE_STARTUP_TIMEOUT_MS must be between 1000 and 120000');
  }
  const toolPolicy = env[`${prefix}TOOL_POLICY`] ?? 'none';
  if (!['none', 'workspace-read', 'workspace-edit', 'trusted-exec'].includes(toolPolicy)) throw new Error('Invalid AOD_CLAUDE_TOOL_POLICY');
  const boardDirectory = boardToolsDirectory(env[`${prefix}BOARD_TOOLS_DIR`], [sdkDirectory, homeDirectory, workspace, apiKeyFile], platform);
  const gitBashPath = env[`${prefix}GIT_BASH_PATH`] !== undefined ? absolute('GIT_BASH_PATH') : undefined;
  return { sdkDirectory, homeDirectory, workspace, apiKeyFile, model, modelChoices, ...(gitBashPath ? { gitBashPath } : {}), ...(boardDirectory ? { boardToolsDirectory: boardDirectory } : {}), toolPolicy: toolPolicy as NonNullable<ClaudeConfig['toolPolicy']>,
    baseUrl: url.href.replace(/\/$/, ''), startupTimeoutMs, compactTimeoutMs: sdkCompactTimeout(env, prefix) };
}
