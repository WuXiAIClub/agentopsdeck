import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { provisionMaintenanceToken } from './provision-maintenance-token.mjs';

async function fixture(context, request) {
  const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-maintenance-token-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return { origin: 'http://127.0.0.1:1', nodeId: 'node_fixture',
    file: join(directory, 'token'),
    label: 'fixture', accessKey: 'synthetic-operator', request };
}
test('issues only lifecycle and privately persists the bearer without returning it', async context => {
  const calls = [];
  const config = await fixture(context, async (_url, init) => {
    calls.push(init);
    return new Response(JSON.stringify(init.method === 'GET' ? { tokens: [] } : {
      token: 'aod_conn_synthetic', record: { id: 'tok_fixture', scopes: ['connector:lifecycle'] },
    }), { status: init.method === 'GET' ? 200 : 201 });
  });
  const result = await provisionMaintenanceToken(config);
  assert.deepEqual(result, { tokenId: 'tok_fixture', scopes: ['connector:lifecycle'], credentialStored: true });
  assert.deepEqual(JSON.parse(calls[1].body), { label: 'fixture', scopes: ['connector:lifecycle'] });
  assert.equal(await readFile(config.file, 'utf8'), 'aod_conn_synthetic\n');
  assert.equal((await stat(config.file)).mode & 0o777, 0o600);
  await assert.rejects(provisionMaintenanceToken(config), /EEXIST/);
  assert.equal(calls.length, 2);
});
test('ambiguous issuance is not retried or overwritten', async context => {
  let posts = 0;
  const config = await fixture(context, async (_url, init) => {
    if (init.method === 'GET') return new Response(JSON.stringify({ tokens: [] }));
    posts++; throw new Error('Synthetic disconnect');
  });
  await assert.rejects(provisionMaintenanceToken(config));
  await assert.rejects(provisionMaintenanceToken(config), /EEXIST/);
  assert.equal(posts, 1);
});
test('duplicate label and non-loopback endpoint cannot mint credentials', async context => {
  let calls = 0;
  const config = await fixture(context, async () => { calls++; return new Response(JSON.stringify({ tokens: [{ label: 'fixture' }] })); });
  await assert.rejects(provisionMaintenanceToken({ ...config, origin: 'http://10.0.0.1' }), /Invalid/);
  assert.equal(calls, 0);
  await assert.rejects(provisionMaintenanceToken(config), /reconcile/);
  assert.equal(calls, 1);
});
