import test from 'node:test';
import assert from 'node:assert/strict';
import type { HubConnection, HubUser } from '../api.js';
import {
  buildReverseConnectCommand,
  buildReverseConnectorUri,
  isReverseTunnelConnection,
  scoreConnectionHealth,
  summarizeConnectorTopology,
} from './connector-architecture.js';

const sampleConnections: HubConnection[] = [
  {
    id: 'local',
    kind: 'local',
    label: 'Local Hub Node',
    status: 'enabled',
    ownerUserId: 'default',
    environmentId: 'prod-cluster',
    environmentLabel: 'Production Cluster',
    capabilities: ['codex', 'terminal'],
  },
  {
    id: 'conn-nat-1',
    kind: 'remote',
    label: 'Edge Worker A',
    connectorUrl: 'reverse://prod-cluster/edge-worker-a',
    status: 'enabled',
    ownerUserId: 'default',
    environmentId: 'prod-cluster',
    environmentLabel: 'Production Cluster',
    hasCredential: true,
    capabilities: ['codex', 'reverse-tunnel'],
  },
  {
    id: 'conn-dev-1',
    kind: 'remote',
    label: 'Dev Box',
    connectorUrl: 'https://dev-box.example.invalid:8792',
    status: 'degraded',
    ownerUserId: 'alice',
    environmentId: 'dev-sandbox',
    environmentLabel: 'Dev Sandbox',
  },
];

const sampleUsers: HubUser[] = [
  { id: 'default', label: 'Fixture Admin', createdAt: 1, updatedAt: 1 },
  { id: 'alice', label: 'Alice Dev', createdAt: 1, updatedAt: 1 },
];

test('reverse tunnel helpers detect outbound NAT connections and generate safe CLI bootstrap commands', () => {
  assert.equal(isReverseTunnelConnection(sampleConnections[0]!), false);
  assert.equal(isReverseTunnelConnection(sampleConnections[1]!), true);
  const uri = buildReverseConnectorUri('prod cluster', 'worker 01');
  assert.equal(uri, 'reverse://prod-cluster/worker-01');

  const cmd = buildReverseConnectCommand({
    hubUrl: 'https://deck.example.invalid/',
    environmentId: 'prod-cluster',
    environmentLabel: 'Production Cluster',
    nodeLabel: 'Edge Worker A',
    heartbeatIntervalSec: 15,
    reconnectBackoffMaxSec: 45,
  });
  assert.match(cmd, /wss:\/\/deck\.example\.invalid\/api\/hub\/v1\/connector-tunnel/);
  assert.match(cmd, /--env-id "prod-cluster"/);
  assert.match(cmd, /--token-env AOD_CONNECTOR_TOKEN/);
  assert.doesNotMatch(cmd, /secret|Bearer/i);
});

test('summarizeConnectorTopology pools multi-user, multi-environment, and multi-connector failover groups', () => {
  const byEnv = summarizeConnectorTopology(sampleConnections, sampleUsers, 'environment');
  assert.equal(byEnv.totalConnections, 3);
  assert.equal(byEnv.connectedCount, 2);
  assert.equal(byEnv.degradedCount, 1);
  assert.equal(byEnv.reverseCount, 1);
  assert.equal(byEnv.uniqueOwners, 2);
  assert.equal(byEnv.uniqueEnvironments, 2);

  const prodPool = byEnv.groups.find(g => g.key === 'env:prod-cluster');
  assert.ok(prodPool);
  assert.equal(prodPool.total, 2);
  assert.equal(prodPool.primaryConnectionId, 'local');
  assert.deepEqual(prodPool.failoverConnectionIds, ['conn-nat-1']);
  assert.ok(prodPool.healthScore >= 90);

  const byOwner = summarizeConnectorTopology(sampleConnections, sampleUsers, 'owner');
  assert.equal(byOwner.groups.length, 2);
  assert.ok(byOwner.groups.some(g => g.label === 'Fixture Admin' && g.total === 2));
  assert.ok(byOwner.groups.some(g => g.label === 'Alice Dev' && g.total === 1));

  const byKind = summarizeConnectorTopology(sampleConnections, sampleUsers, 'kind');
  assert.equal(byKind.groups.length, 3);
  assert.ok(scoreConnectionHealth(sampleConnections[0]!) > scoreConnectionHealth(sampleConnections[2]!));
});

import { buildDockerSandboxBlueprint, DOCKER_SANDBOX_PRESETS, sanitizeSecretEnvKeyList } from './connector-architecture.js';

test('buildDockerSandboxBlueprint generates hardened isolated Docker + Codex CLI and Compose specs without secret leaks', () => {
  assert.equal(DOCKER_SANDBOX_PRESETS.length, 3);
  const blueprint = buildDockerSandboxBlueprint({
    hubUrl: 'https://deck.example.invalid/',
    environmentId: 'tenant-beta',
    nodeLabel: 'codex-worker-1',
    profileId: 'tenant-isolated',
    readOnlyRootfs: true,
  });

  assert.equal(blueprint.containerName, 'aod-sbx-tenant-beta-codex-worker-1');
  assert.equal(blueprint.connectorUri, 'reverse://tenant-beta/aod-sbx-tenant-beta-codex-worker-1');
  assert.equal(blueprint.cpuLimit, 2);
  assert.equal(blueprint.memoryLimitMb, 4096);
  assert.equal(blueprint.readOnlyRootfs, true);
  assert.match(blueprint.dockerRunCommand, /--cap-drop=ALL/);
  assert.match(blueprint.dockerRunCommand, /--read-only/);
  assert.match(blueprint.dockerRunCommand, /AOD_HUB_TUNNEL="wss:\/\/deck\.example\.invalid\/api\/hub\/v1\/connector-tunnel"/);
  assert.doesNotMatch(blueprint.dockerRunCommand, /AOD_CONNECTOR_TOKEN=/);
  assert.match(blueprint.dockerComposeYaml, /services:\n {2}aod-sbx-tenant-beta-codex-worker-1:/);
});

test("buildDockerSandboxBlueprint supports custom tmpfs, runtimes, Dockerfile snippet, and secret key sanitization", () => {
  const keys = sanitizeSecretEnvKeyList(["OPENAI_API_KEY", "bad key!", "GH_TOKEN"]);
  assert.ok(keys.includes("OPENAI_API_KEY"));
  assert.ok(keys.includes("GH_TOKEN"));
  assert.ok(!keys.includes("bad key!"));

  const bp = buildDockerSandboxBlueprint({
    hubUrl: "https://deck.example.invalid",
    environmentId: "sec-audit",
    nodeLabel: "node-9",
    profileId: "airgapped-review",
    workspaceTmpfsMb: 2048,
    pidsLimit: 128,
    runtimes: ["codex", "copilot"],
    secretEnvKeys: ["GH_TOKEN"],
  });
  assert.equal(bp.workspaceTmpfsMb, 2048);
  assert.equal(bp.pidsLimit, 128);
  assert.deepEqual(bp.runtimes, ["codex", "copilot"]);
  assert.match(bp.dockerRunCommand, /size=2048m/);
  assert.match(bp.dockerRunCommand, /-e GH_TOKEN/);
  assert.match(bp.dockerfileSnippet, /FROM node:22-bookworm-slim/);
});
