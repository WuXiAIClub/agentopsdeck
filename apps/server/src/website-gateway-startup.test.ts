import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('real Hub process: optional gateway listener starts, shuts down and fails closed on occupied port', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-website-startup-'));
  try {
    for (const occupied of [false, true]) {
      const reservation = createServer();
      await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
      const port = (reservation.address() as { port: number }).port;
      if (!occupied) await new Promise<void>(resolve => reservation.close(() => resolve()));
      const source = import.meta.url.endsWith('.ts');
      const child = spawn(process.execPath, [...(source ? ['--import', import.meta.resolve('tsx')] : []),
        fileURLToPath(new URL(source ? './index.ts' : './index.js', import.meta.url))], {
        cwd: fileURLToPath(new URL('../../..', import.meta.url)),
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, XDG_CONFIG_HOME: join(root, 'config'),
          PORT: '0', AOD_LISTEN_HOST: '127.0.0.1', AOD_SERVER_ROLE: 'hub',
          AOD_HUB_DATABASE_FILE: join(root, `hub-${occupied}.sqlite`), AOD_HUB_VAULT_SECRET: 'synthetic',
          AOD_WEBSITE_GATEWAY_ORIGIN: `http://{access}.preview.localhost:${port}`,
          AOD_WEBSITE_GATEWAY_HUB_ORIGIN: 'http://127.0.0.1:8791', AOD_WEBSITE_GATEWAY_PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      let resolveListening!: (origin: string) => void;
      const listening = new Promise<string>(resolve => { resolveListening = resolve; });
      child.stdout.on('data', chunk => {
        output += String(chunk);
        const origin = output.match(/AgentOpsDeck server listening on (http:\/\/[^\s]+)/)?.[1];
        if (origin) resolveListening(origin);
      });
      child.stderr.on('data', chunk => { output += String(chunk); });
      // Verify captured closure records only after the owned pipe streams close.
      const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      const deadline = setTimeout(() => child.kill('SIGKILL'), 12_000);
      try {
        if (occupied) {
          assert.equal(await exited, 1, output);
          const records = output.split('\n').filter(line => line.startsWith('{'))
            .map(line => JSON.parse(line) as Record<string, unknown>);
          assert.ok(records.some(record => record.component === 'agentopsdeck-performance'
            && record.operation === 'process-startup' && record.phase === 'finished'
            && record.category === 'failed' && record.step === 4 && record.unknown === 1), output);
          assert.ok(records.some(record => record.operation === 'process-shutdown'
            && record.phase === 'finished' && record.settled === 5
            && (record.category === 'routine' || record.category === 'slow')), output);
          assert.equal(records.some(record => record.operation === 'process-shutdown-owner'
            && record.category === 'failed'), false, 'all original owners must acknowledge shutdown');
          assert.doesNotMatch(output, /EADDRINUSE|listen EADDRINUSE/, 'raw listener errors stay private');
          const origin = output.match(/AgentOpsDeck server listening on (http:\/\/[^\s]+)/)?.[1];
          assert.ok(origin, 'the first listener was acquired before the gateway bind failed');
          await assert.rejects(fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) }),
            'the original Hub listener must be closed after the gateway bind failed');
        } else {
          // Await original listener evidence or real child exit. The existing
          // owned 12-second kill deadline bounds this wait; no six-second
          // polling heuristic misclassifies a slow source loader as failure.
          const origin = await Promise.race([listening, exited.then(code => {
            throw new Error(`Hub exited before listener readiness (${code}): ${output}`);
          })]);
          assert.ok(origin, output);
          assert.equal((await fetch(`${origin}/api/health`)).status, 200);
          const gateway = await fetch(`http://127.0.0.1:${port}/api/health`);
          assert.equal(gateway.status, 404, 'separate listener never exposes Hub routes');
          assert.equal(await gateway.text(), 'Website preview unavailable');
          child.kill('SIGTERM'); assert.equal(await exited, 0, output);
          await assert.rejects(fetch(`${origin}/api/health`));
          await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
        }
      } finally {
        clearTimeout(deadline);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
        if (reservation.listening) await new Promise<void>(resolve => reservation.close(() => resolve()));
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
