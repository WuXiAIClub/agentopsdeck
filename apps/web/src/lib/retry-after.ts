/** Read-only retry advice. Bounded so a broken proxy cannot suspend a pane
 * indefinitely; HTTP-date and delta-seconds use the same millisecond contract. */
export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (!value || value.length > 128) return;
  const normalized = value.trim();
  // Date.parse also accepts malformed numeric advice such as "1.5" as a date.
  const ms = /^\d+$/.test(normalized) ? Number(normalized) * 1000
    : /^[A-Za-z]{3}, /.test(normalized) ? Date.parse(normalized) - now : NaN;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 60_000) : undefined;
}
