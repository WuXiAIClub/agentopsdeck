import { constants as fsConstants } from 'node:fs';
import { chmod, copyFile, lstat, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export type OpenClawModelPatchResult = { changed: boolean; backupFile?: string; restartRequired: boolean; observed: Array<{ alias: string }> };
export type OpenClawModelPatchOptions = { checkWriteAuthority?: () => void | Promise<void> };

export const MAX_OPENCLAW_CONFIG_BYTES = 1024 * 1024;

type OpenClawModels = Record<string, unknown>;
type VerifiedConfigTarget = {
  parentPath: string;
  parentRealPath: string;
  parentDev: number;
  parentIno: number;
  dev: number;
  ino: number;
  mode: number;
};

export async function readOpenClawModels(configFile: string): Promise<Array<{ alias: string }>> {
  const { parsed } = await readConfig(configFile);
  const models = (parsed as any)?.agents?.defaults?.models;
  if (models === undefined) return [];
  assertModelMap(models);
  return Object.keys(models).map((alias) => ({ alias }));
}

export async function patchOpenClawModels(
  configFile: string,
  dryRun = false,
  aliases: string[] = [],
  options?: OpenClawModelPatchOptions,
): Promise<OpenClawModelPatchResult> {
  if (!dryRun) await options?.checkWriteAuthority?.();
  const { parsed, target } = await readConfig(configFile);
  const current = (parsed as any)?.agents?.defaults?.models;
  if (current !== undefined) assertModelMap(current);

  // Explicit opt-in, additive only: never discard another provider's models
  // or overwrite existing per-model options when applying the configured set.
  const desired = { ...Object.fromEntries(aliases.map(alias => [alias, {}])), ...(current as OpenClawModels ?? {}) };
  const desiredObserved = Object.keys(desired).map((alias) => ({ alias }));
  const changed = JSON.stringify(current ?? {}) !== JSON.stringify(desired);
  if (!changed || dryRun) return { changed: false, restartRequired: changed, observed: desiredObserved };

  const next: any = { ...(parsed as any) };
  next.agents = { ...(next.agents ?? {}) };
  next.agents.defaults = { ...(next.agents.defaults ?? {}) };
  next.agents.defaults.models = desired;
  const serialized = JSON.stringify(next, null, 2);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_OPENCLAW_CONFIG_BYTES) {
    throw new Error('OpenClaw config exceeds maximum size budget');
  }
  const backupFile = `${configFile}.agentopsdeck-backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const tmp = join(target.parentPath, `.openclaw.${randomUUID()}.tmp`);
  let backupCreated = false;
  let tmpCreated = false;
  try {
    await options?.checkWriteAuthority?.();
    await verifySameConfigTarget(configFile, target);
    await copyFile(configFile, backupFile, fsConstants.COPYFILE_EXCL);
    backupCreated = true;
    await chmod(backupFile, target.mode);

    await options?.checkWriteAuthority?.();
    await verifySameConfigTarget(configFile, target);
    await writeFile(tmp, serialized, { flag: 'wx', mode: target.mode });
    tmpCreated = true;
    await chmod(tmp, target.mode);

    await options?.checkWriteAuthority?.();
    await verifySameConfigTarget(configFile, target);
    await rename(tmp, configFile);
    tmpCreated = false;
    return { changed: true, backupFile, restartRequired: true, observed: desiredObserved };
  } catch (error) {
    if (tmpCreated) await unlink(tmp).catch(() => {});
    if (backupCreated) await unlink(backupFile).catch(() => {});
    throw error;
  }
}


function assertModelMap(value: unknown): asserts value is OpenClawModels {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid OpenClaw config: agents.defaults.models must be an object map');
  }
}

async function inspectConfigTarget(configFile: string): Promise<VerifiedConfigTarget> {
  const resolvedFile = resolve(configFile);
  const parentPath = dirname(resolvedFile);
  const parentStats = await lstat(parentPath);
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    throw new Error('invalid OpenClaw config parent directory');
  }
  const parentRealPath = await realpath(parentPath);
  const stats = await lstat(configFile);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
    throw new Error('invalid OpenClaw config path');
  }
  if (stats.size > MAX_OPENCLAW_CONFIG_BYTES) {
    throw new Error('OpenClaw config exceeds maximum size budget');
  }
  return {
    parentPath,
    parentRealPath,
    parentDev: parentStats.dev,
    parentIno: parentStats.ino,
    dev: stats.dev,
    ino: stats.ino,
    mode: (stats.mode & 0o777) || 0o600,
  };
}

async function verifySameConfigTarget(configFile: string, expected: VerifiedConfigTarget): Promise<void> {
  const current = await inspectConfigTarget(configFile);
  if (
    current.parentRealPath !== expected.parentRealPath
    || current.parentDev !== expected.parentDev
    || current.parentIno !== expected.parentIno
    || current.dev !== expected.dev
    || current.ino !== expected.ino
  ) {
    throw new Error('OpenClaw config changed concurrently');
  }
}

async function readConfig(configFile: string): Promise<{ parsed: Record<string, unknown>; target: VerifiedConfigTarget }> {
  const target = await inspectConfigTarget(configFile);
  const raw = await readFile(configFile, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_OPENCLAW_CONFIG_BYTES) {
    throw new Error('OpenClaw config exceeds maximum size budget');
  }
  await verifySameConfigTarget(configFile, target);
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid OpenClaw config: root must be a JSON object');
  }
  return { parsed: parsed as Record<string, unknown>, target };
}
