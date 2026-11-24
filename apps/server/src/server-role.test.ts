import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig, redactedConfig } from './config.js';
import { shouldRegisterConnectorRoutes, shouldRegisterHubRoutes } from './server-role.js';

test('listener host remains unspecified unless explicitly configured', () => {
  assert.equal(loadConfig({}).listenHost, undefined);
  assert.equal(loadConfig({ AOD_LISTEN_HOST: '  ' }).listenHost, undefined);
});

test('listener accepts explicit IPv4 and IPv6 addresses without changing the requested port', () => {
  for (const address of ['127.0.0.1', '0.0.0.0', '::1', '::']) {
    const config = loadConfig({ AOD_LISTEN_HOST: ` ${address} `, PORT: '0' });
    assert.equal(config.listenHost, address);
    assert.equal(config.port, 0);
    assert.equal(redactedConfig(config).listenHost, address);
  }
});

test('listener rejects URLs, hostnames and malformed addresses before runtime construction', () => {
  for (const address of ['localhost', 'http://127.0.0.1', '127.0.0.1:8790', '[::1]', '127.0.0.999', '127.0.0.1\0']) {
    assert.throws(() => loadConfig({ AOD_LISTEN_HOST: address }), /AOD_LISTEN_HOST must be an IP address/);
  }
});

test('server role defaults to all-in-one and registers both Hub and Connector routes', () => {
  const config = loadConfig({} as NodeJS.ProcessEnv);
  assert.equal(config.serverRole, 'all');
  assert.equal(config.codex.defaultModel, '');
  assert.equal(shouldRegisterHubRoutes(config), true);
  assert.equal(shouldRegisterConnectorRoutes(config), true);
});

test('Codex default model remains configurable', () => {
  const config = loadConfig({ AOD_CODEX_DEFAULT_MODEL: 'gpt-5.6-terra' } as NodeJS.ProcessEnv);
  assert.equal(config.codex.defaultModel, 'gpt-5.6-terra');
});

test('hub-only role gates Connector routes and keeps split token redacted', () => {
  const config = loadConfig({
    AOD_SERVER_ROLE: 'hub',
    AOD_HUB_LOCAL_CONNECTOR_URL: 'http://127.0.0.1:8791/',
    AOD_HUB_LOCAL_CONNECTOR_TOKEN: 'hub-to-connector-secret',
  } as NodeJS.ProcessEnv);
  assert.equal(shouldRegisterHubRoutes(config), true);
  assert.equal(shouldRegisterConnectorRoutes(config), false);
  assert.equal(config.hub.localConnectorUrl, 'http://127.0.0.1:8791');
  const redacted = redactedConfig(config) as any;
  assert.equal(redacted.hub.localConnectorToken, 'hub-…cret');
  assert.equal(JSON.stringify(redacted).includes('hub-to-connector-secret'), false);
});


test('artifact receiver defaults include openclaw root direct-child artifact policy', () => {
  const config = loadConfig({ HOME: '/home/tester' } as NodeJS.ProcessEnv);
  assert.deepEqual(config.artifactReceiver.allowedDirectChildDirs, ['/home/tester/.openclaw']);
  assert.equal(config.artifactReceiver.directChildAllowedExtensions.includes('.xlsx'), true);
  assert.equal(config.artifactReceiver.directChildAllowedExtensions.includes('.json'), false);
  assert.equal(config.artifactReceiver.allowedDirs.includes('/home/tester/.openclaw'), false);
});

test('connector-only role gates Hub routes', () => {
  const config = loadConfig({ AOD_SERVER_ROLE: 'connector' } as NodeJS.ProcessEnv);
  assert.equal(shouldRegisterHubRoutes(config), false);
  assert.equal(shouldRegisterConnectorRoutes(config), true);
});
