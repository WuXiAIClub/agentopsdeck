const fields = ['ownerFailureCode', 'leaseStage', 'controlReason', 'controlTarget', 'aclReason'] as const;
type Field = typeof fields[number];
export type StartupFailureMetadata = { [K in Field]?: number | undefined };
const allowed: Record<Field, readonly number[]> = {
  ownerFailureCode: [1, 2, 3, 4, 5, 6],
  leaseStage: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24],
  controlReason: [1, 2, 3, 4, 5, 6, 7],
  controlTarget: [1, 2, 3, 4],
  aclReason: [1, 2, 3, 4],
};
const records = new WeakMap<object, StartupFailureMetadata>();
const object = (value: unknown): value is object =>
  typeof value === 'object' && value !== null || typeof value === 'function';

export function readStartupFailure(error: unknown): StartupFailureMetadata {
  try { return object(error) ? { ...records.get(error) } : {}; }
  catch { return {}; }
}
export function startupFailure<T>(error: T, metadata: StartupFailureMetadata, cause?: unknown): T {
  try {
    if (!object(error)) return error;
    const result = { ...readStartupFailure(cause), ...readStartupFailure(error) };
    for (const field of fields) {
      const value = metadata[field];
      if (typeof value === 'number' && allowed[field].includes(value)) result[field] = value;
    }
    records.set(error, result);
  } catch { /* Diagnostics cannot replace the original failure. */ }
  return error;
}
