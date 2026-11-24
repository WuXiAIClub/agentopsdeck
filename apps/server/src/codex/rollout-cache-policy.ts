import { maxRolloutFileBytes } from './rollout-limits.js';

export type RolloutCachePolicy = { maxEntries: number; maxMemoryBytes: number; maxDiskBytes: number; maxIdleMs: number };
const MiB = 1024 * 1024;
export const DEFAULT_ROLLOUT_CACHE_POLICY: Readonly<RolloutCachePolicy> = Object.freeze({
  // Multiple viewers can share this Connector; entry count is not a UI limit.
  maxEntries: 16, maxMemoryBytes: 96 * MiB, maxDiskBytes: maxRolloutFileBytes, maxIdleMs: 5 * 60_000,
});

export function rolloutCachePolicy(value: Partial<RolloutCachePolicy> = {}): RolloutCachePolicy {
  const policy = { ...DEFAULT_ROLLOUT_CACHE_POLICY, ...value };
  for (const [key, min, max] of [
    ['maxEntries', 1, 128], ['maxMemoryBytes', 0, 1024 * MiB],
    ['maxDiskBytes', 0, maxRolloutFileBytes], ['maxIdleMs', 1_000, 24 * 60 * 60_000],
  ] as const) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] < min || policy[key] > max) throw Error(`Invalid rollout cache ${key}`);
  }
  return policy;
}

export function rolloutCachePolicyFromEnv(env: NodeJS.ProcessEnv): RolloutCachePolicy {
  const value: Partial<RolloutCachePolicy> = {};
  for (const [name, key, scale] of [
    ['AOD_CODEX_HISTORY_CACHE_ENTRIES', 'maxEntries', 1],
    ['AOD_CODEX_HISTORY_CACHE_MEMORY_MIB', 'maxMemoryBytes', MiB],
    ['AOD_CODEX_HISTORY_CACHE_DISK_MIB', 'maxDiskBytes', MiB],
    ['AOD_CODEX_HISTORY_CACHE_IDLE_SECONDS', 'maxIdleMs', 1_000],
  ] as const) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    if (!/^\d+$/.test(raw)) throw Error(`Invalid ${name}: expected a non-negative integer`);
    value[key] = Number(raw) * scale;
  }
  return rolloutCachePolicy(value);
}
