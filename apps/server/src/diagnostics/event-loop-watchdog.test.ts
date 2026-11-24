import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { startEventLoopWatchdog } from './event-loop-watchdog.js';

const moduleUrl = new URL(import.meta.url.endsWith('.ts') ? './event-loop-watchdog.ts' : './event-loop-watchdog.js', import.meta.url).href;
async function child(body: string) {
  // Resolve at this module, not at the child cwd. Source dependencies belong
  // to server; compiled acceptance must not need a TypeScript loader.
  const args = import.meta.url.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : [];
  const processChild = spawn(process.execPath, [...args, '--input-type=module', '-e',
    `import { startEventLoopWatchdog } from ${JSON.stringify(moduleUrl)};\n${body}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  processChild.stdout.on('data', data => { stdout += data; });
  processChild.stderr.on('data', data => { stderr += data; });
  const timer = setTimeout(() => { processChild.kill(); }, 15_000); timer.unref();
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      processChild.once('error', reject); processChild.once('close', resolve);
    });
    assert.equal(code, 0, stderr);
    return { stdout, rows: stderr.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)), stderr };
  } finally { clearTimeout(timer); }
}

test('configuration rejects invalid or unsafe bounds before starting a worker', () => {
  for (const options of [{ heartbeatMs: 0 }, { pollMs: NaN }, { stallMs: Infinity }, { repeatMs: 1 },
    { stallMs: 1000 }, { heartbeatMs: 300_001 }, { pollMs: 20.5 }]) {
    assert.throws(() => startEventLoopWatchdog(options), /Invalid event-loop/);
  }
});

test('launch and unexpected exit failures are sanitized, bounded and nonfatal', t => {
  const rows: string[] = [];
  t.mock.method(console, 'error', (line: unknown) => rows.push(String(line)));
  const failed = startEventLoopWatchdog({}, () => { throw Error('/private/path auth-token SQL'); });
  assert.doesNotThrow(() => { failed.stop(); failed.stop(); });
  let terminated = 0;
  const fake = Object.assign(new EventEmitter(), { unref() {}, terminate() { terminated++; return Promise.resolve(0); } });
  const monitor = startEventLoopWatchdog({}, () => fake as unknown as Worker);
  fake.emit('error', Error('/private/path credential')); fake.emit('exit', 1); monitor.stop();
  assert.equal(terminated, 1); assert.equal(rows.length, 2);
  for (const line of rows) assert.deepEqual(JSON.parse(line), { component: 'agentopsdeck-event-loop', version: 1, phase: 'unavailable' });
  assert.doesNotMatch(rows.join(''), /private|token|SQL|credential/);
});

test('stop cannot wait indefinitely for the diagnostic worker', () => {
  let calls = 0;
  const fake = Object.assign(new EventEmitter(), { unref() {}, terminate() { calls++; return new Promise<number>(() => {}); } });
  const monitor = startEventLoopWatchdog({}, () => fake as unknown as Worker);
  assert.doesNotThrow(() => { monitor.stop(); monitor.stop(); }); assert.equal(calls, 1);
});

test('failed stderr diagnostics cannot reject or replay parent business work', async () => {
  const result = await child(`
    const { Worker } = await import('node:worker_threads');
    const watcher = startEventLoopWatchdog({ heartbeatMs: 20, pollMs: 20, stallMs: 200, repeatMs: 1000 },
      (script, options) => new Worker("require('node:fs').writeSync = () => { throw Error('/private/path credential'); };\\n" + script, options));
    await new Promise(resolve => setTimeout(resolve, 150));
    let calls = 0; calls++;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 650);
    await new Promise(resolve => setTimeout(resolve, 150));
    watcher.stop(); console.log(calls);
  `);
  assert.equal(result.stdout.trim(), '1'); assert.deepEqual(result.rows, []);
  assert.doesNotMatch(result.stderr, /private|credential/);
});

test('heartbeat and diagnostic worker do not retain an otherwise idle process', async () => {
  const result = await child('startEventLoopWatchdog(); console.log("idle");');
  assert.equal(result.stdout.trim(), 'idle'); assert.deepEqual(result.rows, []);
});

test('stop is idempotent and cannot report a successful recovery', async () => {
  const result = await child(`
    const watcher = startEventLoopWatchdog({ heartbeatMs: 20, pollMs: 20, stallMs: 100, repeatMs: 500 });
    await new Promise(resolve => setTimeout(resolve, 150));
    watcher.stop(); watcher.stop();
    await new Promise(resolve => setTimeout(resolve, 150));
  `);
  assert.deepEqual(result.rows, []);
});

test('a healthy loop does not emit routine traffic', async () => {
  const result = await child(`
    const watcher = startEventLoopWatchdog({ heartbeatMs: 20, pollMs: 20, stallMs: 500, repeatMs: 1000 });
    await new Promise(resolve => setTimeout(resolve, 700));
    watcher.stop();
  `);
  assert.deepEqual(result.rows, []);
});

test('blocked parent emits independent stderr evidence before it resumes, then correlates heartbeat restoration', async () => {
  const result = await child(`
    const watcher = startEventLoopWatchdog({ heartbeatMs: 20, pollMs: 20, stallMs: 200, repeatMs: 1000 });
    await new Promise(resolve => setTimeout(resolve, 150));
    process.stderr.write('BLOCK-START\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 650);
    process.stderr.write('BLOCK-END\\n');
    await new Promise(resolve => setTimeout(resolve, 150));
    watcher.stop();
  `);
  const pending = result.rows.filter(row => row.phase === 'pending'), restored = result.rows.filter(row => row.phase === 'heartbeat-restored');
  assert.equal(pending.length, 1); assert.equal(restored.length, 1);
  assert.ok(result.stderr.indexOf('"phase":"pending"') > result.stderr.indexOf('BLOCK-START'));
  assert.ok(result.stderr.indexOf('"phase":"pending"') < result.stderr.indexOf('BLOCK-END'), result.stderr);
  assert.equal(pending[0].instance, restored[0].instance); assert.equal(pending[0].sequence, restored[0].sequence);
  assert.ok(pending[0].elapsedMs >= 200); assert.ok(restored[0].elapsedMs < 200);
  for (const row of result.rows) assert.deepEqual(Object.keys(row).sort(), ['component', 'elapsedMs', 'instance', 'phase', 'sequence', 'version']);
  assert.doesNotMatch(JSON.stringify(result.rows), /path|sql|request|token|recovered|settled|error/i);
});

test('prolonged stall reports at a bounded rate without unlocking or replaying work', async () => {
  const result = await child(`
    let calls = 0;
    const watcher = startEventLoopWatchdog({ heartbeatMs: 20, pollMs: 20, stallMs: 200, repeatMs: 500 });
    await new Promise(resolve => setTimeout(resolve, 150));
    calls++;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1350);
    await new Promise(resolve => setTimeout(resolve, 150));
    watcher.stop(); console.log(calls);
  `);
  assert.equal(result.stdout.trim(), '1');
  const pending = result.rows.filter(row => row.phase === 'pending');
  assert.ok(pending.length >= 2 && pending.length <= 3, result.stderr);
  assert.equal(new Set(result.rows.map(row => row.sequence)).size, 1);
  assert.equal(result.rows.at(-1).phase, 'heartbeat-restored');
});
