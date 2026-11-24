import { lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AOD_MODEL_SET_ID, type GatewayModelSetStatus } from '@agentopsdeck/shared';
import type { ServerConfig } from '../config.js';
import { patchOpenClawModels, readOpenClawModels, type OpenClawModelPatchOptions } from './openclaw-config.js';

export function openClawConfigFile(config: ServerConfig) {
  return config.connector.openclawConfigFile ?? config.nativeFileRoots.configFile;
}

export async function readGatewayModelSetStatus(config: ServerConfig): Promise<GatewayModelSetStatus> {
  const file = openClawConfigFile(config);
  const desired = (config.connector.modelAliases ?? []).map(alias => ({ alias }));
  try {
    const parentStats = await lstat(dirname(resolve(file)));
    if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
      return status(desired, [], 'openclaw.config', false, 'invalid openclaw config path');
    }
    const stats = await lstat(file);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
      return status(desired, [], 'openclaw.config', false, 'invalid openclaw config path');
    }
  } catch (error: any) {
    if (error?.code === 'ENOENT') return status(desired, [], 'unknown', false, 'openclaw config not found');
    return status(desired, [], 'openclaw.config', false, 'invalid openclaw config path');
  }
  try {
    const observed = await readOpenClawModels(file);
    return status(desired, observed, 'openclaw.config', true, undefined, config.connector.gatewayVersion);
  } catch (error) {
    return status(desired, [], 'openclaw.config', false, redactError(error));
  }
}

export async function reconcileGatewayModelSet(config: ServerConfig, dryRun = false, options?: OpenClawModelPatchOptions) {
  if (!dryRun) await options?.checkWriteAuthority?.();
  const before = await readGatewayModelSetStatus(config);
  if (before.converged) return { ok: true, changed: false, status: before };
  if (!before.compatible && before.error) return { ok: true, changed: false, status: before };
  const result = await patchOpenClawModels(openClawConfigFile(config), dryRun, config.connector.modelAliases ?? [], options);
  const after = dryRun ? { ...before, restartRequired: true } : await readGatewayModelSetStatus(config);
  return { ok: true, changed: result.changed, backupCreated: Boolean(result.backupFile), restartRequired: result.restartRequired, status: { ...after, restartRequired: result.restartRequired } };
}

function status(desired: Array<{ alias: string }>, observed: Array<{ alias: string }>, source: GatewayModelSetStatus['source'], compatible: boolean, error?: string, gatewayVersion?: string): GatewayModelSetStatus {
  const desiredAliases = desired.map((m) => m.alias);
  const observedAliases = observed.map((m) => m.alias);
  const missing = desiredAliases.filter((alias) => !observedAliases.includes(alias));
  const extra = observedAliases.filter((alias) => !desiredAliases.includes(alias));
  return { setId: AOD_MODEL_SET_ID, desired, observed, missing, extra, converged: missing.length === 0, source, compatible, gatewayVersion, updatedAt: Date.now(), ...(error ? { error } : {}) };
}
function redactError(error: unknown) { return error instanceof Error ? error.message.replace(/(token|secret|password)[^,}\n]*/ig, '$1=[redacted]') : 'unknown error'; }
