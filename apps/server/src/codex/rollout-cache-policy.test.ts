import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_ROLLOUT_CACHE_POLICY, rolloutCachePolicy, rolloutCachePolicyFromEnv } from './rollout-cache-policy.js';
import { loadConfig } from '../config.js';

test('history cache policy supports multi-pane readers without increasing byte budgets', () => {
  assert.deepEqual(rolloutCachePolicyFromEnv({}), DEFAULT_ROLLOUT_CACHE_POLICY);
  assert.equal(rolloutCachePolicy().maxEntries, 16);
  assert.equal(rolloutCachePolicy().maxMemoryBytes, 96 * 1024 * 1024);
  assert.equal(rolloutCachePolicy().maxDiskBytes, 4 * 1024 ** 3);
});
test('operator history cache config reaches the runtime config with explicit units', () => {
  const env = { AOD_CODEX_HISTORY_CACHE_ENTRIES: '8', AOD_CODEX_HISTORY_CACHE_MEMORY_MIB: '32',
    AOD_CODEX_HISTORY_CACHE_DISK_MIB: '512', AOD_CODEX_HISTORY_CACHE_IDLE_SECONDS: '60' };
  const expected = { maxEntries: 8, maxMemoryBytes: 32 * 1024 ** 2, maxDiskBytes: 512 * 1024 ** 2, maxIdleMs: 60_000 };
  assert.deepEqual(rolloutCachePolicyFromEnv(env), expected);
  assert.deepEqual(loadConfig(env).codex.historyCache, expected);
});
test('history cache limits reject invalid or unbounded operator settings', () => {
  for (const value of ['-1', '0', '129', 'NaN', '1.5', 'Infinity', '1e2'])
    assert.throws(() => rolloutCachePolicyFromEnv({ AOD_CODEX_HISTORY_CACHE_ENTRIES: value }));
  for (const value of [NaN, Infinity, -1, 0.5, 1024 ** 4])
    assert.throws(() => rolloutCachePolicy({ maxMemoryBytes: value }));
  assert.throws(() => rolloutCachePolicy({ maxIdleMs: 0 }));
  assert.throws(() => rolloutCachePolicyFromEnv({ AOD_CODEX_HISTORY_CACHE_DISK_MIB: '4097' }));
  assert.equal(rolloutCachePolicy({ maxDiskBytes: 0 }).maxDiskBytes, 0);
});
