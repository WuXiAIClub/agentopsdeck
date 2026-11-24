// Worker and descendants run under a fresh HOME;
// this is credential/config isolation, NOT an OS/network security sandbox.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

/** Called by the probe before sending a start command to a nested detached
 * worker. IPC belongs to this harness; neither prompts nor secrets travel. */
export function registerIsolatedProbeGroup(pid) {
  assert.ok(process.send && Number.isSafeInteger(pid) && pid > 1);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Probe group registration timed out')), 5000);
    const receive = message => { if (message?.kind === 'sdk-probe-group-registered' && message.pid === pid) finish(); };
    const disconnected = () => finish(new Error('Probe supervisor disconnected'));
    function finish(error) {
      clearTimeout(timeout); process.off('message', receive); process.off('disconnect', disconnected);
      if (error) reject(error); else resolve();
    }
    process.on('message', receive); process.once('disconnect', disconnected);
    process.send({ kind: 'sdk-probe-group', pid }, error => { if (error) finish(error); });
  });
}

export async function runIsolatedSdkProbe(script, sdkRoot, timeoutMs = 90_000, probeArgs = [], { retainEvidence = false } = {}) {
  assert.ok(sdkRoot && isAbsolute(sdkRoot), 'An absolute isolated SDK installation is required');
  // The owned process-group cleanup below is POSIX-specific. Do not silently
  // claim equivalent process cleanup on an untested platform.
  assert.equal(process.platform, 'linux', 'This acceptance runner currently requires Linux');
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-native-sdk-'));
  const env = {
    PATH: `${dirname(process.execPath)}:/bin`, HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'), COPILOT_HOME: join(root, 'copilot'),
    TMPDIR: join(root, 'tmp'), LANG: 'C.UTF-8',
    AOD_SDK_PROBE_WORKER: root,
  };
  let child;
  let timer;
  let expired = false;
  let exited = false, interrupted = false;
  const groups = new Set();
  const killGroup = (signal = 'SIGKILL') => {
    // Do not signal a cached group leader PID after exit (PID reuse).
    if (!child?.pid || exited) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const cancel = () => { interrupted = true; killGroup('SIGTERM'); };
  const groupGone = pid => { try { process.kill(-pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };
  const registering = new Set();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    for (const dir of Object.values(env).filter(value => value.startsWith(root + '/'))) await mkdir(dir);
    child = spawn(process.execPath, [script, sdkRoot, ...probeArgs], { cwd: root, env, detached: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    child.once('exit', () => { exited = true; });
    child.on('message', message => {
      if (message?.kind !== 'sdk-probe-group' || !Number.isSafeInteger(message.pid) || message.pid < 2) return;
      const registration = (async () => {
        const stat = await readFile(`/proc/${message.pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
        let parent = Number(fields[1]);
        if (parent !== child.pid) {
          // Full-service acceptance has one additional child host. It must
          // still belong to this probe's group and be its direct child.
          const host = await readFile(`/proc/${parent}/stat`, 'utf8');
          const hostFields = host.slice(host.lastIndexOf(')') + 1).trim().split(/\s+/);
          assert.equal(Number(hostFields[2]), child.pid, 'Service host must remain in the probe group');
          parent = Number(hostFields[1]);
        }
        assert.equal(parent, child.pid, 'Nested group must descend from this probe');
        assert.equal(Number(fields[2]), message.pid, 'Nested worker must lead its own group');
        groups.add(message.pid);
        if (child.connected) child.send({ kind: 'sdk-probe-group-registered', pid: message.pid }, () => {});
      })();
      registering.add(registration);
      void registration.catch(() => { expired = true; killGroup(); }).finally(() => registering.delete(registration));
    });
    timer = setTimeout(() => { expired = true; killGroup(); }, timeoutMs);
    const [code, signal] = await once(child, 'exit');
    assert.ok(!expired, 'Isolated SDK probe timed out; owned process group terminated');
    assert.ok(!interrupted, 'Isolated SDK probe interrupted');
    assert.equal(code, 0, `Isolated SDK probe failed (${signal ?? code})`);
  } finally {
    clearTimeout(timer);
    killGroup();
    if (child?.pid && !exited) await once(child, 'exit');
    await Promise.allSettled([...registering]);
    if (child?.pid) groups.add(child.pid);
    // Nested workers keep a referenced 12s own-group cleanup deadline on
    // parent loss. Wait for proof, rather than erasing their live HOME.
    const deadline = performance.now() + 14_000;
    while ([...groups].some(pid => !groupGone(pid)) && performance.now() < deadline) await delay(50);
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
    if ([...groups].some(pid => !groupGone(pid))) {
      throw new Error(`Probe process cleanup unconfirmed; temporary evidence retained at ${root}`);
    }
    // Only the exact directory generated by this invocation; never Agent data.
    if (retainEvidence) console.log(JSON.stringify({ evidence: root, processCleanupVerified: true }));
    else await rm(root, { recursive: true, force: true });
  }
}
