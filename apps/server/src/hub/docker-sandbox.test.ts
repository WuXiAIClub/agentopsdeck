import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDockerSandboxCliCommand,
  buildDockerSandboxComposeYaml,
  buildDockerSandboxDockerfile,
  buildDockerSandboxRunArgs,
  DockerSandboxManager,
  normalizeDockerSandboxConfig,
  sanitizeDockerIdentifier,
  sanitizeDockerImage,
} from './docker-sandbox.js';

test('normalizeDockerSandboxConfig applies profile defaults and clamps resource bounds', () => {
  const isolated = normalizeDockerSandboxConfig({ profileId: 'isolated-test' });
  assert.equal(isolated.profileId, 'isolated-test');
  assert.equal(isolated.cpuLimit, 1);
  assert.equal(isolated.memoryLimitMb, 2048);
  assert.equal(isolated.ttlMinutes, 60);
  assert.equal(isolated.networkMode, 'bridge');
  assert.equal(isolated.readOnlyRootfs, false);
  assert.deepEqual(isolated.runtimes, ['codex']);

  const airgapped = normalizeDockerSandboxConfig({
    profileId: 'airgapped-review',
    cpuLimit: 99,
    memoryLimitMb: 128,
    ttlMinutes: 1,
  });
  assert.equal(airgapped.profileId, 'airgapped-review');
  assert.equal(airgapped.cpuLimit, 16);
  assert.equal(airgapped.memoryLimitMb, 512);
  assert.equal(airgapped.ttlMinutes, 5);
  assert.equal(airgapped.networkMode, 'none');
  assert.equal(airgapped.readOnlyRootfs, true);
});

test('sanitizeDockerIdentifier and sanitizeDockerImage reject unsafe shell tokens', () => {
  assert.equal(sanitizeDockerIdentifier(' my sandbox && rm ', 'sbx'), 'my-sandbox-rm');
  assert.equal(sanitizeDockerImage('agentopsdeck-connector:1.0.0'), 'agentopsdeck-connector:1.0.0');
  assert.equal(sanitizeDockerImage('bad image; whoami'), 'agentopsdeck-connector:1.0.0');
});

test('buildDockerSandboxRunArgs, CLI and Compose never embed plaintext secrets and enforce isolation flags', () => {
  const cfg = normalizeDockerSandboxConfig({
    name: 'Tenant Alpha',
    profileId: 'tenant-isolated',
    environmentId: 'tenant-alpha',
    hubUrl: 'https://deck.example.invalid',
    readOnlyRootfs: true,
    runtimes: ['codex', 'claude'],
  });
  const args = buildDockerSandboxRunArgs('agentopsdeck-tenant-alpha-01', cfg);
  assert.ok(args.includes('--cap-drop=ALL'));
  assert.ok(args.includes('no-new-privileges:true'));
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--cpus=2'));
  assert.ok(args.includes('--memory=4096m'));
  assert.ok(args.includes('AOD_HUB_TUNNEL=wss://deck.example.invalid/api/hub/v1/connector-tunnel'));
  assert.ok(args.includes('AOD_CONNECTOR_TOKEN'));
  assert.ok(args.includes('OPENAI_API_KEY'));

  const cli = buildDockerSandboxCliCommand('agentopsdeck-tenant-alpha-01', cfg);
  assert.match(cli, /^docker run -d --rm --name agentopsdeck-tenant-alpha-01/);
  assert.doesNotMatch(cli, /AOD_CONNECTOR_TOKEN=/);
  assert.doesNotMatch(cli, /OPENAI_API_KEY=/);

  const compose = buildDockerSandboxComposeYaml('agentopsdeck-tenant-alpha-01', cfg);
  assert.match(compose, /services:\n {2}agentopsdeck-tenant-alpha-01:/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop:\n {6}- ALL/);
  assert.match(compose, /AOD_CONNECTOR_TOKEN: "\$\{AOD_CONNECTOR_TOKEN:-\}"/);
});

test('DockerSandboxManager lifecycle creates, filters by owner, sweeps expired TTL and stops instances', async () => {
  const manager = new DockerSandboxManager();
  const sbxA = await manager.create({
    name: 'Alice Isolated Codex',
    profileId: 'isolated-test',
    ownerUserId: 'alice',
    environmentId: 'alice-sbx',
    ttlMinutes: 15,
  }, false);

  const sbxB = await manager.create({
    name: 'Bob Tenant Codex',
    profileId: 'tenant-isolated',
    ownerUserId: 'bob',
    environmentId: 'bob-sbx',
    ttlMinutes: 60,
  }, false);

  assert.equal(sbxA.status, 'simulated');
  assert.equal(sbxA.connectorUri.startsWith('reverse://alice-sbx/aod-alice-sbx-'), true);

  assert.equal(manager.list('alice', false).length, 1);
  assert.equal(manager.list('alice', false)[0]?.id, sbxA.id);
  assert.equal(manager.list('alice', true).length, 2);

  // Advance clock past sbxA expiration
  manager.sweepExpired(sbxA.expiresAt + 1000);
  assert.equal(manager.get(sbxA.id)?.status, 'expired');
  assert.equal(manager.get(sbxB.id)?.status, 'simulated');

  const stopped = await manager.stop(sbxB.id, false);
  assert.equal(stopped?.status, 'stopped');
  await manager.stop(sbxB.id, true);
  assert.equal(manager.get(sbxB.id), undefined);
});

import { Hono } from 'hono';
import { registerHubDockerSandboxes, isHubDockerSandboxRequest } from '../routes/hub-docker-sandboxes.js';

test('registerHubDockerSandboxes HTTP routes list, create and delete ephemeral sandboxes with owner isolation', async () => {
  assert.equal(isHubDockerSandboxRequest('GET', '/api/hub/v1/docker-sandboxes'), true);
  assert.equal(isHubDockerSandboxRequest('POST', '/api/hub/v1/docker-sandboxes'), true);
  assert.equal(isHubDockerSandboxRequest('DELETE', '/api/hub/v1/docker-sandboxes/sbx_123'), true);
  assert.equal(isHubDockerSandboxRequest('PUT', '/api/hub/v1/docker-sandboxes/sbx_123'), false);

  const manager = new DockerSandboxManager();
  let currentActor = { userId: 'alice', admin: false };
  const app = new Hono();
  registerHubDockerSandboxes(app, {
    manager,
    principal: () => currentActor,
  });

  const createRes = await app.request('https://deck.example.invalid/api/hub/v1/docker-sandboxes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Alice PR Review Sandbox',
      profileId: 'isolated-test',
      environmentId: 'pr-review',
      ttlMinutes: 30,
    }),
  });
  assert.equal(createRes.status, 201);
  const createdBody = (await createRes.json()) as { sandbox: { id: string; dockerRunCommand: string; ownerUserId: string } };
  assert.equal(createdBody.sandbox.ownerUserId, 'alice');
  assert.match(createdBody.sandbox.dockerRunCommand, /wss:\/\/deck\.example\.invalid\/api\/hub\/v1\/connector-tunnel/);

  // Non-owner bob cannot see or delete alice's sandbox
  currentActor = { userId: 'bob', admin: false };
  const bobListRes = await app.request('https://deck.example.invalid/api/hub/v1/docker-sandboxes');
  assert.equal(bobListRes.status, 200);
  const bobListBody = (await bobListRes.json()) as { sandboxes: unknown[] };
  assert.equal(bobListBody.sandboxes.length, 0);

  const bobDelRes = await app.request(`https://deck.example.invalid/api/hub/v1/docker-sandboxes/${createdBody.sandbox.id}`, {
    method: 'DELETE',
  });
  assert.equal(bobDelRes.status, 404);

  // Alice can delete her sandbox
  currentActor = { userId: 'alice', admin: false };
  const aliceDelRes = await app.request(`https://deck.example.invalid/api/hub/v1/docker-sandboxes/${createdBody.sandbox.id}?remove=1`, {
    method: 'DELETE',
  });
  assert.equal(aliceDelRes.status, 200);
});

test("Dockerfile generator, secretEnvKeys sanitizer, and lease renewal HTTP endpoint work end-to-end", async () => {
  const cfg = normalizeDockerSandboxConfig({
    name: "Audit Sandbox",
    profileId: "airgapped-review",
    workspaceTmpfsMb: 2048,
    pidsLimit: 320,
    runtimes: ["codex", "claude", "copilot"],
    secretEnvKeys: ["OPENAI_API_KEY", "bad-key;rm", "CUSTOM_VAULT_TOKEN"],
  });
  assert.equal(cfg.workspaceTmpfsMb, 2048);
  assert.equal(cfg.pidsLimit, 320);
  assert.ok(cfg.secretEnvKeys.includes("CUSTOM_VAULT_TOKEN"));
  assert.ok(!cfg.secretEnvKeys.includes("bad-key;rm"));

  const dockerfile = buildDockerSandboxDockerfile(cfg);
  assert.match(dockerfile, /FROM node:22-bookworm-slim AS runtime/);
  assert.match(dockerfile, /USER sandbox/);
  assert.match(dockerfile, /AOD_RUNTIMES="codex,claude,copilot"/);

  const manager = new DockerSandboxManager();
  const sbx = await manager.create({
    name: "Renewable Sandbox",
    profileId: "isolated-test",
    ownerUserId: "alice",
    ttlMinutes: 30,
  }, false);
  const origExp = sbx.expiresAt;
  const renewed = manager.renew(sbx.id, 60);
  assert.ok(renewed);
  assert.ok(renewed.expiresAt >= origExp + 59 * 60_000);
});
