export const COMMAND_KEY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const COMMAND_KEY_FUTURE_SKEW_MS = 5 * 60 * 1000;

const noncePattern = '(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})';
const keyPattern = new RegExp(`^cp1:(0|[1-9][0-9]{0,15}):${noncePattern}$`);

export function commandKeyIssuedAt(key: string): number | undefined {
  if (!key.startsWith('cp1:')) return undefined;
  const match = keyPattern.exec(key);
  const timestamp = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(timestamp)) throw new Error('Invalid versioned command key');
  return timestamp;
}

export function createCommandKey(nonce: string, issuedAt = Date.now()): string {
  const key = `cp1:${issuedAt}:${nonce}`;
  commandKeyIssuedAt(key);
  return key;
}
