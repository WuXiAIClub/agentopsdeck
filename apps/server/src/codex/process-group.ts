import { readFile, readdir } from 'node:fs/promises';

const scans = new Map<number, Promise<boolean>>();
const PROC_READ_CONCURRENCY = 16;

export async function linuxProcessGroupRunning(groupId: number) {
  if (!Number.isSafeInteger(groupId) || groupId <= 0) throw new Error('Invalid native process group');
  const pending = scans.get(groupId);
  if (pending) return pending;
  const task = inspectProcessGroup(groupId);
  scans.set(groupId, task);
  try { return await task; }
  finally { if (scans.get(groupId) === task) scans.delete(groupId); }
}

async function inspectProcessGroup(groupId: number) {
  // Kernel group existence does not require reading unrelated users' /proc
  // entries. ESRCH is positive drain evidence even on hidepid installations.
  // EPERM/unknown errors still retain ownership; never treat them as drained.
  try { process.kill(-groupId, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
  const names = (await readdir('/proc')).filter(name => /^\d+$/.test(name));
  for (let offset = 0; offset < names.length; offset += PROC_READ_CONCURRENCY) {
    // Settle the whole bounded batch before returning or throwing. Do not
    // leave dangling reads that accumulate across failed drain attempts.
    const results = await Promise.allSettled(names.slice(offset, offset + PROC_READ_CONCURRENCY).map(async name => {
      let stat;
      try { stat = await readFile(`/proc/${name}/stat`, 'utf8'); }
      catch (error) {
        if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
        throw error;
      }
      const boundary = stat.lastIndexOf(') ');
      const fields = stat.slice(boundary + 2).trim().split(/\s+/);
      if (boundary < 0 || !/^[A-Z]$/.test(fields[0] ?? '') || !/^\d+$/.test(fields[2] ?? '')
        || !Number.isSafeInteger(Number(fields[2]))) throw new Error('Invalid native process status');
      return Number(fields[2]) === groupId && !['Z', 'X'].includes(fields[0]!);
    }));
    // A positive live member is sufficient even if unrelated entries cannot
    // be inspected. Absence requires every read to be known or already gone.
    if (results.some(result => result.status === 'fulfilled' && result.value)) return true;
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
  return false;
}

export const LINUX_PROCESS_GROUP_SIGKILL_GRACE_MS = 10_000;

export async function waitForLinuxProcessGroupExit(
  groupId: number,
  options: { sigkillAfterMs?: number; pollMs?: number } = {},
) {
  const sigkillAfterMs = options.sigkillAfterMs ?? LINUX_PROCESS_GROUP_SIGKILL_GRACE_MS;
  const pollMs = options.pollMs ?? 50;
  const startedAt = Date.now();
  let warned = false;
  let escalated = false;
  for (;;) {
    try { if (!await linuxProcessGroupRunning(groupId)) return; }
    catch {
      if (!warned) console.warn('[codex] Cannot verify native process group drain; retaining runtime ownership');
      warned = true;
    }
    if (!escalated && sigkillAfterMs >= 0 && Date.now() - startedAt >= sigkillAfterMs) {
      escalated = true;
      console.warn(`[codex] Native process group ${groupId} did not exit after ${sigkillAfterMs}ms; escalating to SIGKILL`);
      try { process.kill(-groupId, 'SIGKILL'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      }
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}
