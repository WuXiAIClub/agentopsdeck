import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { createConnectorRuntime } from './runtime.js';

test('local website sockets need their own switch plus exact configured paths; maintenance never inherits connect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-sockets-runtime-'));
  try {
    for (const enabled of [false, true]) for (const configured of [false, true]) {
      const file = join(root, `${enabled}-${configured}`);
      const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'connector',
        AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false',
        AOD_SESSION_TITLES_FILE: `${file}.titles`, AOD_CONNECTOR_USERS_DATABASE_FILE: `${file}.sqlite`,
        AOD_CONNECTOR_TOKENS_FILE: `${file}.tokens`, AOD_QUEUE_FILE: `${file}.queue`,
        AOD_MIRROR_OUTBOX_FILE: `${file}.mirror`, AOD_ARTIFACT_INDEX_FILE: `${file}.artifacts`,
        AOD_CONNECTOR_UPDATE_STATE_FILE: `${file}.updates`,
        AOD_WEBSITES_LOCAL_BROWSE: 'true', AOD_WEBSITES_LOCAL_CONNECT: String(enabled),
        AOD_WEBSITES_JSON: JSON.stringify([{ id: 'test', label: 'Test', url: 'http://127.0.0.1:3000/', browse: true,
          ...(configured ? { sockets: [{ path: '/hmr', protocols: [] }] } : {}) }]),
      });
      const runtime = createConnectorRuntime(config, () => false);
      try {
        const open = (token: string) => runtime.app.request(`/api/connector/v1/website-access/${'a'.repeat(43)}/sockets`, {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ path: '/hmr', protocols: [] }) });
        // Scope passes only with both opt-ins; the deliberately missing parent then yields 404, never native I/O.
        assert.equal((await open(runtime.localToken)).status, enabled && configured ? 404 : 403);
        assert.equal((await open(runtime.localMaintenanceToken)).status, 403);
      } finally { await runtime.close(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('local websites require both explicit opt-in and catalog without broadening maintenance credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-website-runtime-'));
  try {
    for (const enabled of [false, true]) for (const catalog of [false, true]) {
      const file = join(root, `${enabled}-${catalog}`);
      const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'connector',
        AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false',
        AOD_SESSION_TITLES_FILE: `${file}.titles`, AOD_CONNECTOR_USERS_DATABASE_FILE: `${file}.sqlite`,
        AOD_CONNECTOR_TOKENS_FILE: `${file}.tokens`, AOD_QUEUE_FILE: `${file}.queue`,
        AOD_MIRROR_OUTBOX_FILE: `${file}.mirror`, AOD_ARTIFACT_INDEX_FILE: `${file}.artifacts`,
        AOD_CONNECTOR_UPDATE_STATE_FILE: `${file}.updates`,
        AOD_WEBSITES_LOCAL_ACCESS: String(enabled),
        AOD_WEBSITES_JSON: JSON.stringify(catalog ? [{ id: 'test', label: 'Test site', url: 'http://127.0.0.1:3000/' }] : []),
      });
      const runtime = createConnectorRuntime(config, () => false);
      try {
        const read = (token: string) => runtime.app.request('/api/connector/v1/websites/catalog', { headers: { authorization: `Bearer ${token}` } });
        assert.equal((await read(runtime.localToken)).status, !catalog ? 409 : enabled ? 200 : 403);
        assert.equal((await read(runtime.localMaintenanceToken)).status, catalog ? 403 : 409);
      } finally { await runtime.close(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('local browsing requires its own switch and a browse-enabled catalog; maintenance never inherits it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-browse-runtime-'));
  try {
    for (const enabled of [false, true]) for (const catalog of ['none', 'snapshot', 'browse']) {
      const file = join(root, `${enabled}-${catalog}`);
      const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'connector',
        AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false',
        AOD_SESSION_TITLES_FILE: `${file}.titles`, AOD_CONNECTOR_USERS_DATABASE_FILE: `${file}.sqlite`,
        AOD_CONNECTOR_TOKENS_FILE: `${file}.tokens`, AOD_QUEUE_FILE: `${file}.queue`,
        AOD_MIRROR_OUTBOX_FILE: `${file}.mirror`, AOD_ARTIFACT_INDEX_FILE: `${file}.artifacts`,
        AOD_CONNECTOR_UPDATE_STATE_FILE: `${file}.updates`,
        AOD_WEBSITES_LOCAL_ACCESS: 'true', AOD_WEBSITES_LOCAL_BROWSE: String(enabled),
        AOD_WEBSITES_JSON: JSON.stringify(catalog === 'none' ? [] : [{ id: 'test', label: 'Test site', url: 'http://127.0.0.1:3000/', browse: catalog === 'browse' }]),
      });
      const runtime = createConnectorRuntime(config, () => false);
      try {
        const open = (token: string) => runtime.app.request('/api/connector/v1/website-access', {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ serviceId: 'test' }),
        });
        assert.equal((await open(runtime.localToken)).status, enabled && catalog === 'browse' ? 200 : 403);
        assert.equal((await open(runtime.localMaintenanceToken)).status, 403);
      } finally { await runtime.close(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
