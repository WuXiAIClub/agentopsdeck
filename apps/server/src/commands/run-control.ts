// A delayed control must never retarget whatever happens to be running now.
export class RunControlConflict extends Error {
  constructor() { super('Run changed or is not identified; refresh before requesting control'); }
}

export function requireExpectedRun(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) throw new RunControlConflict();
  return value;
}
