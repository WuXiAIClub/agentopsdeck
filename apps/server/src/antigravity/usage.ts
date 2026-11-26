import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AntigravityQuotaWindow, AntigravityUsage } from '@agentopsdeck/shared';
import type { AntigravityConfig } from './config.js';
import { antigravityEnvironment, verifyAntigravityEnvironment } from './environment.js';

const run = promisify(execFile);
const text = (value: unknown): value is string => typeof value === 'string'
  && value.trim().length > 0 && value.length <= 120 && !/[\p{Cc}\p{Cf}]/u.test(value);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const unavailable = () => Error('antigravity_usage_unavailable');

export function parseAntigravityUsage(stdout: string, sampledAt: number): AntigravityUsage {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw unavailable(); }
  const root = record(value), command = record(root?.command), groups = record(command?.data)?.groups;
  if (root?.status !== 'SUCCESS' || command?.name !== 'usage' || !Array.isArray(groups) || groups.length > 20) throw unavailable();
  const names = new Set<string>();
  return { sampledAt, groups: groups.map(entry => {
    const group = record(entry);
    if (!group || !text(group.name) || names.has(group.name) || !Array.isArray(group.buckets)
      || group.buckets.length === 0 || group.buckets.length > 20) throw unavailable();
    names.add(group.name);
    const ids = new Set<string>();
    const windows = group.buckets.map((entry): AntigravityQuotaWindow => {
      const bucket = record(entry);
      if (!bucket) throw unavailable();
      const { id, window, remaining_fraction: remainingFraction, reset_time: resetTime } = bucket;
      if (!text(id) || ids.has(id) || !text(window) || typeof remainingFraction !== 'number'
        || !Number.isFinite(remainingFraction) || remainingFraction < 0 || remainingFraction > 1) throw unavailable();
      ids.add(id);
      const resetAt = resetTime == null || resetTime === '' ? null
        : typeof resetTime === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(resetTime)
          ? Date.parse(resetTime) : NaN;
      if (resetAt !== null && !Number.isFinite(resetAt)) throw unavailable();
      return { id, window, remainingFraction, resetAt };
    });
    return { name: group.name, windows };
  }) };
}

export function createAntigravityUsageReader(config: AntigravityConfig) {
  let inflight: Promise<AntigravityUsage> | undefined;
  let cached: { expiresAt: number; value?: AntigravityUsage } | undefined;
  return async (): Promise<AntigravityUsage> => {
    if (inflight) return inflight;
    if (cached && performance.now() < cached.expiresAt) {
      if (cached.value) return cached.value;
      throw unavailable();
    }
    inflight = Promise.resolve().then(async () => {
      try {
        verifyAntigravityEnvironment(config);
        const { stdout } = await run(config.command, ['--output-format', 'json', '-p', '/usage'], {
          cwd: config.homeDirectory, env: antigravityEnvironment(config), timeout: 15_000,
          maxBuffer: 128 * 1024, killSignal: 'SIGKILL',
        });
        const value = parseAntigravityUsage(stdout, Date.now());
        cached = { value, expiresAt: performance.now() + 30_000 };
        return value;
      } catch {
        cached = { expiresAt: performance.now() + 5_000 };
        throw unavailable();
      } finally { inflight = undefined; }
    });
    return inflight;
  };
}
