import { readdir, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { currentWorkerCgroup, WORKER_SCOPE_ENV } from './private-worker-scope.js';
import { WindowsWorkerJob } from './windows-worker-job.js';

/** Linux /proc field 5. comm may contain spaces and ')' characters. */
export function linuxProcessGroup(stat: string): number {
  const end = stat.lastIndexOf(')');
  const fields = stat.slice(end + 1).trim().split(/\s+/);
  const group = Number(fields[2]);
  if (end < 2 || !Number.isSafeInteger(group) || group < 0) throw new Error('Worker process ownership unconfirmed');
  return group;
}

/** Only the LIVE detached worker may call this. Never use a saved leader PID
 * after exit. Disabled detaching tools are a prerequisite, not an OS sandbox. */
export async function privateWorkerGroupEmpty(): Promise<boolean> {
  if (process.platform === 'win32') return WindowsWorkerJob.empty();
  if (process.platform !== 'linux' || linuxProcessGroup(await readFile('/proc/self/stat', 'utf8')) !== process.pid) {
    throw new Error('Worker process ownership unconfirmed');
  }
  const scope = process.env[WORKER_SCOPE_ENV];
  if (scope) {
    if (currentWorkerCgroup() !== scope) throw new Error('Worker execution scope unconfirmed');
    // Include descendants that used setsid and any nested cgroups. Only this
    // still-live worker is excluded; ordinary process-group rules remain below.
    const empty = async (directory: string): Promise<boolean> => {
      const pids = (await readFile(join(directory, 'cgroup.procs'), 'utf8')).trim().split(/\s+/).filter(Boolean);
      if (pids.some(pid => Number(pid) !== process.pid)) return false;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && !await empty(join(directory, entry.name))) return false;
      }
      return true;
    };
    if (!await empty(scope)) return false;
  }
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (linuxProcessGroup(await readFile(`/proc/${name}/stat`, 'utf8')) === process.pid) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  return true;
}

export async function waitForPrivateWorkerGroup(timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await privateWorkerGroupEmpty())) {
    if (performance.now() >= deadline) throw new Error('Private worker descendants remain active');
    await delay(25);
  }
}
