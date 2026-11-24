// Run only in a NEW isolated systemd user unit with Delegate=yes. No service,
// credentials, native sessions or existing user data are changed by this probe.
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PrivateWorkerScope, WORKER_SCOPE_ENV, currentWorkerCgroup, enterPrivateWorkerScope } from '../apps/server/dist/connector/private-worker-scope.js';

const self = fileURLToPath(import.meta.url);
if (process.argv[2] === 'worker') {
  enterPrivateWorkerScope('trusted-exec', process.env);
  if (process.argv[3] === 'detached') {
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', cwd: process.cwd() });
    await once(descendant, 'spawn');
    process.send({ ready: true });
    setInterval(() => {}, 1000);
  } else { process.send({ ready: true }); process.disconnect(); }
} else {
  const parent = currentWorkerCgroup();
  assert.match(parent, /agentopsdeck-exec-probe-.*\.service$/, 'Must use a dedicated probe unit, not the business service');
  const launch = (scope, mode) => fork(self, ['worker', mode], {
    cwd: process.cwd(), env: { PATH: '/usr/bin:/bin', [WORKER_SCOPE_ENV]: scope.path },
    detached: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'], execArgv: [],
  });
  const scopes = [];
  let orphan;
  try {
    const normal = new PrivateWorkerScope(); scopes.push(normal);
    const worker = launch(normal, 'normal');
    const exited = once(worker, 'exit');
    await once(worker, 'message');
    assert.deepEqual(await exited, [0, null]); normal.close();
    assert.equal(normal.quiescent(), true);
    assert.equal(existsSync(normal.path), false);

    const detached = new PrivateWorkerScope(); scopes.push(detached);
    const running = launch(detached, 'detached');
    const killed = once(running, 'exit');
    await once(running, 'message');
    assert.equal(detached.quiescent(), false);
    assert.ok(readFileSync(join(detached.path, 'cgroup.procs'), 'utf8').trim().split('\n').length >= 2);
    detached.close(); await killed;
    for (let n = 0; n < 100 && existsSync(detached.path); n++) { await delay(20); detached.close(); }
    assert.equal(existsSync(detached.path), false, 'setsid descendant must not survive owner close');
    assert.equal(detached.quiescent(), false, 'Forced cleanup is not a successful task result');
    assert.equal(detached.cleaned(), true, 'Physical cleanup can be confirmed independently of outcome');

    // Simulate an unowned scope left by a connector-only crash, not an old PID.
    orphan = join(parent, `agentopsdeck-exec-${randomUUID()}`); mkdirSync(orphan);
    const old = launch({ path: orphan }, 'detached');
    const oldExit = once(old, 'exit'); await once(old, 'message');
    assert.throws(() => new PrivateWorkerScope(), /delegated Linux cgroup/);
    assert.match(readFileSync(join(orphan, 'cgroup.events'), 'utf8'), /populated 1/);
    writeFileSync(join(orphan, 'cgroup.kill'), '1'); await oldExit;
    for (let n = 0; n < 100 && /^populated 1$/m.test(readFileSync(join(orphan, 'cgroup.events'), 'utf8')); n++) await delay(20);
    const recovered = new PrivateWorkerScope(); scopes.push(recovered); recovered.close();
    assert.equal(existsSync(orphan), false, 'Empty exact-name leftover is safely reclaimed'); orphan = undefined;
    console.log(JSON.stringify({ verified: true, normalExit: true, detachedCleanup: true, forcedOutcomeUnknown: true, orphanAdmissionBlocked: true }));
  } finally {
    for (const scope of scopes) scope.close();
    if (orphan && existsSync(orphan)) { writeFileSync(join(orphan, 'cgroup.kill'), '1'); try { rmdirSync(orphan); } catch { /* isolated unit stop owns final cleanup */ } }
  }
}
