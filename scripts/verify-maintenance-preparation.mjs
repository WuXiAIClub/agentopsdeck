// Opt-in isolated Linux/systemd build-tree check. No existing service, repo,
// provider or runtime state is touched; production runner owns random units.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runSystemdPreparation } from '../apps/server/dist/lifecycle/maintenance-preparation.js';

assert.equal(process.platform, 'linux');
const directory = await mkdtemp('/tmp/agentopsdeck-preparation-acceptance-');
const runtime = `/run/user/${process.getuid()}`;
assert.equal((await stat(runtime)).uid, process.getuid());
process.env.XDG_RUNTIME_DIR = runtime;
process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtime}/bus`;
const evidence = { directory, passed: false, productionUnitsTouched: false, checks: [] };
const exists = pid => stat(`/proc/${pid}`).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
try {
  for (const mode of ['complete', 'timeout']) {
    const fixture = join(directory, mode);
    await mkdir(fixture, { mode: 0o700 });
    await writeFile(join(fixture, 'child.mjs'), `import {writeFileSync} from 'node:fs';
writeFileSync('child.pid', String(process.pid));
${mode === 'complete' ? "setTimeout(()=>{writeFileSync('child.finished', 'done');},350);"
    : "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"}
`, { flag: 'wx', mode: 0o600 });
    await writeFile(join(fixture, 'parent.mjs'), `import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
writeFileSync('parent.pid', String(process.pid));
writeFileSync('literal-argument', process.argv[2]);
const child=spawn(process.execPath,['child.mjs'],{detached:true,stdio:'ignore'});child.unref();
`, { flag: 'wx', mode: 0o600 });
    const literalArgument = '$HOME ${PATH} literal';
    const work = runSystemdPreparation({ executable: '/usr/bin/node', args: [join(fixture, 'parent.mjs'), literalArgument],
      systemdRun: '/usr/bin/systemd-run', systemctl: '/usr/bin/systemctl' }, fixture, mode === 'complete' ? 10_000 : 2000);
    if (mode === 'timeout') await assert.rejects(work, /could not be verified/);
    else { await work; assert.equal(await readFile(join(fixture, 'child.finished'), 'utf8'), 'done'); }
    assert.equal(await readFile(join(fixture, 'literal-argument'), 'utf8'), literalArgument);
    const pids = await Promise.all(['parent', 'child'].map(async name => Number(await readFile(join(fixture, `${name}.pid`), 'utf8'))));
    const deadline = Date.now() + 5000;
    while ((await Promise.all(pids.map(exists))).some(Boolean) && Date.now() < deadline) await delay(50);
    assert.ok((await Promise.all(pids.map(exists))).every(value => !value), `${mode} left descendants`);
    evidence.checks.push({ mode, detachedChild: true, allProcessesExited: true });
  }
  evidence.passed = true;
} catch (error) {
  evidence.error = error instanceof Error ? error.message : 'Preparation check failed';
  process.exitCode = 1;
} finally {
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(evidence));
}
