export type RecoveryPageSource = (after: string, limit: number) => string[] | Promise<string[]>;
const binary = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const key = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && !value.includes('\0') && Buffer.byteLength(value) <= 4096;

/** One bounded page per original journal; no replacement queue or replay.
 * Recheck local ownership after each await, before starting the next read. */
export async function readRecoveryPage(after: string, limit: number,
  sources: readonly RecoveryPageSource[], isCurrent: () => boolean): Promise<string[]> {
  if (typeof after !== 'string' || after.includes('\0') || Buffer.byteLength(after) > 4096
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw Error('Recovery page unavailable');
  const keys = new Set<string>();
  for (const source of sources) {
    if (!isCurrent()) return [];
    const page = await source(after, limit);
    if (!isCurrent()) return [];
    if (!Array.isArray(page) || page.length > limit
      || page.some((value, index) => !key(value) || binary(value, after) <= 0
        || index > 0 && binary(page[index - 1]!, value) >= 0)) throw Error('Recovery page unavailable');
    for (const value of page) keys.add(value);
  }
  return isCurrent() ? [...keys].sort(binary).slice(0, limit) : [];
}
