import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { link, lstat, mkdtemp, mkdir, readFile, readlink, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';
import { ConnectorUpdateService, UpdateAuthorizationError } from './update-service.js';
import { CommandCapacity, CommandConflict, CommandReceipts } from '../commands/receipts.js';
import { StorageAdmissionDeferred } from '../storage/work-admission.js';
import { PerformanceDiagnostics, performanceDiagnostics } from '../diagnostics/performance.js';
import type { OriginalUpdateLockOwner } from './async-update-lock.js';
import { startupOwnerPathKey } from '../storage/startup-owner.js';

// Source children need TS resolution; emitted children must use native ESM.
const fixtureLoaderArgs = import.meta.url.endsWith('.ts')
  ? ['--import', import.meta.resolve('tsx')] : [];

async function commandFixture(t: import('node:test').TestContext, artifact?: ReturnType<typeof tar>,
  admission?: ConstructorParameters<typeof CommandReceipts>[6], diagnostics?: PerformanceDiagnostics) {
  const f = await updateFixture(t, artifact);
  await symlink('old', f.current);
  const db = new DatabaseSync(path.join(f.dir, 'commands.sqlite'));
  t.after(() => db.close());
  const receipts = new CommandReceipts(db, undefined, undefined, undefined, undefined, diagnostics, admission);
  const store = { nodeId: 'synthetic-node', receipts };
  const service = new ConnectorUpdateService(f.config, store);
  return { ...f, db, receipts, store, service, body: { ...f.body, idempotencyKey: 'original' } };
}

function admissionGate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

for (const operation of ['maintenanceStatus', 'status', 'check', 'apply', 'rollback', 'applyCommand', 'rollbackCommand',
  'command', 'maintenanceCommand', 'changeMaintenance', 'withMaintenanceProbe'] as const) {
  for (const kind of ['async', 'promise', 'thenable'] as const) test(`${operation}: ${kind} authority is denied before journal, receipt, lock or lifecycle work`, async t => {
    const f = await commandFixture(t);
    let calls = 0, pauses = 0, probes = 0, thenReads = 0;
    f.service.bindMaintenanceLifecycle(() => { pauses++; return { drained: Promise.resolve(), resume: () => true }; });
    const before = await readFile(f.stateFile, 'utf8');
    const target = await readlink(f.current);
    const entries = (await readdir(f.dir)).sort();
    const authority = kind === 'async' ? async () => { calls++; } : () => {
      calls++;
      return kind === 'promise' ? Promise.resolve() : { get then() { thenReads++; throw Error('private thenable'); } };
    };
    t.mock.method(globalThis, 'fetch', async () => { assert.fail('denied authority must not download'); });
    const run = () => {
      switch (operation) {
        case 'maintenanceStatus': return f.service.maintenanceStatus(authority);
        case 'status': return f.service.status(true, authority);
        case 'check': return f.service.check('stable', authority);
        case 'apply': return f.service.apply(f.body, authority);
        case 'rollback': return f.service.rollback(authority);
        case 'applyCommand': return f.service.applyCommand('alice', f.body, authority);
        case 'rollbackCommand': return f.service.rollbackCommand('alice', 'denied', authority);
        case 'command': return f.service.command('alice', 'apply', 'denied', authority);
        case 'maintenanceCommand': return f.service.maintenanceCommand('alice', 'pause', 'denied', authority);
        case 'changeMaintenance': return f.service.changeMaintenance('alice', 'pause', 'denied', undefined, authority);
        case 'withMaintenanceProbe': return f.service.withMaintenanceProbe('alice', '00000000-0000-0000-0000-000000000000',
          authority, async () => { probes++; });
      }
    };
    await assert.rejects(run(), UpdateAuthorizationError);
    assert.equal(calls, kind === 'async' ? 0 : 1); assert.equal(pauses, 0); assert.equal(probes, 0); assert.equal(thenReads, 0);
    assert.equal(await readFile(f.stateFile, 'utf8'), before);
    assert.equal(await readlink(f.current), target);
    assert.deepEqual((await readdir(f.dir)).sort(), entries, 'no lock file or journal appears');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM command_receipts').get()?.n, 0);
  });
}

for (const operation of ['maintenanceStatus', 'status'] as const) test(`${operation}: Promise authority after journal await is not a cached grant`, async t => {
  const f = await commandFixture(t), entered = admissionGate(), released = admissionGate();
  const original = (f.service as any).readState.bind(f.service);
  t.mock.method(f.service as any, 'readState', async () => { entered.release(); await released.promise; return original(false); });
  let allowed = true, calls = 0;
  const authority = () => { calls++; return allowed ? undefined : Promise.resolve(); };
  const pending = operation === 'status' ? f.service.status(false, authority) : f.service.maintenanceStatus(authority);
  const rejected = assert.rejects(pending, UpdateAuthorizationError);
  await entered.promise; allowed = false; released.release(); await rejected;
  assert.equal(calls, 2);
});

for (const operation of ['apply', 'rollback', 'pause', 'resume'] as const) {
  async function setup(t: import('node:test').TestContext, admission: NonNullable<ConstructorParameters<typeof CommandReceipts>[6]>, diagnostics?: PerformanceDiagnostics) {
    let enabled = false, pauses = 0;
    const f = await commandFixture(t, undefined, (bytes, write) => enabled ? admission(bytes, write) : write(), diagnostics);
    f.service.bindMaintenanceLifecycle(() => { pauses++; return { drained: Promise.resolve(), resume: () => true }; });
    let fenceId: string | undefined;
    if (operation === 'rollback') await f.service.applyCommand('alice', f.body);
    if (operation === 'resume') {
      const paused = await f.service.changeMaintenance('alice', 'pause', 'prepare');
      fenceId = paused.id;
    }
    enabled = true;
    const before = await readFile(f.stateFile, 'utf8'), target = await readlink(f.current), baselinePauses = pauses;
    t.mock.method(globalThis, 'fetch', async () => { assert.fail('uncertain admission must not download'); });
    const run = (authorize?: () => void) => operation === 'apply'
      ? f.service.applyCommand('alice', { ...f.body, idempotencyKey: 'async-boundary' }, authorize)
      : operation === 'rollback' ? f.service.rollbackCommand('alice', 'async-boundary', authorize)
      : f.service.changeMaintenance('alice', operation, 'async-boundary', fenceId, authorize);
    const observe = () => operation === 'apply' || operation === 'rollback'
      ? f.service.command('alice', operation, 'async-boundary')
      : f.service.maintenanceCommand('alice', operation, 'async-boundary');
    const unchanged = async () => {
      assert.equal(await readFile(f.stateFile, 'utf8'), before);
      assert.equal(await readlink(f.current), target);
      assert.equal(pauses, baselinePauses, 'no lifecycle change without confirmed admission');
      // This must acquire both mutation locks, then reject the wrong original owner/fence.
      await assert.rejects(f.service.changeMaintenance('bob', 'resume', 'lock-probe',
        '00000000-0000-0000-0000-000000000000'), CommandConflict);
    };
    return { ...f, run, observe, unchanged };
  }

  test(`${operation}: Promise authority after original receipt admission cannot authorize a release or lifecycle change`, async t => {
    const entered = admissionGate(), release = admissionGate();
    const f = await setup(t, async (_bytes, write) => { entered.release(); await release.promise; return write(); });
    let allowed = true;
    const pending = f.run(() => allowed ? undefined : Promise.resolve());
    const rejected = assert.rejects(pending, UpdateAuthorizationError);
    await entered.promise; allowed = false; release.release(); await rejected;
    await f.unchanged();
  });

  for (const committed of [false, true]) test(`${operation} async admission revocation ${committed ? 'after commit' : 'before writer'} leaves no side effects`, { timeout: 10_000 }, async t => {
    const entered = admissionGate(), release = admissionGate(); let authorized = true;
    const f = await setup(t, async (_bytes, write) => {
      const result = committed ? await write() : undefined;
      entered.release(); await release.promise;
      return committed ? result! : write();
    });
    const pending = f.run(() => { if (!authorized) throw new UpdateAuthorizationError(); });
    const rejected = assert.rejects(pending, UpdateAuthorizationError);
    await entered.promise;
    assert.equal(f.db.isTransaction, false, 'owner transaction must not span storage waits');
    assert.equal((await f.service.status(false)).state === 'checking', false);
    await assert.rejects(f.service.check(), /already in progress/, 'original update lock still excludes other writers');
    authorized = false; release.release(); await rejected;
    await f.unchanged();
    const original = await f.observe();
    assert.equal(original?.state, committed ? 'outcome_unknown' : undefined);
  });

  test(`${operation} lost admission release is logged and retries only observe original receipt`, async t => {
    let admissions = 0;
    const logs: Record<string, unknown>[] = [];
    const diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)));
    const f = await setup(t, async (_bytes, write) => {
      admissions++; await write(); throw new StorageAdmissionDeferred('synthetic release lost');
    }, diagnostics);
    await assert.rejects(f.run(), StorageAdmissionDeferred);
    const original = await f.observe();
    assert.equal(original?.state, 'outcome_unknown');
    assert.deepEqual(await f.run(), original);
    assert.equal(admissions, 1, 'duplicates must not reacquire admission or redispatch');
    await f.unchanged();
    assert.ok(logs.some(row => row.operation === 'command-receipt-admission' && row.category === 'failed' && row.unknown === 1));
    assert.equal(JSON.stringify(logs).includes('async-boundary'), false);
  });

  test(`${operation} unavailable admission leaves no receipt and releases mutation locks`, async t => {
    const f = await setup(t, async () => { throw new StorageAdmissionDeferred('synthetic unavailable'); });
    await assert.rejects(f.run(), StorageAdmissionDeferred);
    assert.equal(await f.observe(), undefined);
    await f.unchanged();
  });

  test(`${operation} rechecks authority at caller Promise delivery`, async t => {
    let authorized = true;
    const f = await setup(t, async (_bytes, write) => write());
    const claim = f.receipts.claimAsync.bind(f.receipts);
    t.mock.method(f.receipts, 'claimAsync', async (...args: Parameters<typeof claim>) => {
      const result = await claim(...args); authorized = false; return result;
    });
    await assert.rejects(f.run(() => { if (!authorized) throw new UpdateAuthorizationError(); }), UpdateAuthorizationError);
    assert.equal((await f.observe())?.state, 'outcome_unknown');
    await f.unchanged();
  });
}

test('release durability synchronizes file contents and bottom-up directories before selection', async context => {
  const setup = await commandFixture(context, tar({ 'package.json': '{}', 'dist/index.js': 'new', 'dist/nested/data.json': 'payload' }, [{ name: 'empty/nested', type: '5' }]));
  const originalOpen = fsPromises.open, originalRename = fsPromises.rename;
  const events: string[] = [];
  context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });
  context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof originalOpen>) => {
    const file = String(args[0]);
    const handle = await originalOpen(...args);
    const originalSync = handle.sync.bind(handle), originalClose = handle.close.bind(handle);
    context.mock.method(handle, 'sync', async () => { await originalSync(); events.push(`sync:${file}`); });
    context.mock.method(handle, 'close', async () => { await originalClose(); events.push(`close:${file}`); });
    return handle;
  });
  let selected = false;
  context.mock.method(fsPromises, 'rename', async (...args: Parameters<typeof originalRename>) => {
    if (String(args[1]) === setup.current) {
      for (const name of ['package.json', 'dist/index.js', 'dist/nested/data.json', 'dist/nested', 'dist', 'empty/nested', 'empty', '']) {
        const file = path.join(setup.release, name);
        const synced = events.indexOf(`sync:${file}`), closed = events.indexOf(`close:${file}`);
        assert.ok(synced >= 0 && closed > synced, `${name || 'release root'} must be synced and closed before selection`);
        if (name) assert.ok(closed < events.indexOf(`sync:${path.dirname(file)}`), 'children are durable before their parent');
      }
      let child = setup.release;
      while (path.dirname(child) !== child) {
        const parent = path.dirname(child);
        assert.ok(events.indexOf(`close:${child}`) < events.lastIndexOf(`sync:${parent}`));
        child = parent;
      }
      selected = true;
    }
    return originalRename(...args);
  });
  syncBuiltinESMExports();
  const result = await setup.service.applyCommand('alice', setup.body);
  assert.equal(result.result?.body.state, 'succeeded');
  assert.equal(selected, true);
});

for (const point of ['file-open', 'file-write', 'file-sync', 'file-close', 'directory-open', 'directory-sync', 'directory-close', 'ancestor-sync'] as const) {
  test(`release durability ${point} failure never selects or replays the original command`, async context => {
    const setup = await commandFixture(context);
    const previous = JSON.parse(await readFile(setup.stateFile, 'utf8')).selectedRelease;
    const originalOpen = fsPromises.open;
    const target = point.startsWith('file-') ? path.join(setup.release, 'dist/index.js')
      : point === 'ancestor-sync' ? path.dirname(setup.release) : path.join(setup.release, 'dist');
    let failed = false;
    const handles = new Set<Awaited<ReturnType<typeof originalOpen>>>();
    context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });
    context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof originalOpen>) => {
      const file = String(args[0]);
      const inject = (operation: string) => {
        if (!failed && file === target && (point.endsWith(operation))) {
          failed = true; throw new Error('synthetic release durability failure');
        }
      };
      inject('open');
      const handle = await originalOpen(...args);
      handles.add(handle);
      const originalWrite = handle.writeFile.bind(handle), originalSync = handle.sync.bind(handle), originalClose = handle.close.bind(handle);
      context.mock.method(handle, 'writeFile', async (...parameters: Parameters<typeof originalWrite>) => { inject('write'); return originalWrite(...parameters); });
      context.mock.method(handle, 'sync', async () => { inject('sync'); return originalSync(); });
      context.mock.method(handle, 'close', async () => { await originalClose(); handles.delete(handle); inject('close'); });
      return handle;
    });
    syncBuiltinESMExports();
    const receipt = await setup.service.applyCommand('alice', setup.body);
    assert.equal(failed, true, 'the real release owner must reach the injected boundary');
    assert.equal(handles.size, 0);
    assert.equal(receipt.state, 'accepted');
    assert.equal(receipt.result?.body.state, 'failed');
    assert.match(String(receipt.result?.body.lastError), /synthetic release durability failure/);
    assert.equal(await readlink(setup.current), 'old');
    const journal = JSON.parse(await readFile(setup.stateFile, 'utf8'));
    assert.equal(journal.selection, undefined);
    assert.deepEqual(journal.selectedRelease, previous);
    assert.equal((await readdir(setup.dir)).some(name => name.startsWith('current.next-')), false);
    context.mock.method(globalThis, 'fetch', () => assert.fail('failed original command must not download again'));
    const reopened = new ConnectorUpdateService(setup.config, setup.store);
    assert.deepEqual(await reopened.command('alice', 'apply', 'original'), receipt);
    assert.deepEqual(await reopened.applyCommand('alice', setup.body), receipt);
    assert.equal(await readlink(setup.current), 'old');
  });
}

test('release durability rechecks original authority after file synchronization before selection', async context => {
  const setup = await commandFixture(context);
  const originalOpen = fsPromises.open;
  let allowed = true, synchronized = false;
  context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });
  context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === path.join(setup.release, 'dist/index.js')) {
      const originalSync = handle.sync.bind(handle);
      context.mock.method(handle, 'sync', async () => { await originalSync(); synchronized = true; allowed = false; });
    }
    return handle;
  });
  syncBuiltinESMExports();
  const receipt = await setup.service.applyCommand('alice', setup.body, () => { if (!allowed) throw new Error('synthetic private authority detail'); });
  assert.equal(synchronized, true);
  assert.equal(receipt.result?.body.state, 'failed');
  assert.equal(await readlink(setup.current), 'old');
  assert.equal(JSON.stringify(receipt).includes('private authority detail'), false);
});

test('release durability owns delayed file sync and close while duplicate commands remain unknown', async context => {
  const setup = await commandFixture(context);
  const originalOpen = fsPromises.open;
  let enterSync!: () => void, releaseSync!: () => void, enterClose!: () => void, releaseClose!: () => void;
  const syncEntered = new Promise<void>(resolve => { enterSync = resolve; });
  const syncPending = new Promise<void>(resolve => { releaseSync = resolve; });
  const closeEntered = new Promise<void>(resolve => { enterClose = resolve; });
  const closePending = new Promise<void>(resolve => { releaseClose = resolve; });
  let operation: Promise<unknown> | undefined;
  context.after(async () => {
    releaseSync(); releaseClose();
    await operation?.catch(() => undefined);
    context.mock.restoreAll(); syncBuiltinESMExports();
  });
  context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === path.join(setup.release, 'dist/index.js')) {
      const originalSync = handle.sync.bind(handle), originalClose = handle.close.bind(handle);
      context.mock.method(handle, 'sync', async () => { enterSync(); await syncPending; await originalSync(); });
      context.mock.method(handle, 'close', async () => { enterClose(); await closePending; await originalClose(); });
    }
    return handle;
  });
  syncBuiltinESMExports();
  const applying = setup.service.applyCommand('alice', setup.body);
  operation = applying;
  await Promise.race([syncEntered, applying.then(() => assert.fail('selection returned without reaching file sync'))]);
  const original = await setup.service.command('alice', 'apply', 'original');
  assert.equal(original?.state, 'outcome_unknown');
  assert.deepEqual(await setup.service.applyCommand('alice', setup.body), original);
  assert.equal(await readlink(setup.current), 'old');
  releaseSync();
  await closeEntered;
  assert.deepEqual(await setup.service.command('alice', 'apply', 'original'), original);
  assert.equal(await readlink(setup.current), 'old', 'successful sync does not release an unclosed file owner');
  releaseClose();
  const completed = await applying;
  assert.equal(completed.id, original?.id);
  assert.equal(completed.result?.body.state, 'succeeded');
  assert.equal(await readlink(setup.current), setup.release);
});

test('release durability rejects normalized duplicate files instead of replacing synchronized contents', async context => {
  const setup = await commandFixture(context, tar({ 'package.json': '{}', 'dist/index.js': 'original', 'dist/./index.js': 'replacement' }));
  const receipt = await setup.service.applyCommand('alice', setup.body);
  assert.equal(receipt.result?.body.state, 'failed');
  assert.match(String(receipt.result?.body.lastError), /EEXIST/);
  assert.equal(await readlink(setup.current), 'old');
});

for (const required of ['package.json', 'dist/index.js']) {
  test(`release layout rejects a directory impersonating ${required}`, async context => {
    const files: Record<string, string> = required === 'package.json' ? { 'dist/index.js': 'new' } : { 'package.json': '{}' };
    const setup = await commandFixture(context, tar(files, [{ name: required, type: '5' }]));
    const receipt = await setup.service.applyCommand('alice', setup.body);
    assert.equal(receipt.result?.body.state, 'failed');
    assert.match(String(receipt.result?.body.lastError), /regular file/);
    assert.equal(await readlink(setup.current), 'old');
    assert.equal(JSON.parse(await readFile(setup.stateFile, 'utf8')).selection, undefined);
  });
}

for (const point of ['intent-data', 'intent-directory', 'link-directory', 'terminal-data', 'terminal-directory'] as const) {
  test(`update durability failure at ${point} preserves the original unknown receipt without replay`, async context => {
    const setup = await commandFixture(context);
    const originalOpen = fsPromises.open;
    let failed = false;
    let recoveryFailure = false;
    context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });
    context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      const originalSync = handle.sync.bind(handle);
      const file = String(args[0]);
      context.mock.method(handle, 'sync', async () => {
        if (recoveryFailure && file === setup.stateFile) throw new Error('synthetic recovery sync failure');
        if (!failed && (file === setup.dir || file.startsWith(`${setup.stateFile}.tmp-`))) {
          const state = JSON.parse(await readFile(file === setup.dir ? setup.stateFile : file, 'utf8'));
          const selected = await readlink(setup.current) === setup.release;
          const matches = point === 'intent-data' ? file !== setup.dir && Boolean(state.selection)
            : point === 'intent-directory' ? file === setup.dir && Boolean(state.selection) && !selected
            : point === 'link-directory' ? file === setup.dir && Boolean(state.selection) && selected
            : point === 'terminal-data' ? file !== setup.dir && state.state === 'succeeded'
            : file === setup.dir && state.state === 'succeeded';
          if (matches) { failed = true; throw new Error('synthetic sync failure'); }
        }
        return originalSync();
      });
      return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(setup.service.applyCommand('alice', setup.body), /synthetic sync failure/);
    assert.equal(failed, true);
    const scope = (setup.service as any).commandScope('alice', 'apply');
    const receipt = setup.receipts.get(scope, 'original')!;
    assert.equal(receipt.state, 'outcome_unknown');
    const switched = ['link-directory', 'terminal-data', 'terminal-directory'].includes(point);
    assert.equal(await readlink(setup.current), switched ? setup.release : 'old');
    const reopened = new ConnectorUpdateService(setup.config, setup.store);
    context.mock.method(globalThis, 'fetch', () => assert.fail('recovery must not download or redispatch'));
    if (point === 'terminal-directory') {
      recoveryFailure = true;
      await assert.rejects(reopened.command('alice', 'apply', 'original'), /synthetic recovery sync failure/);
      assert.deepEqual(setup.receipts.get(scope, 'original'), receipt);
      recoveryFailure = false;
    }
    const recovered = await reopened.command('alice', 'apply', 'original');
    assert.equal(recovered?.id, receipt.id);
    assert.equal(recovered?.state, point === 'intent-data' ? 'outcome_unknown' : 'accepted');
    if (point !== 'intent-data') assert.equal(recovered?.result?.body.state, switched ? 'succeeded' : 'failed');
    assert.deepEqual(await reopened.applyCommand('alice', setup.body), recovered);
    assert.equal(await readlink(setup.current), switched ? setup.release : 'old');
    assert.equal((await readdir(setup.dir)).some(name => name.startsWith('state.json.tmp-')), false);
  });
}

for (const point of ['manifest', 'artifact', 'intent', 'switch', 'selected'] as const) {
  test(`maintenance authority revoked at ${point} cannot authorize a later release switch`, async t => {
    const f = await commandFixture(t);
    let allowed = true;
    const authorize = () => {
      if (point === 'switch' && readdirSync(f.dir).some(name => name.startsWith('current.next-'))) allowed = false;
      if (!allowed) throw new Error('synthetic private authority detail');
    };
    const fetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
      const result = await fetch(...args);
      if (String(args[0]).includes(point)) allowed = false;
      return result;
    });
    const service = f.service as any;
    const save = service.savePrivate.bind(service);
    t.mock.method(service, 'savePrivate', async (state: any) => {
      if (point === 'selected' && state.state === 'succeeded') allowed = false;
      const result = await save(state);
      if (point === 'intent' && state.selection) allowed = false;
      return result;
    });
    const receipt = await f.service.applyCommand('alice', f.body, authorize);
    assert.equal(receipt.state, 'accepted');
    assert.equal(receipt.result?.body.state, point === 'selected' ? 'succeeded' : 'failed');
    assert.equal(receipt.result?.body.targetVersion, f.body.version);
    assert.equal(await readlink(f.current), point === 'selected' ? f.release : 'old');
    assert.equal(JSON.stringify(receipt).includes('synthetic private'), false);
    const reopened = new ConnectorUpdateService(f.config, f.store);
    assert.deepEqual(await reopened.command('alice', 'apply', 'original'), receipt);
    assert.equal((await readdir(f.dir)).some(name => name.startsWith('current.next-')), false);
  });
}

test('maintenance authority is checked before lock creation and receipt claim', async t => {
  const f = await commandFixture(t);
  const source = await readFile(f.stateFile, 'utf8');
  const deny = () => { throw new Error('private authority detail'); };
  await assert.rejects(f.service.applyCommand('alice', f.body, deny), /update authorization changed/);
  await assert.rejects(f.service.rollbackCommand('alice', 'rollback', deny), /update authorization changed/);
  assert.equal(await f.service.command('alice', 'apply', 'original'), undefined);
  assert.equal(await f.service.command('alice', 'rollback', 'rollback'), undefined);
  assert.equal(await readFile(f.stateFile, 'utf8'), source);
  await assert.rejects(lstat(f.stateFile + '.lock'), { code: 'ENOENT' });
});

test('maintenance rollback rechecks authority after persisting selection intent', async t => {
  const f = await commandFixture(t);
  await f.service.applyCommand('alice', f.body);
  let allowed = true;
  const service = f.service as any;
  const save = service.savePrivate.bind(service);
  t.mock.method(service, 'savePrivate', async (state: any) => {
    const result = await save(state);
    if (state.selection) allowed = false;
    return result;
  });
  const receipt = await f.service.rollbackCommand('alice', 'rollback', () => { if (!allowed) throw new Error('revoked'); });
  assert.equal(receipt.result?.body.state, 'failed');
  assert.equal(await readlink(f.current), f.release);
  assert.deepEqual(await f.service.command('alice', 'rollback', 'rollback'), receipt);
});

test('disabling updates during download prevents selection and records the original failed result', async t => {
  const f = await commandFixture(t);
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
    const result = await fetch(...args);
    if (String(args[0]).includes('artifact')) f.config.connector.updateEnabled = false;
    return result;
  });
  const receipt = await f.service.applyCommand('alice', f.body);
  assert.equal(receipt.result?.body.state, 'failed');
  assert.equal(await readlink(f.current), 'old');
  assert.deepEqual(await f.service.command('alice', 'apply', 'original'), receipt);
});

test('revocation after receipt claim but before its journal is a durable rejection, never replayed', async t => {
  const f = await commandFixture(t);
  let allowed = true;
  const service = f.service as any;
  const read = service.readState.bind(service);
  t.mock.method(service, 'readState', async (...args: unknown[]) => {
    const result = await read(...args);
    allowed = false;
    return result;
  });
  const source = await readFile(f.stateFile, 'utf8');
  const receipt = await f.service.applyCommand('alice', f.body, () => { if (!allowed) throw new Error('revoked'); });
  assert.equal(receipt.state, 'rejected');
  assert.equal(receipt.result?.status, 403);
  assert.equal(await readFile(f.stateFile, 'utf8'), source);
  const reopened = new ConnectorUpdateService(f.config, f.store);
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('rejected command must not replay'); });
  assert.deepEqual(await reopened.applyCommand('alice', f.body), receipt);
});

test('unauthorized original-receipt lookup cannot recover an interrupted selection', async t => {
  const f = await commandFixture(t);
  const service = f.service as any;
  const save = service.savePrivate.bind(service);
  t.mock.method(service, 'savePrivate', async (state: any) => {
    if (state.state === 'succeeded') throw new Error('synthetic interruption');
    return save(state);
  });
  await assert.rejects(f.service.applyCommand('alice', f.body), /synthetic interruption/);
  const source = await readFile(f.stateFile, 'utf8');
  const inode = (await lstat(f.current)).ino;
  const reopened = new ConnectorUpdateService(f.config, f.store);
  let reads = 0;
  const read = (reopened as any).readState.bind(reopened);
  t.mock.method(reopened as any, 'readState', async (...args: unknown[]) => {
    const result = await read(...args);
    reads++;
    return result;
  });
  await assert.rejects(reopened.command('alice', 'apply', 'original', () => { if (reads) throw new Error('revoked'); }), /revoked/);
  assert.equal(await readFile(f.stateFile, 'utf8'), source);
  assert.equal((await lstat(f.current)).ino, inode);
  assert.equal((await reopened.command('alice', 'apply', 'original'))?.result?.body.state, 'succeeded');
  assert.equal((await lstat(f.current)).ino, inode);
});

test('maintenance receipts retain the original result after check, rollback and reopen', async t => {
  const f = await commandFixture(t);
  const original = await f.service.applyCommand('alice', f.body);
  assert.equal(original.state, 'accepted');
  assert.equal(original.result?.body.state, 'succeeded');
  assert.equal('updateCommand' in original.result!.body, false);
  await f.service.check();
  const rollback = await f.service.rollbackCommand('alice', 'rollback');
  assert.equal(rollback.result?.body.state, 'rolled_back');
  assert.equal(await readlink(f.current), path.join(f.dir, 'old'));
  const reopened = new ConnectorUpdateService(f.config, f.store);
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('duplicate must not download'); });
  assert.deepEqual(await reopened.applyCommand('alice', f.body), original);
  assert.deepEqual(await reopened.command('alice', 'apply', 'original'), original);
  assert.deepEqual(await reopened.rollbackCommand('alice', 'rollback'), rollback);
  assert.equal((await reopened.rollbackCommand('alice', 'new-rollback')).result?.body.state, 'rolled_back');
  assert.equal(await reopened.command('bob', 'apply', 'original'), undefined);
  assert.equal(await reopened.command('alice', 'rollback', 'original'), undefined);
  assert.equal(await new ConnectorUpdateService(f.config, { ...f.store, nodeId: 'other' }).command('alice', 'apply', 'original'), undefined);
});

for (const change of [{ version: '3.0.0' }, { revision: 'other' }, { manifestSha256: '0'.repeat(64) }]) {
  test(`maintenance key conflicts on ${Object.keys(change)[0]} before download or state mutation`, async t => {
    const f = await commandFixture(t);
    await f.service.applyCommand('alice', f.body);
    const before = await readFile(f.stateFile, 'utf8');
    t.mock.method(globalThis, 'fetch', async () => { assert.fail('conflict must not download'); });
    await assert.rejects(f.service.applyCommand('alice', { ...f.body, ...change }), CommandConflict);
    assert.equal(await readFile(f.stateFile, 'utf8'), before);
  });
}

test('concurrent maintenance duplicate reads unknown, cannot switch or restart the writer', async t => {
  const f = await commandFixture(t);
  const fetch = globalThis.fetch;
  let ready!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { ready = r; }), gate = new Promise<void>(r => { release = r; });
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (url.includes('artifact')) { downloads++; ready(); await gate; }
    return fetch(url, init);
  });
  const running = f.service.applyCommand('alice', f.body);
  try {
    await entered;
    assert.equal((await f.service.applyCommand('alice', f.body)).state, 'outcome_unknown');
    assert.equal((await f.service.command('alice', 'apply', 'original'))!.state, 'outcome_unknown');
    await assert.rejects(f.service.applyCommand('alice', { ...f.body, revision: 'other' }), CommandConflict);
    await assert.rejects(f.service.rollbackCommand('alice', 'other'), /already in progress/);
    assert.equal((await f.service.status()).state, 'downloading');
    assert.equal(await readlink(f.current), 'old');
  } finally { release(); }
  assert.equal((await running).state, 'accepted');
  assert.equal(downloads, 1);
});

for (const afterSwitch of [false, true]) test(`maintenance recovery binds original receipt after interruption ${afterSwitch ? 'after' : 'before'} link selection`, async t => {
  const f = await commandFixture(t);
  const internal = f.service as any;
  const save = internal.savePrivate.bind(internal);
  const mock = t.mock.method(internal, 'savePrivate', async (state: any) => {
    if (afterSwitch && state.state === 'succeeded') throw new Error('synthetic interruption');
    const result = await save(state);
    if (!afterSwitch && state.selection) throw new Error('synthetic interruption');
    return result;
  });
  await assert.rejects(f.service.applyCommand('alice', f.body), /synthetic interruption/);
  mock.mock.restore();
  assert.equal(await readlink(f.current), afterSwitch ? f.release : 'old');
  const state = JSON.parse(await readFile(f.stateFile, 'utf8'));
  assert.equal(f.receipts.get(state.updateCommand.scope, state.updateCommand.key)!.state, 'outcome_unknown');
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('recovery cannot download'); });
  const reopened = new ConnectorUpdateService(f.config, f.store);
  const result = await reopened.command('alice', 'apply', 'original');
  assert.equal(result?.state, 'accepted');
  assert.equal(result?.result?.body.state, afterSwitch ? 'succeeded' : 'failed');
  assert.deepEqual(await reopened.applyCommand('alice', f.body), result);
  assert.equal(await readlink(f.current), afterSwitch ? f.release : 'old');
});

test('selected release and terminal journal survive receipt write failure; next check settles before overwriting', async t => {
  const f = await commandFixture(t);
  const mock = t.mock.method(f.receipts, 'settle', () => { throw new Error('synthetic receipt failure'); });
  await assert.rejects(f.service.applyCommand('alice', f.body), /synthetic receipt failure/);
  assert.equal(await readlink(f.current), f.release);
  assert.equal((await lstat(f.release)).isDirectory(), true);
  const state = JSON.parse(await readFile(f.stateFile, 'utf8'));
  assert.equal(state.state, 'succeeded');
  assert.equal(f.receipts.get(state.updateCommand.scope, 'original')!.state, 'outcome_unknown');
  await assert.rejects(f.service.check(), /synthetic receipt failure/);
  assert.deepEqual(JSON.parse(await readFile(f.stateFile, 'utf8')), state);
  mock.mock.restore();
  await new ConnectorUpdateService(f.config, f.store).check();
  assert.equal((await f.service.command('alice', 'apply', 'original'))?.result?.body.state, 'succeeded');
  assert.equal(JSON.parse(await readFile(f.stateFile, 'utf8')).updateCommand, undefined);
});

for (const corrupt of ['id', 'scope', 'selection', 'missing-store']) test(`maintenance ${corrupt} mismatch preserves journal and receipt uncertainty`, async t => {
  const f = await commandFixture(t);
  const internal = f.service as any, save = internal.savePrivate.bind(internal);
  const mock = t.mock.method(internal, 'savePrivate', async (state: any) => {
    const result = await save(state);
    if (state.selection) throw new Error('synthetic interruption');
    return result;
  });
  await assert.rejects(f.service.applyCommand('alice', f.body), /synthetic interruption/);
  mock.mock.restore();
  const state = JSON.parse(await readFile(f.stateFile, 'utf8'));
  const command = { ...state.updateCommand };
  if (corrupt === 'id') state.updateCommand.id = '0'.repeat(36);
  if (corrupt === 'scope') state.updateCommand.scope = JSON.stringify(['update', JSON.stringify(['other', 'alice', 'apply'])]);
  if (corrupt === 'selection') delete state.selection.completed.updateCommand;
  await writeFile(f.stateFile, JSON.stringify(state));
  const source = await readFile(f.stateFile, 'utf8');
  const service = new ConnectorUpdateService(f.config, corrupt === 'missing-store' ? undefined : f.store);
  await assert.rejects(service.status(), /identity mismatch/);
  await assert.rejects(service.check(), /identity mismatch/);
  assert.equal(await readFile(f.stateFile, 'utf8'), source);
  assert.equal(await readlink(f.current), 'old');
  assert.equal(f.receipts.get(command.scope, command.key)!.state, 'outcome_unknown');
});

test('disabled updater queries receipts without recovery, new claims or state writes', async t => {
  const f = await commandFixture(t);
  const mock = t.mock.method(f.receipts, 'settle', () => { throw new Error('synthetic receipt failure'); });
  await assert.rejects(f.service.applyCommand('alice', f.body), /synthetic receipt failure/);
  mock.mock.restore();
  f.config.connector.updateEnabled = false;
  const before = await readFile(f.stateFile, 'utf8');
  const usage = f.db.prepare('SELECT * FROM command_receipt_usage').get();
  assert.equal((await f.service.command('alice', 'apply', 'original'))?.state, 'outcome_unknown');
  await assert.rejects(f.service.applyCommand('alice', f.body), /disabled/);
  await assert.rejects(f.service.rollbackCommand('alice', 'new'), /disabled/);
  assert.equal((await f.service.status()).supported, false);
  assert.equal(await readFile(f.stateFile, 'utf8'), before);
  assert.deepEqual(f.db.prepare('SELECT * FROM command_receipt_usage').get(), usage);
  f.config.connector.updateEnabled = true;
  assert.equal((await f.service.command('alice', 'apply', 'original'))?.state, 'accepted');
});

test('maintenance refuses admission before side effects when the receipt result cannot be reserved', async t => {
  const f = await commandFixture(t);
  const receipts = new CommandReceipts(f.db, 10, 1024);
  const service = new ConnectorUpdateService(f.config, { ...f.store, receipts });
  const before = await readFile(f.stateFile, 'utf8');
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('capacity rejection must not download'); });
  await assert.rejects(service.applyCommand('alice', f.body), CommandCapacity);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM command_receipts').get()!.n, 0);
  assert.equal(await readFile(f.stateFile, 'utf8'), before);
  assert.equal(await readlink(f.current), 'old');
});

test('maintenance known download failure has an immutable failed result, not execution success', async t => {
  const f = await commandFixture(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('synthetic secret'); });
  const receipt = await f.service.applyCommand('alice', f.body);
  assert.equal(receipt.state, 'accepted');
  assert.equal(receipt.result?.body.state, 'failed');
  assert.equal(receipt.result?.body.lastError, 'manifest download failed');
  assert.deepEqual(await f.service.applyCommand('alice', f.body), receipt);
  assert.equal(await readlink(f.current), 'old');
});

test('maintenance snapshots caller content before its first await', async t => {
  const f = await commandFixture(t);
  const original = { ...f.body };
  const pending = f.service.applyCommand('alice', f.body);
  f.body.version = '3.0.0';
  f.body.manifestSha256 = '0'.repeat(64);
  f.body.idempotencyKey = 'changed';
  const receipt = await pending;
  assert.equal(receipt.key, 'original');
  assert.equal(receipt.result?.body.state, 'succeeded');
  assert.equal(receipt.result?.body.currentVersion, '2.0.0');
  assert.deepEqual(await f.service.applyCommand('alice', original), receipt);
});

test('interrupted command without selection stays queryable as unknown and never redispatches', async t => {
  const f = await commandFixture(t);
  const internal = f.service as any, save = internal.savePrivate.bind(internal);
  const mock = t.mock.method(internal, 'savePrivate', async (state: any) => {
    const saved = await save(state);
    if (state.state === 'downloading') throw new Error('synthetic interruption');
    return saved;
  });
  await assert.rejects(f.service.applyCommand('alice', f.body), /synthetic interruption/);
  mock.mock.restore();
  const before = await readFile(f.stateFile, 'utf8');
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('unknown cannot dispatch'); });
  const reopened = new ConnectorUpdateService(f.config, f.store);
  assert.equal((await reopened.command('alice', 'apply', 'original'))?.state, 'outcome_unknown');
  assert.equal((await reopened.applyCommand('alice', f.body)).state, 'outcome_unknown');
  await assert.rejects(reopened.check(), /no selection record/);
  assert.equal(await readFile(f.stateFile, 'utf8'), before);
});

test('nonterminal command journal cannot be silently cleared by a new check', async t => {
  const f = await commandFixture(t);
  const mock = t.mock.method(f.receipts, 'settle', () => { throw new Error('synthetic receipt failure'); });
  await assert.rejects(f.service.applyCommand('alice', f.body), /synthetic receipt failure/);
  mock.mock.restore();
  const state = JSON.parse(await readFile(f.stateFile, 'utf8'));
  state.state = 'available';
  await writeFile(f.stateFile, JSON.stringify(state));
  const before = await readFile(f.stateFile, 'utf8');
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('invalid journal cannot download'); });
  await assert.rejects(f.service.check(), /command.*result/);
  assert.equal(await readFile(f.stateFile, 'utf8'), before);
  assert.equal(f.receipts.get(state.updateCommand.scope, 'original')?.state, 'outcome_unknown');
});

test('already selected version gets its own durable result without replacing the original receipt', async t => {
  const f = await commandFixture(t);
  const original = await f.service.applyCommand('alice', f.body);
  const inode = (await lstat(f.current)).ino;
  const next = await f.service.applyCommand('bob', f.body);
  assert.notEqual(next.id, original.id);
  assert.equal(next.result?.body.state, 'succeeded');
  assert.equal((await lstat(f.current)).ino, inode);
  assert.deepEqual(await f.service.command('alice', 'apply', 'original'), original);
  assert.deepEqual(await f.service.command('bob', 'apply', 'original'), next);
});

test('invalid maintenance identity or oversized request is rejected before lock files and receipts', async t => {
  const f = await commandFixture(t);
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('invalid request must not download'); });
  for (const body of [{ ...f.body, idempotencyKey: '' }, { ...f.body, idempotencyKey: 'bad/key' }, { ...f.body, idempotencyKey: undefined },
    { ...f.body, version: 'x'.repeat(8192) }, { ...f.body, revision: '../x' }, { ...f.body, manifestSha256: 'bad' }]) {
    await assert.rejects(f.service.applyCommand('alice', body), CommandConflict);
  }
  await assert.rejects(f.service.applyCommand('', f.body), CommandConflict);
  await assert.rejects(f.service.applyCommand('x'.repeat(4096), f.body), CommandConflict);
  await assert.rejects(f.service.rollbackCommand('alice', undefined), CommandConflict);
  await assert.rejects(f.service.command('alice', 'apply', 'bad/key'), CommandConflict);
  await assert.rejects(lstat(`${f.stateFile}.lock`), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(f.dir, '.agentopsdeck-update.lock')), { code: 'ENOENT' });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM command_receipts').get()!.n, 0);
});

test('oversized rollback result is refused before release selection, not discovered after switching', async t => {
  const f = await commandFixture(t);
  await f.service.applyCommand('alice', f.body);
  const state = JSON.parse(await readFile(f.stateFile, 'utf8'));
  state.previousRelease.version = 'x'.repeat(64 * 1024);
  await writeFile(f.stateFile, JSON.stringify(state));
  const inode = (await lstat(f.current)).ino;
  await assert.rejects(f.service.rollbackCommand('alice', 'rollback'), /result exceeds receipt capacity/);
  assert.equal(await readlink(f.current), f.release);
  assert.equal((await lstat(f.current)).ino, inode);
  assert.equal((await f.service.command('alice', 'rollback', 'rollback'))?.state, 'outcome_unknown');
});

test('update service rejects manifest hash mismatch before install and refuses rollback without previous release', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cod146-update-'));
  const manifest = JSON.stringify({ releases: [{ version: '2.0.0', artifactUrl: 'https://example.test/artifact.tgz', sha256: 'abc' }] });
  (globalThis as any).fetch = async () => new Response(manifest, { status: 200 });
  const service = new ConnectorUpdateService(loadConfig({ AOD_CONNECTOR_UPDATE_ENABLED: 'true', AOD_CONNECTOR_UPDATE_MANIFEST_URL: 'https://example.test/manifest.json', AOD_CONNECTOR_UPDATE_STATE_FILE: path.join(dir, 'state.json'), AOD_CONNECTOR_INSTALL_ROOT: dir, AOD_CONNECTOR_CURRENT_SYMLINK: path.join(dir, 'current') } as any));
  const status = await service.apply({ version: '2.0.0', manifestSha256: 'wrong' });
  assert.equal(status.state, 'failed');
  assert.match(status.lastError ?? '', /manifest hash mismatch/);
  assert.equal(await readFile(path.join(dir, 'state.json'), 'utf8').then((v) => v.includes('artifact.bin')).catch(() => false), false);
  const rollback = await service.rollback();
  assert.equal(rollback.state, 'failed');
  assert.match(rollback.lastError ?? '', /no previous/);
});

test('update service extracts prebuilt tar, validates layout, persists atomically, rolls back and is idempotent', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cod146-update-'));
  const old = path.join(dir, 'releases/old');
  await mkdir(path.join(old, 'dist'), { recursive: true });
  await writeFile(path.join(old, 'package.json'), '{}');
  await writeFile(path.join(old, 'dist/index.js'), 'old');
  const current = path.join(dir, 'current');
  await symlink(old, current);
  const bytes = tar({ 'package.json': '{"type":"module"}', 'dist/index.js': 'console.log("ok")' });
  const artifactHash = createHash('sha256').update(bytes).digest('hex');
  const manifest = JSON.stringify({ releases: [{ version: '2.0.0', revision: 'rev1', artifactUrl: 'https://example.test/artifact.tar', sha256: artifactHash, size: bytes.length }] });
  const manifestHash = createHash('sha256').update(manifest).digest('hex');
  (globalThis as any).fetch = async (url: string) => url.includes('artifact') ? new Response(bytes, { status: 200 }) : new Response(manifest, { status: 200 });
  const service = new ConnectorUpdateService(loadConfig({ AOD_CONNECTOR_UPDATE_ENABLED: 'true', AOD_CONNECTOR_UPDATE_MANIFEST_URL: 'https://example.test/manifest.json', AOD_CONNECTOR_UPDATE_STATE_FILE: path.join(dir, 'state.json'), AOD_CONNECTOR_INSTALL_ROOT: dir, AOD_CONNECTOR_CURRENT_SYMLINK: current } as any));
  const previous = await service.status();
  // Synthetic record of a prior selection, not a known-good/native compatibility claim.
  await writeFile(path.join(dir, 'state.json'), JSON.stringify({ ...previous, selectedRelease: { path: old, version: previous.currentVersion } }));
  const status = await service.apply({ version: '2.0.0', revision: 'rev1', manifestSha256: manifestHash, idempotencyKey: 'same' });
  assert.equal(status.state, 'succeeded');
  assert.equal(status.restartRequired, true);
  assert.match(await readFile(path.join(await readlink(current), 'dist/index.js'), 'utf8'), /ok/);
  assert.doesNotMatch(await readFile(path.join(dir, 'state.json'), 'utf8'), /tmp-/);
  const again = await service.apply({ version: '2.0.0', revision: 'rev1', manifestSha256: manifestHash, idempotencyKey: 'same' });
  assert.equal(again.state, 'succeeded');
  const rollback = await service.rollback();
  assert.equal(rollback.state, 'rolled_back');
  assert.equal(await readlink(current), old);
});

test('update service rejects traversal, symlink escape, size mismatch and missing entrypoint before switching current', async () => {
  for (const [artifact, error] of [
    [tar({ '../evil': 'x', 'package.json': '{}', 'dist/index.js': 'x' }), /unsafe path/],
    [tar({ 'package.json': '{}', 'dist/other.js': 'x' }), /missing required entrypoint/],
    [tar({ 'package.json': '{}', 'dist/index.js': 'x' }, [{ name: 'link', type: '2' }]), /contains links/],
  ] as const) {
    const dir = await mkdtemp(path.join(tmpdir(), 'cod146-update-'));
    const old = path.join(dir, 'old');
    await mkdir(old, { recursive: true });
    const current = path.join(dir, 'current');
    await symlink(old, current);
    const manifest = JSON.stringify({ releases: [{ version: '2.0.0', artifactUrl: 'https://example.test/artifact.tar', sha256: createHash('sha256').update(artifact).digest('hex'), size: artifact.length }] });
    (globalThis as any).fetch = async (url: string) => url.includes('artifact') ? new Response(artifact, { status: 200 }) : new Response(manifest, { status: 200 });
    const service = new ConnectorUpdateService(loadConfig({ AOD_CONNECTOR_UPDATE_ENABLED: 'true', AOD_CONNECTOR_VERSION: '1.0.0', AOD_CONNECTOR_UPDATE_MANIFEST_URL: 'https://example.test/manifest.json', AOD_CONNECTOR_UPDATE_STATE_FILE: path.join(dir, 'state.json'), AOD_CONNECTOR_INSTALL_ROOT: dir, AOD_CONNECTOR_CURRENT_SYMLINK: current } as any));
    const status = await service.apply({ version: '2.0.0', manifestSha256: createHash('sha256').update(manifest).digest('hex') });
    assert.equal(status.state, 'failed');
    assert.match(status.lastError ?? '', error);
    assert.equal(await readlink(current), old);
  }
});

test('update service rejects malformed tar headers, truncated payloads, and active-release replacement', async () => {
  const good = tar({ 'package.json': '{}', 'dist/index.js': 'x' });
  const badChecksum = Buffer.from(good);
  badChecksum[0] = 'X'.charCodeAt(0);
  const badSize = Buffer.from(good);
  badSize.write('99999999999\0', 124, 12);
  fixChecksum(badSize);
  const truncated = good.subarray(0, good.length - 900);
  for (const [artifact, error] of [
    [badChecksum, /checksum mismatch/],
    [badSize, /invalid size/],
    [truncated, /truncated/],
  ] as const) {
    const dir = await mkdtemp(path.join(tmpdir(), 'cod146-update-'));
    const old = path.join(dir, 'old');
    await mkdir(old, { recursive: true });
    const current = path.join(dir, 'current');
    await symlink(old, current);
    const manifest = JSON.stringify({ releases: [{ version: '2.0.0', artifactUrl: 'https://example.test/artifact.tar', sha256: createHash('sha256').update(artifact).digest('hex'), size: artifact.length }] });
    (globalThis as any).fetch = async (url: string) => url.includes('artifact') ? new Response(artifact, { status: 200 }) : new Response(manifest, { status: 200 });
    const service = new ConnectorUpdateService(loadConfig({ AOD_CONNECTOR_UPDATE_ENABLED: 'true', AOD_CONNECTOR_VERSION: '1.0.0', AOD_CONNECTOR_UPDATE_MANIFEST_URL: 'https://example.test/manifest.json', AOD_CONNECTOR_UPDATE_STATE_FILE: path.join(dir, 'state.json'), AOD_CONNECTOR_INSTALL_ROOT: dir, AOD_CONNECTOR_CURRENT_SYMLINK: current } as any));
    const status = await service.apply({ version: '2.0.0', manifestSha256: createHash('sha256').update(manifest).digest('hex') });
    assert.equal(status.state, 'failed');
    assert.match(status.lastError ?? '', error);
    assert.equal(await readlink(current), old);
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'cod146-update-'));
  const activeRelease = path.join(dir, 'releases/2.0.0-no-rev');
  await mkdir(activeRelease, { recursive: true });
  const current = path.join(dir, 'current');
  await symlink(activeRelease, current);
  const manifest = JSON.stringify({ releases: [{ version: '2.0.0', artifactUrl: 'https://example.test/artifact.tar', sha256: createHash('sha256').update(good).digest('hex'), size: good.length }] });
  (globalThis as any).fetch = async (url: string) => url.includes('artifact') ? new Response(good, { status: 200 }) : new Response(manifest, { status: 200 });
  const service = new ConnectorUpdateService(loadConfig({ AOD_CONNECTOR_UPDATE_ENABLED: 'true', AOD_CONNECTOR_UPDATE_MANIFEST_URL: 'https://example.test/manifest.json', AOD_CONNECTOR_UPDATE_STATE_FILE: path.join(dir, 'state.json'), AOD_CONNECTOR_INSTALL_ROOT: dir, AOD_CONNECTOR_CURRENT_SYMLINK: current, AOD_CONNECTOR_VERSION: '1.0.0' } as any));
  const status = await service.apply({ version: '2.0.0', manifestSha256: createHash('sha256').update(manifest).digest('hex') });
  assert.equal(status.state, 'failed');
  assert.match(status.lastError ?? '', /active release path/);
  assert.equal(await readlink(current), activeRelease);
});

for (const kind of ['relative-active', 'previous', 'inactive', 'empty', 'symlink'] as const) {
  test(`update preserves an existing ${kind} release, including its inode`, async (t) => {
    const f = await updateFixture(t);
    await mkdir(f.release, { recursive: true });
    if (kind !== 'empty') await writeFile(path.join(f.release, 'marker'), 'original');
    let target = f.release;
    if (kind === 'symlink') {
      target = path.join(f.dir, 'linked-release');
      await symlink(f.release, target);
      f.config.connector.installRoot = path.join(f.dir, 'alternate');
      await mkdir(path.join(f.config.connector.installRoot, 'releases'), { recursive: true });
      await symlink(target, path.join(f.config.connector.installRoot, 'releases/2.0.0-no-rev'));
      target = path.join(f.config.connector.installRoot, 'releases/2.0.0-no-rev');
    }
    const link = kind === 'relative-active' ? 'releases/2.0.0-no-rev' : 'old';
    await symlink(link, f.current);
    if (kind === 'previous') await writeFile(f.stateFile, JSON.stringify({ ...await f.service.status(), previousSymlinkTarget: f.release, rollbackAvailable: true }));
    const before = await lstat(target);
    const result = await f.service.apply(f.body);
    assert.equal(result.state, 'failed');
    assert.match(result.lastError ?? '', /active release path|EEXIST|already exists/);
    assert.equal(await readlink(f.current), link);
    const after = await lstat(target);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode, before.mode);
    assert.deepEqual(await readdir(f.release), kind === 'empty' ? [] : ['marker']);
    if (kind !== 'empty') assert.equal(await readFile(path.join(f.release, 'marker'), 'utf8'), 'original');
    if (kind === 'previous') assert.equal(JSON.parse(await readFile(f.stateFile, 'utf8')).previousSymlinkTarget, f.release);
  });
}

test('update refuses to overwrite a regular current file', async (t) => {
  const f = await updateFixture(t);
  await writeFile(f.current, 'not a managed link');
  assert.equal((await f.service.apply(f.body)).state, 'failed');
  assert.equal(await readFile(f.current, 'utf8'), 'not a managed link');
  await assert.rejects(lstat(f.release), { code: 'ENOENT' });
});

test('update resolves a relative previous link against current parent across service reopen', async (t) => {
  const f = await updateFixture(t);
  await symlink('old', f.current);
  assert.equal((await f.service.apply(f.body)).state, 'succeeded');
  const persisted = JSON.parse(await readFile(f.stateFile, 'utf8'));
  assert.equal(persisted.previousSymlinkTarget, path.join(f.dir, 'old'));
  assert.equal((await new ConnectorUpdateService(f.config).rollback()).state, 'rolled_back');
  assert.equal(await readlink(f.current), path.join(f.dir, 'old'));
});

for (const content of ['{', 'null', '[]', '{"previousSymlinkTarget":42}', '{"state":"unexpected"}', '{"rollbackAvailable":"yes"}']) {
  test(`update refuses unreadable state without mutation: ${content}`, async (t) => {
    const f = await updateFixture(t);
    await symlink('old', f.current);
    const source = content.startsWith('{"') ? JSON.stringify({ ...await f.service.status(), ...JSON.parse(content) }) : content;
    await writeFile(f.stateFile, source);
    t.mock.method(globalThis, 'fetch', async () => { assert.fail('must not fetch with corrupt state'); });
    for (const operation of [() => f.service.status(), () => f.service.check(), () => f.service.apply(f.body), () => f.service.rollback()]) {
      await assert.rejects(operation, /update state/);
      assert.equal(await readFile(f.stateFile, 'utf8'), source);
      assert.equal(await readlink(f.current), 'old');
    }
    await assert.rejects(lstat(f.release), { code: 'ENOENT' });
  });
}

test('update does not treat a state read error as first install', async (t) => {
  const f = await updateFixture(t);
  await unlink(f.stateFile);
  await mkdir(f.stateFile);
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('must not fetch'); });
  await assert.rejects(f.service.apply(f.body), /update state/);
  assert.equal((await lstat(f.stateFile)).isDirectory(), true);
});

test('invalid fresh release only removes its own partial directory', async (t) => {
  const f = await updateFixture(t, tar({ 'package.json': '{}' }));
  await symlink('old', f.current);
  const old = path.join(f.dir, 'old');
  await writeFile(path.join(old, 'marker'), 'keep');
  assert.equal((await f.service.apply(f.body)).state, 'failed');
  await assert.rejects(lstat(f.release), { code: 'ENOENT' });
  assert.equal(await readlink(f.current), 'old');
  assert.equal(await readFile(path.join(old, 'marker'), 'utf8'), 'keep');
});

test('selection failure removes only the reserved release and preserves unrelated staging paths', async (t) => {
  const f = await updateFixture(t);
  const staleLink = `${f.current}.next`;
  await symlink('old', staleLink);
  f.config.connector.currentSymlink = path.join(f.dir, 'missing-parent/current');
  const result = await f.service.apply(f.body);
  assert.equal(result.state, 'failed');
  assert.match(result.lastError ?? '', /ENOENT/);
  await assert.rejects(lstat(f.release), { code: 'ENOENT' });
  assert.equal(await readlink(staleLink), 'old');
  assert.equal((await lstat(path.join(f.dir, 'old'))).isDirectory(), true);
  assert.equal((await new ConnectorUpdateService(f.config).status()).state, 'failed');
});

test('selected release survives failed final state write and recovers its selection on reopen', async (t) => {
  const f = await updateFixture(t);
  await symlink('old', f.current);
  const service = f.service as any;
  const save = service.savePrivate.bind(service);
  t.mock.method(service, 'savePrivate', async (state: { state: string }) => {
    if (state.state === 'succeeded') throw new Error('synthetic state-write failure');
    return save(state);
  });
  await assert.rejects(f.service.apply(f.body), /synthetic state-write failure/);
  assert.equal(await readlink(f.current), f.release);
  assert.equal(await readFile(path.join(f.release, 'dist/index.js'), 'utf8'), 'new');
  const recovered = await new ConnectorUpdateService(f.config).status();
  assert.equal(recovered.state, 'succeeded');
  assert.equal(recovered.currentVersion, '2.0.0');
  assert.equal('selection' in recovered, false);
  assert.equal(JSON.parse(await readFile(f.stateFile, 'utf8')).selection, undefined);
  assert.equal((await readdir(f.dir)).some((name) => name.startsWith('current.next-')), false);
});

for (const point of ['before', 'after'] as const) {
  test(`terminated installer recovers ${point} selection without another download or switch`, async (t) => {
    const f = await updateFixture(t);
    await symlink('old', f.current);
    terminateInstaller(f, point);
    const recorded = JSON.parse(await readFile(f.stateFile, 'utf8'));
    assert.equal(recorded.selection.before, path.join(f.dir, 'old'));
    assert.equal(recorded.selection.after, f.release);
    const selected = await readlink(f.current);
    assert.equal(selected, point === 'after' ? f.release : 'old');
    const inode = (await lstat(f.release)).ino;
    t.mock.method(globalThis, 'fetch', async () => { assert.fail('recovery must not download'); });
    const service = new ConnectorUpdateService(f.config);
    const recovered = await service.status();
    assert.equal(recovered.state, point === 'after' ? 'succeeded' : 'failed');
    assert.equal(recovered.currentVersion, point === 'after' ? '2.0.0' : '1.0.0');
    assert.equal(await readlink(f.current), selected);
    assert.equal((await lstat(f.release)).ino, inode);
    const saved = await readFile(f.stateFile, 'utf8');
    assert.equal(JSON.parse(saved).selection, undefined);
    assert.deepEqual(await service.status(), recovered);
    assert.equal(await readFile(f.stateFile, 'utf8'), saved);
    assert.deepEqual(await service.apply({ ...f.body, idempotencyKey: 'crash-test' }), recovered);
  });
}

for (const change of ['unrelated-link', 'regular-current', 'configured-link', 'invalid-intent'] as const) {
  test(`recovery refuses ambiguous selection (${change}) and preserves evidence`, async (t) => {
    const f = await updateFixture(t);
    await symlink('old', f.current);
    terminateInstaller(f, 'after');
    if (change === 'unrelated-link' || change === 'regular-current') {
      await unlink(f.current);
      if (change === 'unrelated-link') await symlink('somewhere-else', f.current);
      else await writeFile(f.current, 'keep this file');
    } else if (change === 'configured-link') f.config.connector.currentSymlink = path.join(f.dir, 'another-current');
    else {
      const state = JSON.parse(await readFile(f.stateFile, 'utf8'));
      state.selection = { ...state.selection, completed: { state: 'succeeded' } };
      await writeFile(f.stateFile, JSON.stringify(state));
    }
    const original = await readFile(f.stateFile, 'utf8');
    const inode = (await lstat(f.current)).ino;
    t.mock.method(globalThis, 'fetch', async () => { assert.fail('unresolved selection must not fetch'); });
    const service = new ConnectorUpdateService(f.config);
    for (const operation of [() => service.status(), () => service.check(), () => service.apply(f.body), () => service.rollback()]) {
      await assert.rejects(operation, /selection|update state/);
      assert.equal(await readFile(f.stateFile, 'utf8'), original);
      assert.equal((await lstat(f.current)).ino, inode);
    }
    assert.equal(await readFile(path.join(f.release, 'dist/index.js'), 'utf8'), 'new');
  });
}

test('rollback reports the previous selected version and recovers a failed final write', async (t) => {
  const f = await updateFixture(t);
  await symlink('old', f.current);
  await f.service.apply(f.body);
  const service = f.service as any;
  const save = service.savePrivate.bind(service);
  t.mock.method(service, 'savePrivate', async (state: { state: string }) => {
    if (state.state === 'rolled_back') throw new Error('synthetic rollback state failure');
    return save(state);
  });
  await assert.rejects(f.service.rollback(), /synthetic rollback state failure/);
  assert.equal(await readlink(f.current), path.join(f.dir, 'old'));
  const reopened = new ConnectorUpdateService(f.config);
  const result = await reopened.status();
  assert.equal(result.state, 'rolled_back');
  assert.equal(result.currentVersion, '1.0.0');
  assert.equal(result.rollbackAvailable, false);
  assert.equal('previousRelease' in result, false);
  const inode = (await lstat(f.current)).ino;
  assert.deepEqual(await reopened.rollback(), result);
  assert.equal((await lstat(f.current)).ino, inode);
});

function terminateInstaller(f: Awaited<ReturnType<typeof updateFixture>>, point: 'before' | 'after') {
  const result = spawnSync(process.execPath, [...fixtureLoaderArgs, '--input-type=module', '-e', installerScript(f, point)], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, point === 'before' ? 71 : 72, result.stderr);
}

function installerScript(f: Awaited<ReturnType<typeof updateFixture>>, point: 'before' | 'after', hold = false, command = false, collect = false) {
  const artifact = tar({ 'package.json': '{}', 'dist/index.js': 'new' });
  const manifest = JSON.stringify({ releases: [{ version: '2.0.0', artifactUrl: 'https://example.test/artifact.tar', sha256: createHash('sha256').update(artifact).digest('hex'), size: artifact.length }] });
  return `
    import { ConnectorUpdateService } from ${JSON.stringify(new URL('./update-service.js', import.meta.url).href)};
    import { CommandReceipts } from ${JSON.stringify(new URL('../commands/receipts.js', import.meta.url).href)};
    import { DatabaseSync } from 'node:sqlite';
    const commandStore = ${command ? `{ nodeId: 'synthetic-node', receipts: new CommandReceipts(new DatabaseSync(${JSON.stringify(path.join(f.dir, 'commands.sqlite'))})) }` : 'undefined'};
    const service = new ConnectorUpdateService(${JSON.stringify(f.config)}, commandStore);
    globalThis.fetch = async url => new Response(url.includes('artifact') ? Buffer.from(${JSON.stringify(artifact.toString('base64'))}, 'base64') : ${JSON.stringify(manifest)});
    async function stop(code) {
      if (!${hold}) process.exit(code);
      setInterval(() => {}, 1000);
      if (${collect}) {
        setImmediate(async () => {
          for (let round = 0; round < 6; round++) {
            globalThis.gc();
            await new Promise(resolve => setImmediate(resolve));
          }
          process.send('ready');
        });
      } else process.send('ready');
      await new Promise(resolve => process.once('SIGTERM', resolve));
    }
    const save = service.savePrivate.bind(service);
    service.savePrivate = async state => {
      if (${JSON.stringify(point)} === 'after' && state.state === 'succeeded') await stop(72);
      const result = await save(state);
      if (${JSON.stringify(point)} === 'before' && state.selection) await stop(71);
      return result;
    };
    await service.${command ? "applyCommand('alice', " : 'apply('}${JSON.stringify({ ...f.body, idempotencyKey: 'crash-test' })});
  `;
}

for (const point of ['before', 'after'] as const) {
  test(`maintenance receipt survives real process kill ${point} selection; live writer is never recovered`, { timeout: 15_000 }, async t => {
    const f = await commandFixture(t);
    // Readiness is protocol data, not the first stdout chunk: diagnostics may
    // be emitted before the installer reaches its durable selection fence.
    const proc = spawn(process.execPath, [...fixtureLoaderArgs, '--input-type=module', '-e', installerScript(f, point, true, true)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); });
    const timer = setTimeout(() => proc.kill('SIGKILL'), 10_000); timer.unref(); t.after(() => clearTimeout(timer));
    assert.equal(await Promise.race([once(proc, 'message').then(([message]) => message), once(proc, 'exit').then(() => { throw new Error('installer exited before readiness'); })]), 'ready');
    if (process.platform !== 'win32') proc.kill('SIGSTOP');
    const original = await readFile(f.stateFile, 'utf8'), inode = (await lstat(f.current)).ino;
    const body = { ...f.body, idempotencyKey: 'crash-test' };
    t.mock.method(globalThis, 'fetch', async () => { assert.fail('receipt recovery must not download'); });
    assert.equal((await f.service.command('alice', 'apply', 'crash-test'))?.state, 'outcome_unknown');
    assert.equal((await f.service.applyCommand('alice', body)).state, 'outcome_unknown');
    assert.equal(await readFile(f.stateFile, 'utf8'), original);
    assert.equal((await lstat(f.current)).ino, inode);
    const exited = once(proc, 'exit'); proc.kill('SIGKILL'); await exited;
    const reopened = new ConnectorUpdateService(f.config, { ...f.store, receipts: new CommandReceipts(f.db) });
    const result = await reopened.command('alice', 'apply', 'crash-test');
    assert.equal(result?.state, 'accepted');
    assert.equal(result?.result?.body.state, point === 'after' ? 'succeeded' : 'failed');
    assert.deepEqual(await reopened.applyCommand('alice', body), result);
    assert.equal((await lstat(f.current)).ino, inode, 'recovery never selects again');
  });
}

for (const point of ['before', 'after'] as const) for (const collect of [false, true]) {
  test(`live and stopped installer keeps cross-process ownership ${point} selection until killed${collect ? ' with forced GC' : ''}`, { timeout: 15_000 }, async (t) => {
    const f = await updateFixture(t);
    await symlink('old', f.current);
    const proc = spawn(process.execPath, ['--expose-gc', ...fixtureLoaderArgs, '--input-type=module', '-e', installerScript(f, point, true, false, collect)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); });
    const timer = setTimeout(() => proc.kill('SIGKILL'), 10_000); timer.unref(); t.after(() => clearTimeout(timer));
    const ready = await Promise.race([once(proc, 'message').then(([message]) => message), once(proc, 'exit').then(() => { throw new Error('installer exited before readiness'); })]);
    assert.equal(ready, 'ready');
    const original = await readFile(f.stateFile, 'utf8');
    const linkInode = (await lstat(f.current)).ino;
    assert.equal((await f.service.status()).state, 'installing');
    if (process.platform !== 'win32') proc.kill('SIGSTOP');
    const alias = path.join(f.dir, 'root-alias');
    await symlink(f.dir, alias);
    const configs = [f.config,
      { ...f.config, connector: { ...f.config.connector, installRoot: alias, updateStateFile: path.join(alias, 'state.json') } },
      { ...f.config, connector: { ...f.config.connector, updateStateFile: path.join(f.dir, 'other-state.json') } },
      { ...f.config, connector: { ...f.config.connector, installRoot: path.join(f.dir, 'another-install') } }];
    t.mock.method(globalThis, 'fetch', async () => { assert.fail('contender must not fetch'); });
    for (const config of configs) {
      const contender = new ConnectorUpdateService(config);
      for (const operation of [() => contender.check(), () => contender.apply(f.body), () => contender.rollback()]) await assert.rejects(operation, /already in progress/);
    }
    assert.equal((await f.service.status()).state, 'installing');
    assert.equal(await readFile(f.stateFile, 'utf8'), original);
    assert.equal((await lstat(f.current)).ino, linkInode);
    const exit = once(proc, 'exit'); proc.kill('SIGKILL'); await exit;
    assert.equal((await f.service.status()).state, point === 'after' ? 'succeeded' : 'failed');
    assert.equal((await lstat(f.current)).ino, linkInode);
  });
}

test('same-process alias contention does not release the kernel update lock', { timeout: 10_000 }, async (t) => {
  const f = await updateFixture(t);
  await symlink('old', f.current);
  let ready!: () => void, release!: () => void;
  const pending = new Promise<void>((resolve) => { ready = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const service = f.service as any;
  const save = service.savePrivate.bind(service);
  t.mock.method(service, 'savePrivate', async (state: { selection?: unknown }) => {
    const result = await save(state);
    if (state.selection) { ready(); await gate; }
    return result;
  });
  const running = f.service.apply(f.body);
  t.after(async () => { release(); await running; });
  await pending;
  assert.equal((await f.service.status()).state, 'installing');
  const alias = path.join(f.dir, 'root-alias'); await symlink(f.dir, alias);
  const contender = new ConnectorUpdateService({ ...f.config, connector: { ...f.config.connector, installRoot: alias, updateStateFile: path.join(alias, 'state.json') } });
  await assert.rejects(contender.apply(f.body), /already in progress/);
  const probe = spawnSync(process.execPath, [...fixtureLoaderArgs, '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { ConnectorUpdateService } from ${JSON.stringify(new URL('./update-service.js', import.meta.url).href)};
    await assert.rejects(new ConnectorUpdateService(${JSON.stringify(f.config)}).apply(${JSON.stringify(f.body)}), /already in progress/);
  `], { encoding: 'utf8', timeout: 5_000 });
  assert.equal(probe.status, 0, probe.stderr);
  const independent = await updateFixture(t);
  assert.equal((await independent.service.apply(independent.body)).state, 'succeeded', 'unrelated installations remain independent');
  release();
  assert.equal((await running).state, 'succeeded');
  assert.equal((await contender.status()).state, 'succeeded');
});

test('reopen does not fill a selected revision from the older running binary', async (t) => {
  const f = await updateFixture(t);
  f.config.connector.revision = 'old-revision';
  await symlink('old', f.current);
  assert.equal((await f.service.apply(f.body)).currentRevision, undefined);
  const reopened = new ConnectorUpdateService(f.config);
  assert.equal((await reopened.status()).currentRevision, undefined);
  const rollback = await reopened.rollback();
  assert.equal(rollback.currentVersion, '1.0.0');
  assert.equal(rollback.currentRevision, undefined, 'the prior selection did not record a revision either');
});

for (const state of ['downloading', 'verifying', 'installing', 'restarting']) {
  test(`unfinished ${state} without a selection record cannot be overwritten by new work`, async (t) => {
    const f = await updateFixture(t);
    await symlink('old', f.current);
    const source = JSON.stringify({ ...await f.service.status(), state });
    await writeFile(f.stateFile, source);
    t.mock.method(globalThis, 'fetch', async () => { assert.fail('must not replay an unrecorded operation'); });
    for (const operation of [() => f.service.status(), () => f.service.check(), () => f.service.apply(f.body), () => f.service.rollback()]) await assert.rejects(operation, /no selection record/);
    assert.equal(await readFile(f.stateFile, 'utf8'), source);
    assert.equal(await readlink(f.current), 'old');
  });
}

for (const changed of [false, true]) {
  test(`recovery ${changed ? 'preserves changed' : 'cleans its own'} interrupted temporary link`, async (t) => {
    const f = await updateFixture(t);
    await symlink('old', f.current);
    terminateInstaller(f, 'before');
    const source = await readFile(f.stateFile, 'utf8');
    const selection = JSON.parse(source).selection;
    await symlink(changed ? 'elsewhere' : f.release, selection.temporaryLink);
    if (changed) {
      await assert.rejects(f.service.status(), /temporary selection link changed/);
      assert.equal(await readFile(f.stateFile, 'utf8'), source);
      assert.equal(await readlink(selection.temporaryLink), 'elsewhere');
    } else {
      assert.equal((await f.service.status()).state, 'failed');
      await assert.rejects(lstat(selection.temporaryLink), { code: 'ENOENT' });
    }
    assert.equal(await readlink(f.current), 'old');
    assert.equal(await readFile(path.join(f.release, 'dist/index.js'), 'utf8'), 'new');
  });
}

for (const kind of ['symlink', 'hardlink'] as const) {
  test(`update refuses an aliased ${kind} lock before opening it`, async (t) => {
    const f = await updateFixture(t);
    const original = path.join(f.dir, 'unrelated');
    await writeFile(original, 'not a lock');
    const lock = path.join(f.dir, '.agentopsdeck-update.lock');
    if (kind === 'symlink') await symlink(original, lock);
    else await link(original, lock);
    const inode = (await lstat(lock)).ino;
    t.mock.method(globalThis, 'fetch', async () => { assert.fail('must not fetch'); });
    await assert.rejects(f.service.apply(f.body), /update lock must be/);
    assert.equal((await lstat(lock)).ino, inode);
    assert.equal(await readFile(original, 'utf8'), 'not a lock');
  });
}

test('update lock files hold no application tables, stay private and keep their inode and size', async (t) => {
  const f = await updateFixture(t);
  await symlink('old', f.current);
  await f.service.apply(f.body);
  const files = [path.join(f.dir, '.agentopsdeck-update.lock'), f.stateFile + '.lock'];
  const before = await Promise.all(files.map(file => lstat(file)));
  await f.service.rollback();
  for (const [index, file] of files.entries()) {
    const stat = await lstat(file);
    assert.equal(stat.ino, before[index]!.ino);
    assert.equal(stat.size, before[index]!.size);
    assert.equal(stat.mode & 0o777, 0o600);
    const db = new DatabaseSync(file, { readOnly: true });
    try { assert.deepEqual(db.prepare('SELECT name FROM sqlite_schema').all(), []); }
    finally { db.close(); }
  }
});

test('recovery state-write failure retains the intent and can be retried without reselecting', async (t) => {
  const f = await updateFixture(t);
  await symlink('old', f.current);
  terminateInstaller(f, 'after');
  const original = await readFile(f.stateFile, 'utf8');
  const inode = (await lstat(f.current)).ino;
  const failing = new ConnectorUpdateService(f.config);
  t.mock.method(failing as any, 'savePrivate', async () => { throw new Error('synthetic recovery save failure'); });
  await assert.rejects(failing.status(), /synthetic recovery save failure/);
  assert.equal(await readFile(f.stateFile, 'utf8'), original);
  assert.equal((await new ConnectorUpdateService(f.config).status()).state, 'succeeded');
  assert.equal((await lstat(f.current)).ino, inode);
});

for (const operation of ['direct', 'command'] as const) {
  for (const defect of ['missing-package', 'missing-entrypoint', 'package-directory', 'entrypoint-directory', 'package-symlink', 'entrypoint-symlink', 'parent-symlink', 'root-symlink', 'entrypoint-hardlink'] as const) {
    test(`${operation} rollback rejects ${defect} without selecting or replaying`, async context => {
      const setup = await commandFixture(context);
      await setup.service.applyCommand('alice', setup.body);
      const previous = path.join(setup.dir, 'old');
      const outside = path.join(setup.dir, 'outside');
      await mkdir(path.join(outside, 'dist'), { recursive: true });
      await writeFile(path.join(outside, 'package.json'), '{}');
      await writeFile(path.join(outside, 'dist/index.js'), 'external');
      const target = defect.startsWith('package') || defect === 'missing-package' ? path.join(previous, 'package.json')
        : defect === 'parent-symlink' ? path.join(previous, 'dist') : defect === 'root-symlink' ? previous : path.join(previous, 'dist/index.js');
      await rm(target, { recursive: true });
      if (defect.endsWith('directory')) await mkdir(target);
      if (defect.endsWith('symlink')) await symlink(defect === 'root-symlink' ? outside
        : defect === 'parent-symlink' ? path.join(outside, 'dist')
          : path.join(outside, defect === 'package-symlink' ? 'package.json' : 'dist/index.js'), target);
      if (defect === 'entrypoint-hardlink') await link(path.join(outside, 'dist/index.js'), target);
      const original = await readFile(setup.stateFile, 'utf8');
      const inode = (await lstat(setup.current)).ino;
      const rollback = () => operation === 'direct' ? setup.service.rollback() : setup.service.rollbackCommand('alice', 'rollback-layout');
      await assert.rejects(rollback(), /release|entrypoint/);
      assert.equal(await readlink(setup.current), setup.release);
      assert.equal((await lstat(setup.current)).ino, inode);
      assert.equal((await readdir(setup.dir)).some(name => name.startsWith('current.next-')), false);
      if (operation === 'direct') assert.equal(await readFile(setup.stateFile, 'utf8'), original);
      else {
        const receipt = await setup.service.command('alice', 'rollback', 'rollback-layout');
        assert.equal(receipt?.state, 'outcome_unknown');
        await rm(previous, { recursive: true });
        await mkdir(path.join(previous, 'dist'), { recursive: true });
        await writeFile(path.join(previous, 'package.json'), '{}');
        await writeFile(path.join(previous, 'dist/index.js'), 'repaired');
        const reopened = new ConnectorUpdateService(setup.config, setup.store);
        assert.equal((await reopened.rollbackCommand('alice', 'rollback-layout')).id, receipt?.id);
        assert.equal((await lstat(setup.current)).ino, inode);
        assert.equal(await readlink(setup.current), setup.release);
      }
      assert.equal(await readFile(path.join(outside, 'dist/index.js'), 'utf8'), 'external');
    });
  }
}

test('rollback retains the recorded custom entrypoint across installs and journal recovery', async context => {
  const setup = await updateFixture(context);
  await symlink('old', setup.current);
  for (const [version, entrypoint] of [['2.0.0', 'server/main.js'], ['3.0.0', 'dist/index.js']] as const) {
    const artifact = tar({ 'package.json': '{}', [entrypoint]: version });
    const manifest = JSON.stringify({ releases: [{ version, entrypoint, artifactUrl: 'https://example.test/artifact.tar', sha256: createHash('sha256').update(artifact).digest('hex') }] });
    context.mock.method(globalThis, 'fetch', async (url: string) => new Response(url.includes('artifact') ? artifact : manifest));
    assert.equal((await setup.service.apply({ version, manifestSha256: createHash('sha256').update(manifest).digest('hex') })).state, 'succeeded');
  }
  const stored = JSON.parse(await readFile(setup.stateFile, 'utf8'));
  assert.equal(stored.previousRelease.entrypoint, 'server/main.js');
  const internal = setup.service as any;
  const save = internal.savePrivate.bind(internal);
  context.mock.method(internal, 'savePrivate', async (state: { state: string }) => {
    if (state.state === 'rolled_back') throw new Error('synthetic rollback final write failure');
    return save(state);
  });
  await assert.rejects(setup.service.rollback(), /synthetic rollback final write failure/);
  const reopened = new ConnectorUpdateService(setup.config);
  const selected = await readlink(setup.current);
  await unlink(path.join(selected, 'server/main.js'));
  await mkdir(path.join(selected, 'dist'));
  await writeFile(path.join(selected, 'dist/index.js'), 'not the recorded entrypoint');
  const pending = await readFile(setup.stateFile, 'utf8');
  await assert.rejects(reopened.status(), /missing required entrypoint/);
  assert.equal(await readFile(setup.stateFile, 'utf8'), pending);
  await writeFile(path.join(selected, 'server/main.js'), '2.0.0');
  assert.equal((await reopened.status()).state, 'rolled_back');
  assert.equal(await readFile(path.join(await readlink(setup.current), 'server/main.js'), 'utf8'), '2.0.0');
  assert.equal(JSON.parse(await readFile(setup.stateFile, 'utf8')).selectedRelease.entrypoint, 'server/main.js');
});

test('selected rollback recovery refuses a damaged layout before settling the original receipt', async context => {
  const setup = await commandFixture(context);
  await setup.service.applyCommand('alice', setup.body);
  const internal = setup.service as any;
  const save = internal.savePrivate.bind(internal);
  context.mock.method(internal, 'savePrivate', async (state: { state: string }) => {
    if (state.state === 'rolled_back') throw new Error('synthetic rollback final write failure');
    return save(state);
  });
  await assert.rejects(setup.service.rollbackCommand('alice', 'rollback-layout'), /synthetic rollback final write failure/);
  const entrypoint = path.join(setup.dir, 'old/dist/index.js');
  await unlink(entrypoint);
  const inode = (await lstat(setup.current)).ino;
  const original = await readFile(setup.stateFile, 'utf8');
  const reopened = new ConnectorUpdateService(setup.config, setup.store);
  await assert.rejects(reopened.status(), /missing required entrypoint/);
  assert.equal(await readFile(setup.stateFile, 'utf8'), original);
  await writeFile(entrypoint, 'restored');
  assert.equal((await reopened.command('alice', 'rollback', 'rollback-layout'))?.result?.body.state, 'rolled_back');
  assert.equal((await lstat(setup.current)).ino, inode);
});

for (const entrypoint of ['', '../outside.js', '/absolute.js', 'nested//index.js', 'nested/./index.js', 'nested\\index.js', 'C:/index.js', 'nul\0index.js', null, 42]) {
  test(`release selection refuses invalid manifest entrypoint ${JSON.stringify(entrypoint)}`, async context => {
    const setup = await updateFixture(context);
    await symlink('old', setup.current);
    const artifact = tar({ 'package.json': '{}', 'dist/index.js': 'new' });
    const manifest = JSON.stringify({ releases: [{ version: '2.0.0', entrypoint, artifactUrl: 'https://example.test/artifact.tar', sha256: createHash('sha256').update(artifact).digest('hex') }] });
    context.mock.method(globalThis, 'fetch', async (url: string) => new Response(url.includes('artifact') ? artifact : manifest));
    const inode = (await lstat(setup.current)).ino;
    const result = await setup.service.apply({ version: '2.0.0', manifestSha256: createHash('sha256').update(manifest).digest('hex') });
    assert.equal(result.state, 'failed');
    assert.match(result.lastError ?? '', /invalid entrypoint|escapes/);
    assert.equal((await lstat(setup.current)).ino, inode);
    assert.equal(await readlink(setup.current), 'old');
    assert.equal((await new ConnectorUpdateService(setup.config).status()).state, 'failed');
    await assert.rejects(lstat(setup.release), { code: 'ENOENT' });
  });
}

test('legacy rollback metadata cannot guess the previous version', async (t) => {
  const f = await updateFixture(t);
  await symlink('old', f.current);
  const state = { ...await f.service.status(), rollbackAvailable: true, previousSymlinkTarget: path.join(f.dir, 'old') };
  const source = JSON.stringify(state);
  await writeFile(f.stateFile, source);
  const inode = (await lstat(f.current)).ino;
  await assert.rejects(f.service.rollback(), /previous release version is unknown/);
  assert.equal(await readFile(f.stateFile, 'utf8'), source);
  assert.equal((await lstat(f.current)).ino, inode);
});

test('unrecorded initial version is not rollback evidence; two recorded installs can roll back', async (t) => {
  const f = await updateFixture(t);
  await symlink('old', f.current);
  await writeFile(f.stateFile, JSON.stringify(await f.service.status())); // Historical public-only shape.
  assert.equal((await f.service.apply(f.body)).rollbackAvailable, false);
  const original = await readFile(f.stateFile, 'utf8');
  await assert.rejects(f.service.rollback(), /previous release version is unknown/);
  assert.equal(await readFile(f.stateFile, 'utf8'), original);
  const artifact = tar({ 'package.json': '{}', 'dist/index.js': 'third' });
  const manifest = JSON.stringify({ releases: [{ version: '3.0.0', artifactUrl: 'https://example.test/artifact.tar', sha256: createHash('sha256').update(artifact).digest('hex') }] });
  t.mock.method(globalThis, 'fetch', async (url: string) => new Response(url.includes('artifact') ? artifact : manifest));
  const third = await f.service.apply({ version: '3.0.0', manifestSha256: createHash('sha256').update(manifest).digest('hex') });
  assert.equal(third.rollbackAvailable, true);
  assert.equal('selectedRelease' in third, false);
  const rollback = await new ConnectorUpdateService(f.config).rollback();
  assert.equal(rollback.currentVersion, '2.0.0');
  assert.equal(await readlink(f.current), f.release);
});

test('oversized manifest is refused before reading or changing update state', async t => {
  const f = await updateFixture(t);
  const original = await readFile(f.stateFile, 'utf8');
  let cancelled = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>({
    pull(c) { c.enqueue(Buffer.from(' '.repeat(1024 * 1024) + '[]')); c.close(); },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 }), { headers: { 'content-length': String(1024 * 1024 + 2) } }));
  await assert.rejects(f.service.check(), /size limit/);
  assert.equal(cancelled, 1);
  assert.equal(await readFile(f.stateFile, 'utf8'), original);
});

test('known artifact transport failure does not strand an unjournaled downloading state', async t => {
  const f = await updateFixture(t);
  await symlink('old', f.current);
  const fetchManifest = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (url.includes('artifact')) throw new Error('synthetic transport secret');
    return fetchManifest(url, init);
  });
  const result = await f.service.apply(f.body);
  assert.equal(result.state, 'failed');
  assert.match(result.lastError!, /artifact download failed/);
  assert.doesNotMatch(result.lastError!, /secret/);
  assert.equal((await new ConnectorUpdateService(f.config).status()).state, 'failed');
  assert.equal(await readlink(f.current), 'old');
  assert.equal((await f.service.check()).state, 'available', 'ownership was released');
});

for (const size of [-1, 256 * 1024 * 1024 + 1]) {
  test(`unusable declared artifact size ${size} fails before artifact fetch or release creation`, async t => {
    const f = await updateFixture(t);
    await symlink('old', f.current);
    const manifest = JSON.stringify({ releases: [{ version: '2.0.0', artifactUrl: 'https://example.test/artifact.tar', sha256: '0'.repeat(64), size }] });
    t.mock.method(globalThis, 'fetch', async (url: string) => {
      assert.ok(!url.includes('artifact'));
      return new Response(manifest);
    });
    const result = await f.service.apply({ ...f.body, manifestSha256: createHash('sha256').update(manifest).digest('hex') });
    assert.equal(result.state, 'failed');
    assert.equal(result.lastError, 'artifact download failed');
    assert.equal((await new ConnectorUpdateService(f.config).status()).state, 'failed');
    assert.equal(await readlink(f.current), 'old');
    await assert.rejects(lstat(f.release), { code: 'ENOENT' });
  });
}

for (const failure of ['size', 'read', 'http'] as const) {
  test(`artifact ${failure} failure cancels source, saves terminal state and releases ownership`, async t => {
    const f = await updateFixture(t);
    await symlink('old', f.current);
    const fetchManifest = globalThis.fetch;
    let cancelled = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(c) { c.error(new Error('synthetic stream secret')); },
      cancel() { cancelled++; return new Promise(() => {}); },
    }, { highWaterMark: 0 });
    t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      if (!url.includes('artifact')) return fetchManifest(url, init);
      return new Response(source, {
        status: failure === 'http' ? 503 : 200,
        headers: failure === 'size' ? { 'content-length': String(256 * 1024 * 1024 + 1) } : {},
      });
    });
    const result = await f.service.apply(f.body);
    assert.equal(result.state, 'failed');
    assert.equal(result.lastError, 'artifact download failed');
    assert.equal(cancelled, failure === 'read' ? 0 : 1);
    assert.equal(source.locked, false);
    assert.equal((await new ConnectorUpdateService(f.config).status()).state, 'failed');
    assert.equal(await readlink(f.current), 'old');
    await assert.rejects(lstat(f.release), { code: 'ENOENT' });
    assert.equal((await f.service.check()).state, 'available');
  });
}

test('malformed manifest does not expose body or modify saved state', async t => {
  const f = await updateFixture(t);
  const original = await readFile(f.stateFile, 'utf8');
  t.mock.method(globalThis, 'fetch', async () => new Response('{ synthetic secret'));
  await assert.rejects(f.service.check(), /^Error: invalid update manifest$/);
  assert.equal(await readFile(f.stateFile, 'utf8'), original);
});

test('manifest artifact size tightens streaming bound without buffering to global limit', async t => {
  const artifact = tar({ 'package.json': '{}', 'dist/index.js': 'new' });
  const f = await updateFixture(t, artifact);
  await symlink('old', f.current);
  const fetchManifest = globalThis.fetch;
  let cancelled = 0;
  let pulls = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(c) { if (pulls++ === 0) c.enqueue(Buffer.alloc(artifact.length + 1)); else c.close(); },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 });
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => url.includes('artifact') ? new Response(source) : fetchManifest(url, init));
  assert.equal((await f.service.apply(f.body)).state, 'failed');
  assert.equal(cancelled, 1);
  assert.equal(pulls, 1, 'stop as soon as declared size is exceeded');
  assert.equal(source.locked, false);
  assert.equal(await readlink(f.current), 'old');
  await assert.rejects(lstat(f.release), { code: 'ENOENT' });
});

for (const operation of ['check', 'apply', 'rollback'] as const) {
  for (const missing of [false, true]) {
    test(`disabled updater rejects ${operation} without touching ${missing ? 'missing' : 'existing'} state or installation`, async (t) => {
      const f = await updateFixture(t);
      await symlink('old', f.current);
      if (missing) await unlink(f.stateFile);
      const source = missing ? undefined : await readFile(f.stateFile, 'utf8');
      f.config.connector.updateEnabled = false;
      const disabled = new ConnectorUpdateService(f.config);
      t.mock.method(globalThis, 'fetch', async () => { assert.fail('disabled updater must not fetch'); });
      const before = await readdir(f.dir);
      await assert.rejects(operation === 'apply' ? disabled.apply(f.body) : disabled[operation](), /updates are disabled/);
      assert.deepEqual(await readdir(f.dir), before, 'disabled calls must not create lock/state/release files');
      assert.equal(await readlink(f.current), 'old');
      if (!missing) assert.equal(await readFile(f.stateFile, 'utf8'), source);
      assert.equal((await disabled.status()).supported, false);
      assert.deepEqual(await readdir(f.dir), before);
    });
  }
}

for (const point of ['before', 'after'] as const) {
  test(`disabled status preserves pending ${point} selection until explicitly re-enabled`, async (t) => {
    const f = await updateFixture(t);
    await symlink('old', f.current);
    terminateInstaller(f, point);
    const source = await readFile(f.stateFile, 'utf8');
    const inode = (await lstat(f.current)).ino;
    f.config.connector.updateEnabled = false;
    const status = await new ConnectorUpdateService(f.config).status();
    assert.equal(status.supported, false);
    assert.equal(status.state, 'installing');
    assert.equal('selection' in status, false);
    assert.equal(await readFile(f.stateFile, 'utf8'), source);
    assert.equal((await lstat(f.current)).ino, inode);
    f.config.connector.updateEnabled = true;
    assert.equal((await new ConnectorUpdateService(f.config).status()).state, point === 'after' ? 'succeeded' : 'failed');
    assert.equal((await lstat(f.current)).ino, inode);
  });
}

test('dangling update state link is preserved, not initialized', async (t) => {
  const f = await updateFixture(t);
  await unlink(f.stateFile);
  await symlink('missing-state', f.stateFile);
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('must not fetch'); });
  await assert.rejects(f.service.apply(f.body), /update state/);
  assert.equal(await readlink(f.stateFile), 'missing-state');
});

for (const callbackFails of [false, true]) test(`update lock close uncertainty ${callbackFails ? 'preserves original failure' : 'rejects clean completion'} and fences replacement`, async t => {
  const f = await updateFixture(t);
  const logs: Record<string, unknown>[] = [];
  const diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)));
  t.mock.method(performanceDiagnostics, 'start', diagnostics.start.bind(diagnostics));
  const original = new Error('original callback failure');
  let closes = 0, now = 0, callbacks = 0;
  const recovery = (ConnectorUpdateService as any).lockRecovery;
  t.mock.method(recovery, 'clock', () => now);
  // The runtime now owns SQLite in the worker. Fault injection must target
  // physical original worker exit, not a main-thread DatabaseSync mock that
  // silently cannot reach the actual owner.
  t.mock.method(ConnectorUpdateService as any, 'createLockOwner', () => {
    let exited = false;
    return { acquire: async () => {}, assertHeld: () => { if (exited) throw Error('owner lost'); },
      get exitConfirmed() { return exited; },
      retire() {
        closes++;
        if (closes === 1) throw new Error('synthetic lost physical exit acknowledgement');
        exited = true;
      }, waitForExit: async () => {} } satisfies OriginalUpdateLockOwner;
  });
  // Test cleanup retries only the exact original owner, never manually clears
  // a lock or authorizes closure based on elapsed time.
  t.after(async () => {
    now = 3000;
    await recovery.recover(f.stateFile + '.lock');
  });
  const run = (f.service as any).withMutationLock('maintenance', async () => {
    callbacks++;
    if (callbackFails) throw original;
    return 'completed';
  });
  await assert.rejects(run, callbackFails ? (error: unknown) => error === original : /lock owner unavailable/);
  const failedLock = logs.find(row => row.operation === 'update-mutation-lock');
  assert.equal(failedLock?.category, 'failed');
  assert.equal(failedLock?.unknown, 1);
  assert.equal(failedLock?.step, 3);
  assert.equal(failedLock?.records, 2);
  assert.equal(failedLock?.admitted, 1);
  assert.equal(failedLock?.settled, undefined);
  assert.equal(closes, 2, 'a failed close must not skip the other owner');
  const replacement = new ConnectorUpdateService(f.config);
  await assert.rejects(replacement.check(), /lock cleanup pending/);
  now = 1000;
  assert.equal((await replacement.status()).state, 'idle');
  assert.equal(closes, 5, 'one unresolved original close plus two new status lock closes');
  assert.equal(callbacks, 1, 'cleanup recovery cannot replay the original callback');
});

test('revoked authority after async original lock acquisition prevents update body and releases only original owners', async t => {
  const f = await updateFixture(t);
  const gate = admissionGate(); let authorized = true, bodies = 0, owners = 0, retires = 0;
  t.mock.method(ConnectorUpdateService as any, 'createLockOwner', () => {
    owners++; let exited = false;
    return { acquire: () => gate.promise, assertHeld: () => { if (exited) throw Error('owner lost'); },
      get exitConfirmed() { return exited; }, retire() { retires++; exited = true; }, waitForExit: async () => {} } satisfies OriginalUpdateLockOwner;
  });
  const pending = (f.service as any).withMutationLock('maintenance', async () => { bodies++; }, () => {
    if (!authorized) throw new UpdateAuthorizationError();
  });
  const rejected = assert.rejects(pending, UpdateAuthorizationError);
  while (!owners) await new Promise(resolve => setImmediate(resolve));
  authorized = false; gate.release(); await rejected;
  assert.equal(bodies, 0); assert.equal(owners, 1); assert.equal(retires, 1);
  assert.equal((await new ConnectorUpdateService(f.config).status()).state, 'idle');
});

test('original lock exit during deferred receipt admission cannot authorize stale writer or journal selection', async t => {
  const gate = admissionGate(), entered = admissionGate(); let enabled = false;
  const f = await commandFixture(t, undefined, async (_bytes, write) => {
    if (!enabled) return write();
    entered.release(); await gate.promise; return write();
  });
  const before = await readFile(f.stateFile, 'utf8');
  const owners: Array<{ exited: boolean }> = [];
  t.mock.method(ConnectorUpdateService as any, 'createLockOwner', () => {
    const state = { exited: false }; owners.push(state);
    return { acquire: async () => {}, assertHeld() { if (state.exited) throw Error('connector update lock owner unavailable'); },
      get exitConfirmed() { return state.exited; }, retire() { state.exited = true; }, waitForExit: async () => {} } satisfies OriginalUpdateLockOwner;
  });
  enabled = true;
  const pending = f.service.applyCommand('alice', { ...f.body, idempotencyKey: 'owner-exit' });
  const rejected = assert.rejects(pending, /lock owner unavailable/);
  await entered.promise; owners[0]!.exited = true; gate.release(); await rejected;
  assert.equal(await readFile(f.stateFile, 'utf8'), before);
  assert.equal(await readlink(f.current), 'old');
  assert.equal(f.receipts.get((f.service as any).commandScope('alice', 'apply'), 'owner-exit'), undefined);
});

test('Windows-folded update reservations prevent alias owners without folding the actual file path', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentopsdeck-update-key-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'State.Json');
  const config = loadConfig({ AOD_CONNECTOR_UPDATE_ENABLED: 'true', AOD_CONNECTOR_UPDATE_STATE_FILE: file });
  // Code-level Windows identity policy, not a native filesystem/ACL claim.
  t.mock.method(ConnectorUpdateService as any, 'lockPathKey', (value: string) => startupOwnerPathKey(value, 'win32'));
  const acquired = admissionGate(), release = admissionGate();
  const opened: string[] = []; let bodies = 0;
  t.mock.method(ConnectorUpdateService as any, 'createLockOwner', (value: string) => {
    opened.push(value); let exited = false;
    return { acquire: async () => {}, assertHeld() { if (exited) throw Error('owner lost'); },
      get exitConfirmed() { return exited; }, retire() { exited = true; }, waitForExit: async () => {} } satisfies OriginalUpdateLockOwner;
  });
  const run = (new ConnectorUpdateService(config) as any).withMutationLock('maintenance', async () => {
    bodies++; acquired.release(); await release.promise; return 'original';
  });
  t.after(async () => { release.release(); await run; });
  await acquired.promise;
  const alias = new ConnectorUpdateService({ ...config, connector: { ...config.connector, updateStateFile: path.join(root, 'STATE.JSON') } });
  await assert.rejects((alias as any).withMutationLock('maintenance', async () => { bodies++; }), /already in progress/);
  assert.deepEqual(opened, [path.join(await fsPromises.realpath(root), 'State.Json.lock')], 'SQLite receives the original case-sensitive filename');
  assert.equal(bodies, 1);
  release.release(); assert.equal(await run, 'original');
  assert.equal(await (alias as any).withMutationLock('maintenance', async () => 'replacement'), 'replacement');
  assert.equal(opened[1], path.join(await fsPromises.realpath(root), 'STATE.JSON.lock'));
});

async function updateFixture(t: import('node:test').TestContext, artifact = tar({ 'package.json': '{}', 'dist/index.js': 'new' })) {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentopsdeck-update-boundary-'));
  await mkdir(path.join(dir, 'old/dist'), { recursive: true });
  await writeFile(path.join(dir, 'old/package.json'), '{}');
  await writeFile(path.join(dir, 'old/dist/index.js'), 'old');
  const current = path.join(dir, 'current');
  const stateFile = path.join(dir, 'state.json');
  const config = loadConfig({ AOD_CONNECTOR_UPDATE_ENABLED: 'true', AOD_CONNECTOR_VERSION: '1.0.0', AOD_CONNECTOR_UPDATE_MANIFEST_URL: 'https://example.test/manifest.json', AOD_CONNECTOR_UPDATE_STATE_FILE: stateFile, AOD_CONNECTOR_INSTALL_ROOT: dir, AOD_CONNECTOR_CURRENT_SYMLINK: current });
  const manifest = JSON.stringify({ releases: [{ version: '2.0.0', artifactUrl: 'https://example.test/artifact.tar', sha256: createHash('sha256').update(artifact).digest('hex'), size: artifact.length }] });
  t.mock.method(globalThis, 'fetch', async (url: string) => new Response(url.includes('artifact') ? artifact : manifest));
  const service = new ConnectorUpdateService(config);
  // Bind fixture metadata to its prior selected path; no real binary or data compatibility is asserted.
  await writeFile(stateFile, JSON.stringify({ ...await service.status(), selectedRelease: { path: path.join(dir, 'old'), version: '1.0.0' } }));
  return { dir, current, stateFile, config, service, release: path.join(dir, 'releases/2.0.0-no-rev'), body: { version: '2.0.0', manifestSha256: createHash('sha256').update(manifest).digest('hex') } };
}

function tar(files: Record<string, string>, extra: Array<{ name: string; type: string }> = []) {
  const chunks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) add(name, '0', Buffer.from(content));
  for (const item of extra) add(item.name, item.type, Buffer.alloc(0));
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
  function add(name: string, type: string, data: Buffer) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100);
    h.write('0000777\0', 100, 8);
    h.write('0000000\0', 108, 8);
    h.write('0000000\0', 116, 8);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12);
    h.write('00000000000\0', 136, 12);
    h.fill(' ', 148, 156);
    h.write(type, 156, 1);
    h.write('ustar\0', 257, 6);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(h, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
}

function fixChecksum(buffer: Buffer) {
  buffer.fill(' ', 148, 156);
  let sum = 0;
  for (const b of buffer.subarray(0, 512)) sum += b;
  buffer.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
}
