// Opt-in Linux integration check. Creates only its own random, runtime user unit.
// No Connector, provider, production unit or existing runtime data is accessed.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { SystemdConnectorService } from '../apps/server/dist/lifecycle/maintenance-systemd.js';

assert.equal(process.platform, 'linux');
const delegated = process.argv.includes('--delegated');
const execute = promisify(execFile), uid = process.getuid();
const runtimeDirectory = `/run/user/${uid}`;
assert.equal((await stat(runtimeDirectory)).uid, uid);
const directory = await mkdtemp('/tmp/agentopsdeck-systemd-acceptance-');
const unit = `agentopsdeck-maintenance-check-${randomBytes(8).toString('hex')}.service`;
const unitDirectory = join(runtimeDirectory, 'systemd/user'), unitFile = join(unitDirectory, unit);
const env = { ...process.env, XDG_RUNTIME_DIR: runtimeDirectory, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDirectory}/bus` };
const systemctl = async (...args) => (await execute('/usr/bin/systemctl', ['--user', ...args], {
  env, timeout: 15_000, maxBuffer: 64 * 1024, encoding: 'utf8',
})).stdout.trim();
let created = false;
const evidence = { directory, unit, delegated, passed: false, productionUnitsTouched: false, generations: [], cleanup: false };
async function wait(label, check) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
async function workerPids() {
  let pids;
  await wait('test worker', async () => {
    try { pids = JSON.parse(await readFile(join(directory, 'pids.json'), 'utf8')); return pids.length === 2; }
    catch { return false; }
  });
  return pids;
}
const exists = pid => stat(`/proc/${pid}`).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
try {
  await writeFile(join(directory, 'worker.mjs'), `import {spawn} from 'node:child_process';
import {writeFileSync,readFileSync,mkdirSync} from 'node:fs';
const child=spawn(process.execPath,['-e',${JSON.stringify(delegated ? `const fs=require('node:fs');const cg='/sys/fs/cgroup'+fs.readFileSync('/proc/self/cgroup','utf8').trim().slice(3)+'/owned-check';fs.mkdirSync(cg);fs.writeFileSync(cg+'/cgroup.procs',String(process.pid));process.kill(process.pid,'SIGCONT');setInterval(()=>{},1000);` : 'setInterval(()=>{},1000)')}],{stdio:'ignore',detached:true});
writeFileSync('pids.json',JSON.stringify([process.pid,child.pid]));
setInterval(()=>{},1000);
`, { flag: 'wx', mode: 0o600 });
  await mkdir(unitDirectory, { recursive: true });
  await writeFile(unitFile, `[Unit]\nDescription=AgentOpsDeck isolated maintenance acceptance\n[Service]\nType=simple\nWorkingDirectory=${directory}\nExecStart=/usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/node ${directory}/worker.mjs\nKillMode=control-group\nDelegate=${delegated ? 'yes' : 'no'}\nTimeoutStopSec=5\nRestart=no\n`, { flag: 'wx', mode: 0o600 });
  created = true;
  await systemctl('daemon-reload');
  await systemctl('start', unit);
  const controlGroup = await systemctl('show', '--property=ControlGroup', '--value', unit);
  const controller = new SystemdConnectorService({ unit, controlGroup, allowDelegated: delegated, systemctl: '/usr/bin/systemctl',
    run: async args => { assert.equal(args[0], '--user'); return systemctl(...args.slice(1)); } });
  for (let generation = 0; generation < 2; generation++) {
    if (generation) await controller.start();
    await controller.verifyRunning();
    const pids = await workerPids();
    assert.ok((await Promise.all(pids.map(exists))).every(Boolean));
    if (delegated) await wait('owned subgroup', async () =>
      (await readFile(`/proc/${pids[1]}/cgroup`, 'utf8')).trim() === `0::${controlGroup}/owned-check`);
    await controller.stop();
    await controller.verifyStopped();
    await wait('test descendants exit', async () => (await Promise.all(pids.map(exists))).every(value => !value));
    evidence.generations.push({ pids, stoppedAndEmpty: true });
    await unlink(join(directory, 'pids.json'));
  }
  evidence.passed = true;
} catch (error) {
  evidence.error = error instanceof Error ? error.message : 'Systemd check failed'; process.exitCode = 1;
} finally {
  if (created) {
    try {
      await systemctl('stop', unit);
      await unlink(unitFile);
      await systemctl('daemon-reload');
      evidence.cleanup = true;
    } catch { evidence.cleanup = false; evidence.passed = false; process.exitCode = 1; }
  }
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(evidence));
}
