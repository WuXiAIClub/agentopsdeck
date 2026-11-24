/** Manual summarization may outlast startup; bounded independently of HTTP. */
export function sdkCompactTimeout(env: NodeJS.ProcessEnv, prefix: string): number {
  const raw = env[`${prefix}COMPACT_TIMEOUT_MS`] ?? '600000';
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1000 || value > 1800000) {
    throw new Error(`${prefix}COMPACT_TIMEOUT_MS must be between 1000 and 1800000`);
  }
  return value;
}
