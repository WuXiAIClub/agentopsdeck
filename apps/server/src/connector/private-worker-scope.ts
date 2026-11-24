import { accessSync, constants, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { WindowsWorkerJob } from './windows-worker-job.js';
import { basename, dirname, join } from 'node:path';

export const WORKER_SCOPE_ENV = 'AOD_PRIVATE_WORKER_CGROUP';
const failure = () => new Error('Trusted execution requires a delegated Linux cgroup v2 service');
const prefix = '/sys/fs/cgroup';
const scopeName = /^agentopsdeck-exec-[a-f0-9-]{36}$/;
const owned = new Set<string>();

export function currentWorkerCgroup() {
  const rows = readFileSync('/proc/self/cgroup', 'utf8').trim().split('\n');
  if (process.platform !== 'linux' || rows.length !== 1 || !rows[0]!.startsWith('0::/')) throw failure();
  const path = `${prefix}${rows[0]!.slice(3)}`;
  if (path === `${prefix}/` || realpathSync(path) !== path || statfsSync(path).type !== 0x63677270) throw failure();
  return path;
}

/** A lifecycle boundary for trusted-owner shell execution, NOT a filesystem,
 * network or hostile-code sandbox. setsid/double-fork cannot escape a cgroup.
 * No commands may migrate themselves into a different cgroup. Host admin and
 * same-UID deliberate tampering are outside this trusted execution model. */
export class PrivateWorkerScope {
  readonly path: string;
  private readonly identity: { dev: number; ino: number };
  private removed = false;
  private forced = false;
  constructor() {
    try {
      const parent = currentWorkerCgroup();
      // Only allocate under our OWN delegated service/scope, never a supplied
      // arbitrary cgroup root or a neighbouring service.
      if (!/\.(service|scope)$/.test(basename(parent)) || statSync(parent).uid !== process.getuid?.()) throw failure();
      // After a connector-only crash, do not admit a successor while an old
      // worker scope remains. Never signal an unowned scope or reconstruct
      // ownership from a saved PID. A full service stop handles such recovery.
      for (const name of readdirSync(parent)) {
        const path = join(parent, name);
        if (!scopeName.test(name) || owned.has(path)) continue;
        if (realpathSync(path) !== path || statSync(path).uid !== process.getuid?.()
          || !/^populated 0$/m.test(readFileSync(join(path, 'cgroup.events'), 'utf8'))) throw failure();
        rmdirSync(path); // exact empty leftover only; no recursive removal
      }
      this.path = join(parent, `agentopsdeck-exec-${randomUUID()}`);
      mkdirSync(this.path, { mode: 0o700 });
      this.identity = statSync(this.path);
      try {
        accessSync(join(this.path, 'cgroup.kill'), constants.W_OK);
        accessSync(join(this.path, 'cgroup.procs'), constants.W_OK);
      } catch (error) { rmdirSync(this.path); throw error; }
      owned.add(this.path);
    } catch { throw failure(); }
  }
  private populated() {
    if (this.removed) return false;
    const stat = statSync(this.path);
    if (stat.dev !== this.identity.dev || stat.ino !== this.identity.ino || realpathSync(this.path) !== this.path) throw failure();
    const events = readFileSync(join(this.path, 'cgroup.events'), 'utf8');
    if (!/^populated [01]$/m.test(events)) throw failure();
    return /^populated 1$/m.test(events);
  }
  /** Explicit close or worker exit cleanup. Forced cleanup is never successful
   * completion evidence. The exact cgroup, not a reusable PID, owns descendants. */
  close() {
    try {
      if (this.populated()) { this.forced = true; writeFileSync(join(this.path, 'cgroup.kill'), '1'); }
      if (!this.populated() && !this.removed) { rmdirSync(this.path); this.removed = true; owned.delete(this.path); }
    } catch { this.forced = true; }
  }
  quiescent() {
    return !this.forced && this.cleaned();
  }
  /** Physical cleanup only: killing descendants cannot certify task success. */
  cleaned() {
    try {
      if (this.populated()) return false;
      if (!this.removed) { rmdirSync(this.path); this.removed = true; owned.delete(this.path); }
      return true;
    } catch { return false; }
  }
}

export function createPrivateWorkerScope(config: unknown) {
  if (process.platform === 'win32') return undefined; // child establishes its Job before any SDK/native access
  return !!config && typeof config === 'object' && 'toolPolicy' in config && config.toolPolicy === 'trusted-exec'
    ? new PrivateWorkerScope() : undefined;
}

/** Called by the child before SDK loading, credentials, or any native process.
 * Moving our own PID avoids signalling/moving a saved or reused process ID. */
export function enterPrivateWorkerScope(mode: string | undefined, env: NodeJS.ProcessEnv) {
  if (process.platform === 'win32') {
    if (!WindowsWorkerJob.active() || env[WORKER_SCOPE_ENV] !== undefined) throw failure();
    return;
  }
  const target = env[WORKER_SCOPE_ENV];
  if (mode !== 'trusted-exec') { if (target !== undefined) throw failure(); return; }
  try {
    if (!target || !scopeName.test(basename(target)) || realpathSync(target) !== target
      || dirname(target) !== currentWorkerCgroup() || statSync(target).uid !== process.getuid?.()
      || readFileSync(join(target, 'cgroup.procs'), 'utf8').trim()) throw failure();
    writeFileSync(join(target, 'cgroup.procs'), String(process.pid));
    if (currentWorkerCgroup() !== target) throw failure();
  } catch { throw failure(); }
}

export function verifyPrivateWorkerScope(mode: string | undefined, env: NodeJS.ProcessEnv) {
  if (process.platform === 'win32') {
    if (!WindowsWorkerJob.active() || env[WORKER_SCOPE_ENV] !== undefined) throw failure();
    return;
  }
  const target = env[WORKER_SCOPE_ENV];
  if (mode !== 'trusted-exec') { if (target !== undefined) throw failure(); return; }
  if (!target || !scopeName.test(basename(target)) || currentWorkerCgroup() !== target) throw failure();
}
