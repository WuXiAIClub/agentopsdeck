import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validSdkModel } from '../connector/sdk-models.js';
import type { AntigravityConfig } from './config.js';
import { antigravityEnvironment, verifyAntigravityEnvironment } from './environment.js';

const run = promisify(execFile);
const labelText = (value: unknown): value is string => typeof value === 'string'
  && value.trim().length > 0 && value.length <= 120 && !/[\p{Cc}\p{Cf}]/u.test(value);
const unavailable = () => Error('antigravity_models_unavailable');

export type AntigravityModelEntry = {
  id: string;
  label: string;
};

/** Parse `agy models` piped stdout (`<id>\t<label>` or `<id>` per line). */
export function parseAntigravityModels(stdout: string): AntigravityModelEntry[] {
  if (typeof stdout !== 'string') throw unavailable();
  const entries: AntigravityModelEntry[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const tab = rawLine.indexOf('\t');
    const id = (tab >= 0 ? rawLine.slice(0, tab) : trimmed).trim();
    const rawLabel = tab >= 0 ? rawLine.slice(tab + 1).trim() : '';
    const label = rawLabel || id;
    if (!validSdkModel(id) || !labelText(label)) throw unavailable();
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({ id, label });
    if (entries.length > 100) throw unavailable();
  }
  if (entries.length === 0) throw unavailable();
  return entries;
}

export function mergeAntigravityModels(
  discovered: readonly AntigravityModelEntry[],
  defaultModel?: string,
): AntigravityModelEntry[] {
  const result: AntigravityModelEntry[] = [];
  const seen = new Set<string>();
  if (defaultModel && defaultModel !== 'default' && validSdkModel(defaultModel)) {
    const match = discovered.find(item => item.id === defaultModel);
    result.push(match ? { id: match.id, label: match.label } : { id: defaultModel, label: defaultModel });
    seen.add(defaultModel);
  }
  for (const item of discovered) {
    if (seen.has(item.id)) continue;
    if (result.length >= 100) break;
    seen.add(item.id);
    result.push({ id: item.id, label: item.label });
  }
  return result;
}

export function createAntigravityModelsReader(
  config: AntigravityConfig,
  options: { cacheTtlMs?: number; errorTtlMs?: number; now?: () => number } = {},
) {
  const cacheTtlMs = options.cacheTtlMs ?? 60_000;
  const errorTtlMs = options.errorTtlMs ?? 5_000;
  const clock = options.now ?? (() => performance.now());
  let inflight: Promise<AntigravityModelEntry[]> | undefined;
  let cached: { expiresAt: number; value?: AntigravityModelEntry[] } | undefined;
  let lastKnown: AntigravityModelEntry[] | undefined;

  return async (): Promise<AntigravityModelEntry[]> => {
    if (inflight) return inflight;
    if (cached && clock() < cached.expiresAt) {
      if (cached.value) return cached.value.map(entry => ({ ...entry }));
      if (lastKnown) return lastKnown.map(entry => ({ ...entry }));
      throw unavailable();
    }
    inflight = Promise.resolve().then(async () => {
      try {
        verifyAntigravityEnvironment(config);
        const { stdout } = await run(config.command, ['models'], {
          cwd: config.homeDirectory,
          env: antigravityEnvironment(config),
          timeout: Math.min(config.startupTimeoutMs, 15_000),
          maxBuffer: 128 * 1024,
          killSignal: 'SIGKILL',
        });
        const parsed = mergeAntigravityModels(parseAntigravityModels(stdout), config.model);
        if (parsed.length === 0) throw unavailable();
        lastKnown = parsed;
        cached = { value: parsed, expiresAt: clock() + cacheTtlMs };
        return parsed.map(entry => ({ ...entry }));
      } catch {
        cached = { expiresAt: clock() + errorTtlMs };
        if (lastKnown) return lastKnown.map(entry => ({ ...entry }));
        throw unavailable();
      } finally {
        inflight = undefined;
      }
    });
    return inflight;
  };
}
