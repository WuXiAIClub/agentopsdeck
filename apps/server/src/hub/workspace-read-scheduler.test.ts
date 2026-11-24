import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceReadScheduler } from './workspace-read-scheduler.js';

test('Preview concurrency budget is shared across batches, skips busy nodes and cancels waiting work', async () => {
  const scheduler = createWorkspaceReadScheduler(3, 1, 8), controller = new AbortController();
  const started: string[] = [], releases: Array<() => void> = [];
  const read = (key: string, signal = controller.signal) => scheduler.read(key, signal, async () => { started.push(key); await new Promise<void>(resolve => releases.push(resolve)); return key; });
  const a = read('a'), b = read('a'), c = read('b'), d = read('c'), abort = new AbortController(), e = read('a', abort.signal);
  assert.deepEqual(started, ['a', 'b', 'c']);
  const rejected = assert.rejects(e, /cancelled/); abort.abort(); await rejected;
  releases.splice(0).forEach(release => release()); await Promise.all([a, c, d]);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['a', 'b', 'c', 'a']);
  releases.splice(0).forEach(release => release()); await b;
});

test('adaptive default scheduler prioritizes high-priority items and allows urgent burst when baseline slots are saturated by background reads', async () => {
  const scheduler = createWorkspaceReadScheduler();
  const controller = new AbortController();
  const started: string[] = [], releases: Array<() => void> = [];
  const hold = (name: string, connector: string, priority: number) =>
    scheduler.read(connector, controller.signal, async () => {
      started.push(name);
      await new Promise<void>(resolve => releases.push(resolve));
      return name;
    }, priority);

  // Occupy baseline globalLimit (4) across 2 connectors with background priority (4)
  const bg1 = hold('bg1', 'node-1', 4);
  const bg2 = hold('bg2', 'node-1', 4);
  const bg3 = hold('bg3', 'node-2', 4);
  const bg4 = hold('bg4', 'node-2', 4);
  assert.equal(started.length, 4);

  // Additional background read is queued (cannot burst)
  const bg5 = hold('bg5', 'node-3', 4);
  assert.equal(started.length, 4);

  // High-priority read (priority -1) bursts immediately without waiting for bg1..bg4
  const urgent = hold('urgent', 'node-1', -1);
  assert.ok(started.includes('urgent'), 'urgent read uses adaptive burst slot');

  releases.splice(0).forEach(r => r());
  await Promise.all([bg1, bg2, bg3, bg4, urgent]);
  await new Promise<void>(resolve => setImmediate(resolve));
  releases.splice(0).forEach(r => r());
  await bg5;
});
