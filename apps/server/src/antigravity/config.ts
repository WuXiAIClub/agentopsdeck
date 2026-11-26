import { posix, win32 } from 'node:path';
import { parseSdkModelChoices, validSdkModel } from '../connector/sdk-models.js';

export type AntigravityConfig = {
  command: string;
  homeDirectory: string;
  workspace: string;
  startupTimeoutMs: number;
  permissionMode?: 'deny' | 'allow';
  model?: string;
  modelChoices?: string[];
};

const prefix = 'AOD_ANTIGRAVITY_';

function privatePath(value: string | undefined, platform: NodeJS.Platform) {
  const paths = platform === 'win32' ? win32 : posix;
  if (!value || !paths.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw Error('Invalid Antigravity private path');
  const normalized = paths.normalize(value);
  if (normalized !== value || normalized === paths.parse(normalized).root
    || platform === 'win32' && (!/^[A-Za-z]:\\/.test(normalized)
      || /[:"<>|?*]/.test(normalized.slice(2))
      || normalized.slice(3).split('\\').some(part => /[. ]$/.test(part)))) {
    throw Error('Invalid Antigravity private path');
  }
  return normalized;
}

function overlaps(left: string, right: string, platform: NodeJS.Platform) {
  const paths = platform === 'win32' ? win32 : posix;
  const normalizedLeft = platform === 'win32' ? paths.normalize(left).toLowerCase() : paths.normalize(left);
  const normalizedRight = platform === 'win32' ? paths.normalize(right).toLowerCase() : paths.normalize(right);
  const within = (root: string, target: string) => {
    const relative = paths.relative(root, target);
    return !relative || !paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${paths.sep}`);
  };
  return within(normalizedLeft, normalizedRight) || within(normalizedRight, normalizedLeft);
}

export function antigravityConfig(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): AntigravityConfig | undefined {
  const enabled = env[`${prefix}ENABLED`];
  if (!enabled || enabled === 'false') return;
  if (enabled !== 'true') throw Error('AOD_ANTIGRAVITY_ENABLED must be true or false');
  if (env[`${prefix}DEDICATED`] !== 'true') throw Error('Antigravity requires an exclusively owned private home');
  const absolute = (name: string) => {
    try { return privatePath(env[`${prefix}${name}`], platform); }
    catch { throw Error(`${prefix}${name} must be an absolute, canonical, non-root path`); }
  };
  const command = absolute('COMMAND'), homeDirectory = absolute('HOME'), workspace = absolute('WORKSPACE');
  if (overlaps(homeDirectory, workspace, platform) || overlaps(homeDirectory, command, platform)
    || overlaps(workspace, command, platform)
    || [env.HOME, env.USERPROFILE].some(path => path && (platform === 'win32'
      ? win32.normalize(path).toLowerCase() === homeDirectory.toLowerCase() : posix.normalize(path) === homeDirectory))
    || [env.AOD_RUNTIME_DIR, env.AOD_CODEX_HOME, env.AOD_CLAUDE_HOME, env.AOD_COPILOT_HOME, env.AOD_HERMES_HOME]
      .some(path => path && overlaps(path, homeDirectory, platform))) {
    throw Error('Antigravity home, executable, workspace and existing runtime locations must be separated');
  }
  const rawTimeout = env[`${prefix}STARTUP_TIMEOUT_MS`] ?? '30000';
  const startupTimeoutMs = Number(rawTimeout);
  if (!/^\d+$/.test(rawTimeout) || !Number.isSafeInteger(startupTimeoutMs)
    || startupTimeoutMs < 1000 || startupTimeoutMs > 120000) {
    throw Error('AOD_ANTIGRAVITY_STARTUP_TIMEOUT_MS must be between 1000 and 120000');
  }
  const rawPermissionMode = env[`${prefix}PERMISSION_MODE`] ?? 'allow';
  if (rawPermissionMode !== 'allow' && rawPermissionMode !== 'deny') {
    throw Error('AOD_ANTIGRAVITY_PERMISSION_MODE must be allow or deny');
  }
  const rawModel = env[`${prefix}MODEL`]?.trim();
  if (rawModel !== undefined && rawModel !== '' && !validSdkModel(rawModel)) {
    throw Error('AOD_ANTIGRAVITY_MODEL must be a valid model identifier');
  }
  const model = rawModel || undefined;
  const rawModelChoices = env[`${prefix}MODEL_CHOICES`]?.trim();
  const modelChoices = rawModelChoices
    ? (model
      ? parseSdkModelChoices(model, rawModelChoices)
      : parseSdkModelChoices('default', rawModelChoices).filter(item => item !== 'default'))
    : undefined;
  return {
    command,
    homeDirectory,
    workspace,
    startupTimeoutMs,
    permissionMode: rawPermissionMode,
    ...(model ? { model } : {}),
    ...(modelChoices?.length ? { modelChoices } : {}),
  };
}
