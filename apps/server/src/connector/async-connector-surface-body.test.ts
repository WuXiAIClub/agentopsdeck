import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AOD_MODEL_SET_ID } from '@agentopsdeck/shared';
import { loadConfig } from '../config.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { createAsyncConnectorSurface } from './async-connector-surface.js';

async function fixture(t: TestContext, aliases: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'aod-surface-body-'));
  const diagnostics = new PerformanceDiagnostics(() => {});
  const owner = new AsyncConnectorOwner({ file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json'),
    bootstrapToken: 'synthetic-surface', codexBoardTools: false }, diagnostics);
  await owner.open();
  const config = loadConfig({ HOME: root, AOD_DATA_DIR: root, AOD_SERVER_ROLE: 'connector', AOD_OPENCLAW_HOME: root,
    AOD_OPENCLAW_CONFIG_FILE: join(root, 'openclaw.json'), AOD_CONNECTOR_UPDATE_STATE_FILE: join(root, 'update.json'),
    ...(aliases.length ? { AOD_OPENCLAW_MODEL_ALIASES: aliases.join(',') } : {}) });
  writeFileSync(config.nativeFileRoots.configFile, '{}');
  const surface = await createAsyncConnectorSurface({ owner, config, diagnostics,
    connector: { environmentId: 'fixture', environmentLabel: 'Fixture' },
    sampler: { sample: async () => assert.fail('No machine sampling'), close: async () => {} },
    bind: ({ snapshot }) => ({
      refreshSessions: async () => {}, agents: () => [], close: async () => {},
      runtimes: {
        codex: { native: { enabled: false, command: 'must-not-launch', defaultCwd: root, defaultModel: '', approvalPolicy: 'never' } },
        sdk: {}, hermes: { config: { enabled: false, executable: join(root, 'absent-python'), sourceDirectory: root,
          homeDirectory: root, workspace: root, startupTimeoutMs: 1000 }, executionAvailable: () => false, queueChanged: () => {} },
        openclaw: {
          history: { snapshot, refresh: async () => assert.fail('No history'), historyReady: () => true, invalidate: () => {}, close: async () => {} },
          invalidateDiscovery: () => {},
          dispatch: { gateway: { connectionId: () => 'fixture', prepareWriteConnection: async () => 'fixture',
            requestBound: async () => assert.fail('No native effect') },
            native: { available: () => true, epoch: () => 'fixture' }, allowCliFallback: false, message: text => text },
          recovery: { connectionId: () => 'fixture', query: async () => ({ status: 'timeout' }) },
          refreshSessions: async () => {}, refreshMessages: async () => assert.fail('No history'), nativeSession: () => undefined,
          defaultAgentId: 'main', admissionAvailable: () => true, gatewayStatus: () => 'connected', retryMs: 10000,
        },
      },
    }),
  });
  t.after(async () => { try { await surface.close(); } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); } });
  await surface.start();
  const credential = await owner.command('tokenCreate', { label: 'Fixture model operator', scopes: ['models:write'] });
  const controller = new AbortController(), before = readFileSync(config.nativeFileRoots.configFile);
  return { controller, owner, credential, root,
    unchanged: () => assert.deepEqual(readFileSync(config.nativeFileRoots.configFile), before),
    send(body: BodyInit | null, authorized = true) {
      return Promise.resolve(surface.app.fetch(new Request('http://test/api/connector/v1/gateway/model-set/reconcile', {
        method: 'POST', body, signal: controller.signal, duplex: 'half',
        headers: { 'content-type': 'application/json', 'content-length': '1',
          ...(authorized ? { authorization: `Bearer ${credential.token}` } : {}) },
      } as RequestInit)));
    },
  };
}

for (const body of ['{', 'null', '[]', '{}', JSON.stringify({ setId: AOD_MODEL_SET_ID, aliases: [] }), ' '.repeat(8193)]) {
  test(`async model reconcile: malformed/object/actual byte checks (${body.length} bytes) preserve config`, async t => {
    const f = await fixture(t), response = await f.send(body);
    assert.equal(response.status, body.length > 8192 ? 413 : 400); f.unchanged();
  });
}
test('async model reconcile: exact 8KiB dry-run succeeds without config writes', async t => {
  const f = await fixture(t), prefix = JSON.stringify({ setId: AOD_MODEL_SET_ID, dryRun: true });
  const response = await f.send(prefix + ' '.repeat(8192 - Buffer.byteLength(prefix)));
  assert.equal(response.status, 200); assert.equal((await response.json()).ok, true); f.unchanged();
});
test('async model reconcile: denied admission does not consume the body', async t => {
  const f = await fixture(t); let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({ pull() { pulls++; assert.fail('Denied body consumed'); } }, { highWaterMark: 0 });
  assert.equal((await f.send(stream, false)).status, 403); assert.equal(pulls, 0); f.unchanged();
});
for (const stop of ['abort', 'timeout'] as const) {
  test(`async model reconcile: ${stop} cancels stalled reading without awaiting source cancel ACK`, async t => {
    const f = await fixture(t); let enter!: () => void, cancelled = 0;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const stream = new ReadableStream<Uint8Array>({ pull() { enter(); }, cancel() { cancelled++; return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
    if (stop === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
    const flight = f.send(stream); await entered;
    if (stop === 'abort') f.controller.abort(); else t.mock.timers.tick(10000);
    assert.equal((await flight).status, 408); assert.equal(cancelled, 1); f.unchanged();
  });
}

for (const loss of ['revoke', 'abort'] as const) {
  test(`async model reconcile: mid-reconcile ${loss} before rename prevents config replacement and cleans temporary artifacts`, async t => {
    const f = await fixture(t, ['synthetic-provider/model-one']);
    const realCopyFile = fsPromises.copyFile;
    let intercepted = false;
    t.mock.method(fsPromises, 'copyFile', async (...args: Parameters<typeof fsPromises.copyFile>) => {
      const result = await realCopyFile(...args);
      if (!intercepted) {
        intercepted = true;
        if (loss === 'revoke') {
          assert.equal(await f.owner.command('tokenRevoke', { tokenId: f.credential.record.id }), true);
        } else {
          f.controller.abort();
        }
      }
      return result;
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const response = await f.send(JSON.stringify({ setId: AOD_MODEL_SET_ID }));
    assert.equal(intercepted, true);
    assert.equal(response.status, loss === 'revoke' ? 403 : 408);
    f.unchanged();
    const leftovers = readdirSync(f.root).filter(name => name.includes('.agentopsdeck-backup-') || name.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  });
}
