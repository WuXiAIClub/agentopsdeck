import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { ConnectorUpdateService } from './update-service.js';
import { PerformanceDiagnostics, performanceDiagnostics } from '../diagnostics/performance.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
type LockBoundary = { withMutationLock<T>(operation: string, callback: () => Promise<T>, authorize?: () => void): Promise<T> };
async function fixture(t: TestContext, sinkThrows: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-update-lock-observation-'));
  t.after(async () => { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(directory, { recursive: true, force: true }); });
  const config = loadConfig({ AOD_CONNECTOR_UPDATE_ENABLED: 'true',
    AOD_CONNECTOR_UPDATE_STATE_FILE: join(directory, 'synthetic-private-state.json'),
    AOD_CONNECTOR_INSTALL_ROOT: directory });
  const records: Record<string, unknown>[] = [];
  const diagnostics = new PerformanceDiagnostics(line => {
    records.push(JSON.parse(line));
    if (sinkThrows) throw Error('synthetic diagnostic sink unavailable');
  });
  t.mock.method(performanceDiagnostics, 'start', diagnostics.start.bind(diagnostics));
  const service = new ConnectorUpdateService(config);
  return { directory, config, records, boundary: service as unknown as LockBoundary };
}

for (const step of [1, 2]) for (const sinkThrows of [false, true]) {
  test(`update lock pending phase ${step}, sink throws ${sinkThrows}: observation cannot release or replay`, async t => {
    const f = await fixture(t, sinkThrows), held = gate(), entered = gate();
    if (step === 1) {
      const originalMkdir = fsPromises.mkdir;
      let intercepted = false;
      t.mock.method(fsPromises, 'mkdir', async (...args: Parameters<typeof originalMkdir>) => {
        if (!intercepted && String(args[0]) === f.directory) {
          intercepted = true; entered.release(); await held.promise;
        }
        return originalMkdir(...args);
      });
      syncBuiltinESMExports();
    }
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let callbacks = 0, settled = false;
    const pending = f.boundary.withMutationLock('maintenance', async () => {
      callbacks++;
      if (step === 2) { entered.release(); await held.promise; }
      return 'original-result';
    }).then(result => { settled = true; return result; });
    try {
      await entered.promise;
      t.mock.timers.tick(30_000);
      const observation = f.records.filter(row => row.operation === 'update-mutation-lock' && row.phase === 'pending');
      assert.equal(observation.length, 1);
      assert.equal(observation[0]!.step, step);
      assert.equal(observation[0]!.admitted, step === 2 ? 1 : 0);
      assert.equal(observation[0]!.records, step === 2 ? 2 : 0);
      assert.equal(settled, false);
      assert.equal(callbacks, step === 2 ? 1 : 0);
      t.mock.timers.tick(60_000);
      assert.equal(f.records.filter(row => row.phase === 'pending').length, 1, 'pending warning is single-shot');
      if (step === 2) {
        const other = new ConnectorUpdateService(f.config) as unknown as LockBoundary;
        await assert.rejects(other.withMutationLock('maintenance', async () => assert.fail('original locks remain held')), /already in progress/);
      }
      held.release();
      assert.equal(await pending, 'original-result');
      assert.equal(callbacks, 1);
      const completion = f.records.find(row => row.operation === 'update-mutation-lock' && row.phase === 'finished'
        && row.instance === observation[0]!.instance && row.sequence === observation[0]!.sequence);
      assert.ok(completion);
      assert.equal(completion.settled, 1);
      for (const metric of ['queueMs', 'bodyMs', 'releaseMs']) assert.equal(typeof completion[metric], 'number');
      assert.equal(JSON.stringify(f.records).includes(f.directory), false, 'no private paths in diagnostic records');
      t.mock.timers.tick(60_000);
      assert.equal(f.records.filter(row => row.phase === 'pending').length, 1, 'completed timer is cleared');
      assert.equal(await f.boundary.withMutationLock('maintenance', async () => 'distinct-request'), 'distinct-request');
      assert.equal(callbacks, 1, 'a distinct request does not replay the original callback');
    } finally { held.release(); await pending; }
  });
}

for (const sinkThrows of [false, true]) {
  test(`update lock callback failure keeps identity and diagnostic uncertainty, sink throws ${sinkThrows}`, async t => {
    const f = await fixture(t, sinkThrows), failure = Error('synthetic original callback rejected');
    let callbacks = 0;
    await assert.rejects(f.boundary.withMutationLock('maintenance', async () => { callbacks++; throw failure; }), error => error === failure);
    const completion = f.records.find(row => row.operation === 'update-mutation-lock' && row.phase === 'finished');
    assert.equal(completion?.category, 'failed');
    assert.equal(completion?.unknown, 1);
    assert.equal(completion?.settled, 1, 'lock closure is not callback outcome settlement');
    assert.equal(callbacks, 1);
    assert.equal(await f.boundary.withMutationLock('maintenance', async () => 'distinct-request'), 'distinct-request');
    assert.equal(callbacks, 1);
  });
}
