export type StartupAuthStatus = { authenticated: boolean; recoveryScope?: string };

/** Read only. An aborted/stale read cannot choose an account, unlock the UI,
 * or turn temporary storage failure into a confirmed sign-out. */
export async function readStartupAuth(read: (signal: AbortSignal) => Promise<StartupAuthStatus>,
  signal: AbortSignal): Promise<StartupAuthStatus | undefined> {
  if (signal.aborted) return undefined;
  const status = await read(signal);
  if (signal.aborted) return undefined;
  if (!status || typeof status.authenticated !== 'boolean'
    || status.recoveryScope !== undefined && (typeof status.recoveryScope !== 'string' || !/^[a-f0-9]{64}$/.test(status.recoveryScope))) {
    throw new Error('Invalid authentication status');
  }
  return { authenticated: status.authenticated,
    ...(status.recoveryScope === undefined ? {} : { recoveryScope: status.recoveryScope }) };
}
