/** Inspect only native pressure fields, once, without coercion. Callers must
 * catch inspection failures: capacity feedback never owns the original error. */
export function isStorageFull(error: unknown): boolean {
  const failure = error as { code?: unknown; errcode?: unknown } | null;
  const code = failure?.code;
  if (code === 'ENOSPC' || code === 'EDQUOT' || code === 'SQLITE_FULL') return true;
  if (code !== 'ERR_SQLITE_ERROR') return false;
  const result = failure!.errcode;
  return typeof result === 'number' && Number.isSafeInteger(result) && result >= 0 && (result & 255) === 13;
}
