export type AntigravityQuotaWaitState = {
  retryAt: number;
  retryAfterMs: number;
  detectedAt: number;
  reason: string;
  rawDuration?: string;
  autoRetry: boolean;
};

const MIN_QUOTA_WAIT_MS = 1_000;
const MAX_QUOTA_WAIT_MS = 48 * 60 * 60 * 1_000;

const QUOTA_SIGNAL_RE = /\b(?:quota\s+reached|individual\s+quota|rate\s+limit(?:ed)?|usage\s+limit|limit\s+reached|too\s+many\s+requests)\b/i;

const DURATION_PHRASE_RE = /(?:resets?\s+in|retry\s+(?:in|after)|try\s+again\s+in|available\s+in)\s+((?:\d+\s*(?:d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)\s*)+)/i;

const DURATION_PART_RE = /(\d+)\s*(d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)/gi;

export function parseQuotaDurationMs(raw: string): number | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  let totalMs = 0;
  let matchedAny = false;
  DURATION_PART_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DURATION_PART_RE.exec(raw)) !== null) {
    const amount = Number(match[1]);
    const unit = (match[2] ?? '').toLowerCase();
    if (!Number.isFinite(amount) || amount < 0) continue;
    matchedAny = true;
    if (unit.startsWith('d')) totalMs += amount * 86_400_000;
    else if (unit.startsWith('h')) totalMs += amount * 3_600_000;
    else if (unit.startsWith('m')) totalMs += amount * 60_000;
    else if (unit.startsWith('s')) totalMs += amount * 1_000;
  }
  if (!matchedAny || totalMs <= 0) return undefined;
  return Math.max(MIN_QUOTA_WAIT_MS, Math.min(MAX_QUOTA_WAIT_MS, Math.round(totalMs)));
}

/** Parses Antigravity quota-reached notices such as:
 * "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h9m53s."
 */
export function parseAntigravityQuotaWait(
  text: string | undefined,
  now = Date.now(),
): AntigravityQuotaWaitState | undefined {
  if (!text || typeof text !== 'string') return undefined;
  if (!QUOTA_SIGNAL_RE.test(text)) return undefined;
  const durationMatch = DURATION_PHRASE_RE.exec(text);
  if (!durationMatch?.[1]) return undefined;
  const rawDuration = durationMatch[1].trim().replace(/[.\s]+$/, '');
  const retryAfterMs = parseQuotaDurationMs(rawDuration);
  if (!retryAfterMs) return undefined;
  const detectedAt = Number.isSafeInteger(now) && now >= 0 ? now : Date.now();
  return {
    retryAt: detectedAt + retryAfterMs,
    retryAfterMs,
    detectedAt,
    reason: `Individual quota reached · resets in ${rawDuration}`,
    rawDuration,
    autoRetry: true,
  };
}

export function formatQuotaCountdown(remainingMs: number): string {
  const safe = Math.max(0, Math.ceil(remainingMs / 1_000));
  const days = Math.floor(safe / 86_400);
  const hours = Math.floor((safe % 86_400) / 3_600);
  const minutes = Math.floor((safe % 3_600) / 60);
  const seconds = safe % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (days > 0) return `${days}d ${hours}h ${pad(minutes)}m`;
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}
