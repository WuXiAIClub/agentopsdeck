import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectorCapabilities } from '@agentopsdeck/shared';
import { loadConfig } from '../config.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { createAsyncConnectorSurface } from './async-connector-surface.js';
import { validConnectorAuthorityOutput } from './connector-authority-domain.js';
import { validLocalCredentialsOutput } from './local-credentials-domain.js';
import { LOCAL_CREDENTIAL_IDENTITIES } from './local-credential-plan.js';
import { normalizeConnectorUrl } from '../hub/hub-store.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';

test('new token-create contract accepts only the AOD issuance namespace and exact entropy shape', () => {
  const record = { id: 'synthetic', label: 'Synthetic', scopes: ['sessions:read'], createdAt: 1 };
  const value = (prefix: string, suffix = 'x'.repeat(32)) => ({ record, token: prefix + suffix });
  assert.equal(validConnectorAuthorityOutput('tokenCreate', value('aod_conn_')), true);
  assert.equal(validConnectorAuthorityOutput('tokenCreate', value('aod_conn_', '_-'.repeat(16))), true);
  for (const prefix of [['cp', 'conn', ''].join('_'), 'aod_local_', 'aod_conn']) assert.equal(validConnectorAuthorityOutput('tokenCreate', value(prefix)), false);
  for (const suffix of ['x'.repeat(31), 'x'.repeat(33), '+'.repeat(32), 'x'.repeat(31) + '\n']) assert.equal(validConnectorAuthorityOutput('tokenCreate', value('aod_conn_', suffix)), false);
});

test('local credential output accepts only exact AOD transient tokens', () => {
  const value = (prefix: string, suffix = 'x'.repeat(43)) => ({
    leaseId: '12345678-1234-4123-8123-123456789abc',
    credentials: (['daily', 'maintenance'] as const).map(role => ({
      role, identity: LOCAL_CREDENTIAL_IDENTITIES[role], scopes: ['sessions:read'], token: prefix + suffix,
    })),
  });
  assert.equal(validLocalCredentialsOutput('localCredentialsCreate', value('aod_local_')), true);
  assert.equal(validLocalCredentialsOutput('localCredentialsCreate', value('aod_local_', '_-'.repeat(21) + '_')), true);
  for (const prefix of [['cp', 'local', ''].join('_'), 'aod_conn_', 'aod_local'])
    assert.equal(validLocalCredentialsOutput('localCredentialsCreate', value(prefix)), false);
  for (const suffix of ['x'.repeat(42), 'x'.repeat(44), '+'.repeat(43), 'x'.repeat(42) + '\n'])
    assert.equal(validLocalCredentialsOutput('localCredentialsCreate', value('aod_local_', suffix)), false);
});

test('local connector normalization uses the new identity and rejects predecessor URLs', () => {
  assert.equal(normalizeConnectorUrl('local://aod-connector'), 'local://aod-connector');
  assert.equal(normalizeConnectorUrl('  local://aod-connector  '), 'local://aod-connector');
  assert.equal(normalizeConnectorUrl(['local://', 'claw', 'connector'].join('')), undefined);
  assert.equal(normalizeConnectorUrl('local://aod-connector/'), undefined);
});

test('historical authentication remains hash-bound without accepting predecessor issuance output or rewriting stored secrets', context => {
  const root = mkdtempSync(join(tmpdir(), 'aod-historical-auth-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'tokens.json');
  const historical = ['cp', 'conn', ''].join('_') + 'x'.repeat(32);
  new ConnectorTokenStore(file, historical);
  const persisted = readFileSync(file, 'utf8');
  assert.equal(persisted.includes(historical), false);
  const reopened = new ConnectorTokenStore(file);
  const request = (token: string) => new Request('http://synthetic.invalid/', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(reopened.requireScope(request(historical), 'sessions:read')?.tokenId, 'tok_bootstrap');
  assert.equal(reopened.requireScope(request('aod_conn_' + 'x'.repeat(32)), 'sessions:read'), undefined);
  assert.equal(readFileSync(file, 'utf8'), persisted);
  const issued = reopened.create({ label: 'Synthetic new issuance', scopes: ['sessions:read'] });
  assert.equal(validConnectorAuthorityOutput('tokenCreate', issued), true);
  assert.equal(validConnectorAuthorityOutput('tokenCreate', { ...issued, token: historical }), false);
  reopened.revoke('tok_bootstrap');
  assert.equal(new ConnectorTokenStore(file).requireScope(request(historical), 'sessions:read'), undefined);
});

test('private synthetic async surface advertises the shared AOD service contract without native work', async context => {
  const root = mkdtempSync(join(tmpdir(), 'aod-connector-namespace-'));
  const diagnostics = new PerformanceDiagnostics(() => {});
  const owner = new AsyncConnectorOwner({ file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json'), bootstrapToken: 'synthetic-namespace', codexBoardTools: false }, diagnostics);
  let surface: Awaited<ReturnType<typeof createAsyncConnectorSurface>> | undefined, nativeCalls = 0;
  context.after(async () => { try { await surface?.close(); } finally { try { await owner.close(); } finally { rmSync(root, { recursive: true, force: true }); } } });
  await owner.open();
  const refreshSessions = async () => {};
  surface = await createAsyncConnectorSurface({
    owner, diagnostics, connector: { environmentId: 'synthetic', environmentLabel: 'Synthetic' },
    config: { ...loadConfig({ AOD_SERVER_ROLE: 'connector', AOD_CONNECTOR_UPDATE_STATE_FILE: join(root, 'update.json') }),
      sessionTitlesFile: join(root, 'titles.json'), sessionThinkingOverridesFile: join(root, 'thinking.json'), hiddenSessionsFile: join(root, 'hidden.json'),
      archivedSessionsFile: join(root, 'archived.json'), pinnedSessionsFile: join(root, 'pinned.json') },
    sampler: { sample: async () => { throw Error('No sampling expected'); }, close: async () => {} },
    bind: ({ snapshot }) => ({ refreshSessions, agents: () => [], close: async () => {}, runtimes: {
      codex: { native: { enabled: false, command: 'must-not-launch', defaultCwd: root, defaultModel: 'default', approvalPolicy: 'never' } }, sdk: {},
      hermes: { config: { enabled: false, executable: join(root, 'absent-python'), sourceDirectory: root, homeDirectory: root, workspace: root, startupTimeoutMs: 1000 }, executionAvailable: () => false, queueChanged: () => {} },
      openclaw: {
        history: { snapshot, refresh: async () => {}, historyReady: () => true, invalidate: () => {}, close: async () => {} }, invalidateDiscovery: () => {},
        dispatch: { gateway: { connectionId: () => 'synthetic', prepareWriteConnection: async () => 'synthetic', requestBound: async () => { nativeCalls++; throw Error('Native work forbidden'); } },
          native: { available: () => false, epoch: () => 'synthetic' }, allowCliFallback: false, message: text => text },
        recovery: { connectionId: () => 'synthetic', query: async () => ({ status: 'timeout' }) }, refreshSessions, refreshMessages: async () => {},
        nativeSession: () => undefined, defaultAgentId: 'synthetic', admissionAvailable: () => false, gatewayStatus: () => 'disconnected', retryMs: 10_000,
      },
    } }),
  });
  await surface.start();
  const issued = await owner.command('tokenCreate', { label: 'Synthetic namespace', scopes: ['sessions:read'] });
  assert.equal(validConnectorAuthorityOutput('tokenCreate', issued), true);
  assert.equal((await owner.command('tokenAuthenticate', { authorization: `Bearer ${issued.token}` }))?.tokenId, issued.record.id);
  assert.equal(await owner.command('tokenHasScope', { tokenId: issued.record.id, scope: 'messages:send' }), false);
  for (const path of ['/info', '/capabilities']) {
    const response = await surface.app.request(`/api/connector/v1${path}`, { headers: { authorization: 'Bearer synthetic-namespace' } });
    assert.equal(response.status, 200);
    const value = await response.json();
    const service: ConnectorCapabilities['connector']['service'] = path === '/info' ? value.service : value.connector.service;
    assert.equal(service, 'aod-connector');
  }
  assert.equal(nativeCalls, 0);
});
