import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

for (const mode of ['normal', 'signal', 'timeout', 'retained']) {
  test(`SDK fixture supervisor verifies nested group cleanup on ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-sdk-supervisor-test-'));
    const probe = join(root, 'probe.mjs'), supervisor = join(root, 'supervisor.mjs'), record = join(root, 'record.json');
    const helper = new URL('./isolated-sdk-probe.mjs', import.meta.url).href;
    await writeFile(probe, `
      import { fork } from 'node:child_process';
      import { once } from 'node:events';
      import { writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { registerIsolatedProbeGroup } from ${JSON.stringify(helper)};
      const root = process.env.AOD_SDK_PROBE_WORKER;
      const file = join(root, 'nested.mjs');
      await writeFile(file, "process.on('message', () => {}); process.on('disconnect', () => process.exit(0));");
      const child = fork(file, [], { detached: true, stdio: ['ignore','ignore','ignore','ipc'] });
      const exit = once(child, 'exit');
      await registerIsolatedProbeGroup(child.pid);
      await writeFile(${JSON.stringify(record)}, JSON.stringify({root, pid: child.pid}));
      console.log('READY');
      if (['normal', 'retained'].includes(${JSON.stringify(mode)})) {
        child.disconnect(); await exit; process.disconnect();
      } else { setInterval(() => {}, 1000); }
    `);
    await writeFile(supervisor, `
      import { runIsolatedSdkProbe } from ${JSON.stringify(helper)};
      await runIsolatedSdkProbe(${JSON.stringify(probe)}, ${JSON.stringify(root)}, ${mode === 'timeout' ? 1500 : 10_000}, [], { retainEvidence: ${mode === 'retained'} });
    `);
    const child = spawn(process.execPath, [supervisor], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exit = once(child, 'exit');
    let output = '', errors = '', cancelled = false;
    child.stdout.on('data', chunk => {
      output += chunk;
      if (mode === 'signal' && !cancelled && output.includes('READY')) { cancelled = true; child.kill('SIGTERM'); }
    });
    child.stderr.on('data', chunk => { errors += chunk; });
    try {
      const [code] = await exit;
      assert.equal(code, ['normal', 'retained'].includes(mode) ? 0 : 1, errors);
      if (mode === 'signal') assert.match(errors, /interrupted/);
      if (mode === 'timeout') assert.match(errors, /timed out/);
      const evidence = JSON.parse(await readFile(record, 'utf8'));
      assert.throws(() => process.kill(-evidence.pid, 0), { code: 'ESRCH' });
      if (mode === 'retained') {
        assert.equal((await stat(evidence.root)).isDirectory(), true);
        assert.match(output, /"processCleanupVerified":true/);
        await rm(evidence.root, { recursive: true, force: true });
      } else await assert.rejects(stat(evidence.root), { code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
