import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { HermesProcess } from './process.js';
import { hermesConfig } from './config.js';

const config = { enabled: true, executable: '/does-not-exist/hermes-python', sourceDirectory: '/tmp',
  homeDirectory: '/isolated/home', workspace: '/isolated/workspace', startupTimeoutMs: 1000 };

test('disabled Hermes needs no configuration; enabled requires explicit exclusive absolute paths', () => {
  assert.equal(hermesConfig({}), undefined);
  assert.throws(() => hermesConfig({ AOD_HERMES_ENABLED: 'true' }), /DEDICATED/);
  assert.throws(() => hermesConfig({ AOD_HERMES_ENABLED: 'true', AOD_HERMES_DEDICATED: 'true' }), /PYTHON/);
});

test('failed spawn rejects and closes without waiting for an exit event that never comes', { timeout: 4000 }, async () => {
  const native = new HermesProcess(config, () => {}, () => {});
  await assert.rejects(native.start(), /readiness/);
  await native.close(); assert.equal(native.ready, false);
});

test('real child stdio negotiates exclusive capability, streams events and closes cleanly', { timeout: 5000 }, async () => {
  // A real process, but deliberately not a model/backend acceptance test.
  const program = `
    const write = x => process.stdout.write(JSON.stringify(x)+'\\n');
    write({jsonrpc:'2.0',method:'event',params:{type:'gateway.ready',payload:{replay_epoch:'test-epoch',change_events:true}}});
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const req = JSON.parse(line);
      if (!req.method) return;
      if (req.method==='gateway.capabilities') write({jsonrpc:'2.0',id:req.id,result:{per_session_exclusive_submit:true}});
      else if (req.method==='client.capabilities') write({jsonrpc:'2.0',id:req.id,result:{}});
      else {
        write({jsonrpc:'2.0',method:'event',params:{type:'message.delta',session_id:'live',seq:1,payload:{text:'你好'}}});
        write({jsonrpc:'2.0',id:req.id,result:{ok:true}});
      }
    });`;
  const events: unknown[] = [];
  const native = new HermesProcess(config, e => events.push(e), () => {},
    () => spawn(process.execPath, ['-e', program], { stdio: 'pipe', env: {} }));
  try {
    await native.start(); assert.equal(native.ready, true); assert.equal(native.epoch, 'test-epoch');
    assert.deepEqual(await native.request('probe'), { ok: true }); assert.equal(events.length, 1);
  } finally { await native.close(); }
  assert.equal(native.ready, false);
});

test('production Hermes launch isolates poisoned parent settings before negotiating synthetic stdio', async context => {
  const root = mkdtempSync(join(tmpdir(), 'aod-hermes-launch-'));
  const homeDirectory = join(root, 'native'), sourceDirectory = join(root, 'source'), workspace = join(root, 'workspace');
  const ambient = join(root, 'ambient');
  for (const directory of [homeDirectory, sourceDirectory, workspace, ambient]) mkdirSync(directory, { mode: 0o700 });
  const poison = { HOME: ambient, USERPROFILE: ambient, OPENAI_API_KEY: 'synthetic-private-key',
    PYTHONPATH: 'synthetic-private-python', PYTHONHOME: 'synthetic-private-python-home',
    NODE_OPTIONS: 'synthetic-private-preload', HTTPS_PROXY: 'synthetic-private-proxy' };
  const saved = Object.fromEntries(Object.keys(poison).map(name => [name, process.env[name]]));
  Object.assign(process.env, poison);
  const logs: unknown[][] = [];
  context.mock.method(console, 'warn', (...values: unknown[]) => { logs.push(values); });
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stdin: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, kill: () => { queueMicrotask(() => { child.emit('exit', 0); child.emit('close', 0); }); return true; } });
  let launched = 0;
  context.mock.method(childProcess, 'spawn', (executable: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd: string }) => {
    launched++;
    assert.ok(executable.startsWith('/'));
    assert.equal(options.cwd, sourceDirectory);
    assert.equal(options.env.HOME, homeDirectory);
    assert.equal(options.env.USERPROFILE, homeDirectory);
    assert.equal(options.env.HERMES_HOME, homeDirectory);
    assert.equal(options.env.TERMINAL_CWD, workspace);
    assert.equal(options.env.PYTHONPATH, sourceDirectory);
    assert.equal(options.env.PYTHONNOUSERSITE, '1');
    assert.equal(options.env.XDG_CONFIG_HOME, join(homeDirectory, 'config'));
    assert.equal(options.env.TMPDIR, join(homeDirectory, 'tmp'));
    assert.equal(JSON.stringify(options.env).includes('synthetic-private'), false);
    assert.deepEqual(args.slice(0, 2), ['-B', '-c']);
    queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: {
        type: 'gateway.ready', payload: { replay_epoch: 'synthetic-epoch', change_events: true } } }) + '\n');
      child.stderr.write(Buffer.alloc(2 * 1024 * 1024, 97));
    });
    return child;
  });
  syncBuiltinESMExports();
  child.stdin.on('data', chunk => {
    const request = JSON.parse(chunk.toString());
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
      result: request.method === 'gateway.capabilities' ? { per_session_exclusive_submit: true } : {} }) + '\n');
  });
  const native = new HermesProcess({ ...config, executable: process.execPath, homeDirectory, sourceDirectory, workspace }, () => {}, () => {});
  context.after(async () => {
    await native.close();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    context.mock.restoreAll(); syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  });
  await native.start();
  assert.equal(native.ready, true);
  assert.equal(launched, 1);
  assert.deepEqual(logs, []);
});

test('production Hermes launch refuses an aliased source before creating a child', async context => {
  const root = mkdtempSync(join(tmpdir(), 'aod-hermes-refusal-'));
  const source = join(root, 'source'), alias = join(root, 'alias');
  mkdirSync(source, { mode: 0o700 }); symlinkSync(source, alias);
  context.mock.method(childProcess, 'spawn', () => assert.fail('unverified layout must not launch'));
  syncBuiltinESMExports();
  context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); });
  const native = new HermesProcess({ ...config, sourceDirectory: alias }, () => {}, () => {});
  await assert.rejects(native.start(), /readiness/);
  assert.equal(native.ready, false);
});
