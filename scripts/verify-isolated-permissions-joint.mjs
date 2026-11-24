// Disposable source-candidate acceptance: actual Hub, independent Connector and
// installed Codex. Default provider is synthetic; an explicit sealed-candidate
// mode can use an authorized real model through a credential-free loopback bridge.
// No live configuration, credentials, queues or sessions are opened by this runner.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runIsolatedSdkProbe, registerIsolatedProbeGroup } from './lib/isolated-sdk-probe.mjs';
import { sdkSourceImport } from './lib/sdk-source-import.mjs';
import { assertNoAdjacentJavaScript } from './source-shadow-guard.mjs';
import { verifyCandidateRelease } from './stage-candidate-release.mjs';
import { candidateJointModule, jointModelMessage, permissionsJointMode } from './lib/permissions-joint-mode.mjs';
import { openJointBrowsers } from './lib/permissions-joint-browser.mjs';
import { verifyJointWorkspace } from './lib/permissions-joint-workspace.mjs';
import { verifyJointRoles } from './lib/permissions-joint-roles.mjs';
import { verifyJointDiscovery } from './lib/permissions-joint-discovery.mjs';
import { jointImageBytes } from './lib/permissions-joint-image.mjs';
import { startJointReadRelay } from './lib/permissions-joint-relay.mjs';
import { verifyJointIssuerRecovery } from './lib/permissions-joint-issuer.mjs';
import { jointForwardingDiagnostic, jointForwardingLifecycle, jointForwardingObserver } from './lib/permissions-joint-forwarding.mjs';
import { jointCompletionEofFence } from './lib/permissions-joint-eof-fence.mjs';
import { verifyJointEmptyRestart } from './lib/permissions-joint-empty-restart.mjs';

const script = fileURLToPath(import.meta.url);
const mode = permissionsJointMode(process.argv.slice(2));
const { command } = mode;
const productionImport = specifier => mode.candidateRoot
  ? import(candidateJointModule(mode.candidateRoot, specifier)) : sdkSourceImport(specifier, import.meta.url);
if (!process.env.AOD_SDK_PROBE_WORKER) {
  if (mode.candidateRoot) await verifyCandidateRelease(mode.candidateRoot);
  else await assertNoAdjacentJavaScript(fileURLToPath(new URL('../apps/server/src', import.meta.url)));
  await runIsolatedSdkProbe(script, command, mode.realModel ? 900_000 : mode.browser ? 420_000 : 240_000, process.argv.slice(3), { retainEvidence: true });
} else if (process.env.AOD_PERMISSIONS_HOST === 'true') {
  // Registration happens before importing the production entrypoint. The parent
  // owns this host's lifetime; it also registers native detached process groups.
  process.on('disconnect', () => process.kill(process.pid, 'SIGTERM'));
  await productionImport('../apps/server/src/index.ts');
} else {
  await verify();
}

async function verify() {
  const root = process.env.AOD_SDK_PROBE_WORKER;
  const workspace = join(root, 'workspace'), native = join(root, 'native');
  const connectorData = join(root, 'connector'), hubData = join(root, 'hub');
  for (const directory of [workspace, native, connectorData, hubData]) await mkdir(directory);
  const secondNode = mode.candidateRoot ? { data: join(root, 'connector-two'), native: join(root, 'native-two'),
    workspace: join(root, 'workspace-two'), connectionId: 'isolated-codex-two' } : undefined;
  if (secondNode) for (const directory of [secondNode.data, secondNode.native, secondNode.workspace]) await mkdir(directory);
  const result = { passed: false, sourceCandidate: !mode.candidateRoot, realModel: mode.realModel,
    ...(mode.providerFixture ? { providerFixture: true } : {}),
    ...(mode.candidateRoot ? { candidate: await verifyCandidateRelease(mode.candidateRoot) } : {}),
    nativeRuntime: true, independentConnector: true, userInstanceTouched: false, checks: [], errors: [] };
  const hosts = [], nativeGroups = new Map(), streams = [];
  const forwarding = new Set(), upstreamControllers = new Set();
  const adminKey = randomBytes(32).toString('hex'), vault = randomBytes(32).toString('hex');
  let providerRequests = 0, imageRequests = 0, holdNext = false, held, connector, hub, providerFailure, seedOwner, browsers, readRelay;
  // A tiny valid fixture image, not a local user's file. The original bytes must
  // survive native admission/history/download; provider input must contain an image.
  const imageBytes = jointImageBytes();
  const image = { type: 'image', name: 'joint-private.png', mimeType: 'image/png', size: imageBytes.length,
    dataUrl: 'data:image/png;base64,' + imageBytes.toString('base64') };
  const provider = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/responses');
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; assert.ok(bytes < 2_000_000); chunks.push(chunk); }
      const requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      function hasImage(value) {
        return value && typeof value === 'object' && (value.type === 'input_image'
          || Object.values(value).some(hasImage));
      }
      if (hasImage(requestBody)) imageRequests++;
      assert.ok(++providerRequests <= 6, 'Native turns must remain bounded');
      const ordinal = providerRequests;
      const text = `JOINT_REPLY_${providerRequests}`;
      const respond = () => {
        if (mode.providerOrigin) {
          // Keep the original in-flight gate and request counter; never replace
          // upstream output with fixture text in real-model mode.
          const controller = new AbortController(); upstreamControllers.add(controller);
          const pending = (async () => {
            const observation = { ordinal, phase: 'connecting' };
            const protocol = jointForwardingObserver();
            const lifecycle = jointForwardingLifecycle(res);
            const eofFence = jointCompletionEofFence();
            const startedAt = performance.now();
            try {
              const upstream = await fetch(mode.providerOrigin + '/responses', { method: 'POST',
                headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks),
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]) });
              observation.status = upstream.status;
              assert.equal(upstream.status, 200, 'Real provider status');
              assert.ok(upstream.body, 'Real provider must return a response body');
              res.writeHead(200, { 'content-type': upstream.headers.get('content-type') ?? 'text/event-stream' });
              observation.phase = 'streaming';
              // Acceptance-only: withhold the original terminal bytes until
              // the original source really ends. Installed native clients may
              // stop at response.completed before HTTP EOF. This adapter does
              // not change production transport or forgive pipeline rejection.
              await pipeline(lifecycle.attachSource(Readable.fromWeb(upstream.body)), protocol.stream, eofFence.stream, res);
              assert.equal(protocol.observation.sourceEnded, true);
              assert.equal(protocol.observation.completedFrames, 1);
              assert.equal(protocol.observation.failedFrames + protocol.observation.incompleteFrames + protocol.observation.oversizedFrames, 0);
              assert.equal(eofFence.observation.sourceEnded, true);
              assert.equal(eofFence.observation.terminalReleased, true);
              assert.equal(lifecycle.observation.upstreamEnded, true);
              assert.equal(lifecycle.observation.downstreamFinished, true);
              observation.phase = 'complete';
              (result.providerStreams ??= []).push({ ordinal, ...protocol.observation, eofFence: eofFence.observation, transport: lifecycle.observation });
            } catch (error) {
              const diagnostic = jointForwardingDiagnostic(error, { ...observation,
                elapsedMs: Math.round(performance.now() - startedAt),
                responseDestroyed: res.destroyed, responseFinished: res.writableFinished });
              (result.providerFailures ??= []).push({ ...diagnostic, protocol: protocol.observation, eofFence: eofFence.observation, transport: lifecycle.observation });
              console.error(JSON.stringify({ providerForwardingFailure: diagnostic, protocol: protocol.observation, transport: lifecycle.observation }));
              providerFailure = new Error('Real provider forwarding failed; payload omitted');
              if (!res.headersSent) res.writeHead(502); res.end();
            } finally { lifecycle.dispose(); upstreamControllers.delete(controller); }
          })();
          forwarding.add(pending); void pending.then(() => forwarding.delete(pending), () => {
            forwarding.delete(pending); providerFailure = new Error('Real provider forwarding cleanup failed');
          });
          return;
        }
        const id = `joint-${providerRequests}`;
        const item = { id: `msg-${id}`, type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }] };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        event('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } });
        event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
        event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text });
        event('response.output_item.done', { output_index: 0, item });
        event('response.completed', { response: { id, object: 'response', status: 'completed', output: [item],
          usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } });
        res.end();
      };
      if (holdNext) { holdNext = false; held = respond; held.cancel = () => res.destroy(); } else respond();
    } catch {
      providerFailure = new Error('Isolated Responses provider contract failed');
      if (!res.headersSent) res.writeHead(500); res.end();
    }
  });
  const baseEnv = { ...process.env, AOD_PERMISSIONS_HOST: 'true',
    AOD_ACCESS_KEY: adminKey, AOD_HUB_VAULT_SECRET: vault,
    PORT: '0', AOD_LISTEN_HOST: '127.0.0.1', NODE_ENV: 'production',
    AOD_LOCAL_OPENCLAW_CLI: 'false', AOD_CONNECTOR_UPDATE_ENABLED: 'false',
    AOD_MEDIA_BRIDGE_ENABLED: 'false', AOD_MEDIA_LIBRARY_ENABLED: 'false',
    AOD_ARTIFACT_RECEIVER_ENABLED: 'false', AOD_ARTIFACT_CAPABILITY_INJECTION: 'false',
    AOD_ARTIFACT_GATEWAY_CLIENT_ENABLED: 'false', AOD_METRICS_ENABLED: 'false',
    AOD_CODEX_COMMAND: command, AOD_CODEX_HOME: native, CODEX_HOME: native,
    AOD_CODEX_DEFAULT_CWD: workspace, AOD_CODEX_DEFAULT_MODEL: mode.model ?? 'joint-audit',
    AOD_CODEX_MODEL_PROVIDER: 'joint_audit', AOD_CODEX_APPROVAL_POLICY: 'never',
    AOD_CONNECTOR_ENV_ID: 'isolated-codex', AOD_HUB_LOCAL_CONNECTION_ID: 'isolated-codex' };
  async function until(label, check, timeout = 30_000, allowProviderFailure = false) {
    const end = performance.now() + timeout;
    while (performance.now() < end) {
      if (providerFailure && !allowProviderFailure) throw providerFailure;
      const value = await check(); if (value) return value;
      await delay(100);
    }
    throw new Error(`Timeout: ${label}`);
  }
  async function heldRead(gate, label) {
    let timer;
    try {
      return await Promise.race([gate.held, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout: original ${label} read barrier`)), 15_000);
      })]);
    } finally { clearTimeout(timer); }
  }
  async function nativeIdentity(pid) {
    const text = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/);
    return { pid, parent: Number(fields[1]), group: Number(fields[2]), start: fields[19] };
  }
  async function registerNative(host) {
    for (const entry of await readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const value = await nativeIdentity(Number(entry)).catch(() => undefined);
      if (value?.parent === host.child.pid && value.group === value.pid && !nativeGroups.has(value.pid)) {
        await registerIsolatedProbeGroup(value.pid); nativeGroups.set(value.pid, value);
      }
    }
  }
  async function start(role, port = '0', node = undefined) {
    const data = node?.data ?? connectorData;
    const env = { ...baseEnv, PORT: port, AOD_SERVER_ROLE: role,
      AOD_CODEX_ENABLED: String(role === 'connector'),
      AOD_CONNECTOR_USERS_DATABASE_FILE: join(data, 'users.sqlite'),
      AOD_CONNECTOR_TOKENS_FILE: join(data, 'tokens.json'),
      ...(node ? { AOD_CODEX_HOME: node.native, CODEX_HOME: node.native, AOD_CODEX_DEFAULT_CWD: node.workspace,
        AOD_CONNECTOR_ENV_ID: node.connectionId, AOD_HUB_LOCAL_CONNECTION_ID: node.connectionId } : {}),
      AOD_HUB_DATABASE_FILE: join(hubData, 'hub.sqlite') };
    const child = spawn(process.execPath, [script, ...process.argv.slice(2)], { cwd: role === 'hub' ? hubData : data,
      env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const host = { child, role, output: '', exit: undefined, stderr: '', listener: undefined };
    hosts.push(host);
    child.on('error', () => { host.exit = { code: -1 }; });
    child.once('exit', (code, signal) => { host.exit = { code, signal }; });
    child.stdout.on('data', chunk => {
      const output = host.output + chunk;
      // Reopen can produce a large burst of maintenance diagnostics after the
      // ready line. Capture readiness before truncating the private log tail.
      host.listener ??= output.match(/AgentOpsDeck server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      host.output = output.slice(-8000);
    });
    // Diagnostics can include provider/native data; do not persist or print them.
    child.stderr.on('data', chunk => { host.stderr = (host.stderr + chunk).slice(-2000); });
    host.origin = await until(`${role} listener`, async () => {
      await registerNative(host);
      assert.equal(host.exit, undefined, `${role} exited before readiness`);
      return host.listener;
    });
    await registerNative(host);
    return host;
  }
  async function stop(host) {
    if (!host || host.exit) return;
    host.child.kill('SIGTERM');
    // A provider error must not short-circuit waiting for an already signalled
    // disposable host. Preserve the original failure while allowing real drain.
    await until(`${host.role} graceful stop`, () => host.exit, 30_000, true);
    assert.equal(host.exit.code, 0, `${host.role} stop must finish cleanly`);
  }
  async function api(actor, path, method = 'GET', body, expected = 200) {
    const response = await fetch(hub.origin + path, { method, signal: AbortSignal.timeout(15_000),
      headers: { ...(actor.cookie ? { cookie: `agentopsdeck_session=${actor.cookie}` } : { authorization: `Bearer ${actor.token}` }), origin: hub.origin,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    // Never embed upstream response text (or any credential) in assertions.
    assert.equal(response.status, expected, `${method} ${path}: expected ${expected}, got ${response.status}`);
    if (response.headers.get('content-type')?.includes('application/json')) return response.json();
    await response.body?.cancel();
  }
  const check = text => { result.checks.push(text); console.log(JSON.stringify({ check: text, passed: true })); };
  try {
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    await writeFile(join(native, 'config.toml'), `model = ${JSON.stringify(mode.model ?? 'joint-audit')}
model_provider = "joint_audit"
[model_providers.joint_audit]
name = "Isolated joint acceptance"
base_url = "http://127.0.0.1:${provider.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
`, { mode: 0o600 });
    if (secondNode) await writeFile(join(secondNode.native, 'config.toml'), await readFile(join(native, 'config.toml')), { mode: 0o600 });
    const { ConnectorTokenStore } = await productionImport('../apps/server/src/auth/connector-token.ts');
    const { ConnectorUserStore } = await productionImport('../apps/server/src/connector/connector-user-store.ts');
    const { HubStore } = await productionImport('../apps/server/src/hub/hub-store.ts');
    // Seed only while no service owns either isolated data volume.
    const users = new ConnectorUserStore(join(connectorData, 'users.sqlite'), () => true);
    const nodeId = users.nodeId; await users.close();
    const tokens = new ConnectorTokenStore(join(connectorData, 'tokens.json'), adminKey);
    const maintenance = tokens.create({ label: 'Isolated owner', scopes: ['agents:read', 'sessions:read', 'messages:read', 'media:read', 'events:read', 'models:read'] });
    const seed = new HubStore(join(hubData, 'hub.sqlite'), vault);
    seedOwner = seed;
    const owner = { userId: 'default', admin: false };
    const actors = ['Alice', 'Bob'].map(label => {
      const user = seed.createUser(`Joint ${label}`);
      const key = seed.identities.issueKey(user.id);
      const cookie = seed.identities.createSession(key.token);
      assert.ok(cookie);
      return { id: user.id, token: key.token, sessionCookie: cookie };
    });
    // Dedicated issuer is independent of the maintenance credential.
    // Seed all tokens before starting Connector, never edit its live token snapshot.
    const issuer = tokens.create({ label: 'Joint dedicated issuer', delegationHubId: seed.identities.hubId,
      scopes: ['execution:delegate', 'sessions:create', 'messages:read', 'messages:send'] });
    const replacementIssuer = tokens.create({ label: 'Joint replacement issuer', delegationHubId: seed.identities.hubId,
      scopes: ['execution:delegate', 'sessions:create', 'messages:read', 'messages:send'] });
    connector = await start('connector');
    readRelay = await startJointReadRelay(connector.origin);
    seed.upsertConnection({ id: 'isolated-codex', kind: 'remote', label: 'Isolated Connector',
      connectorUrl: readRelay.origin, credentialToken: maintenance.token, capabilities: ['sessions', 'messages', 'events'] });
    seed.pinConnectionNode('isolated-codex', 'default', seed.connectionAuthority('isolated-codex'), nodeId);
    await seed.executionIssuers.configure('default', 'isolated-codex', issuer.token, () => {});
    for (const actor of actors) {
      const target = { ownerUserId: 'default', connectionId: 'isolated-codex', userId: actor.id };
      const snapshot = seed.roles.snapshot(owner, target);
      seed.roles.save(owner, target, { role: 'developer', version: 0,
        nodeVersion: seed.connectionAuthority('isolated-codex'), environments: { codex: 'developer', openclaw: 'disabled' },
        migrateLegacy: true, grantSetDigest: snapshot.grantSetDigest });
    }
    if (secondNode) {
      const usersTwo = new ConnectorUserStore(join(secondNode.data, 'users.sqlite'), () => true);
      secondNode.nodeId = usersTwo.nodeId; await usersTwo.close();
      assert.notEqual(secondNode.nodeId, nodeId, 'Independent Connector identity');
      const tokensTwo = new ConnectorTokenStore(join(secondNode.data, 'tokens.json'), adminKey);
      const maintenanceTwo = tokensTwo.create({ label: 'Second isolated owner',
        scopes: ['agents:read', 'sessions:read', 'messages:read', 'events:read', 'models:read'] });
      const issuerTwo = tokensTwo.create({ label: 'Second dedicated issuer', delegationHubId: seed.identities.hubId,
        scopes: ['execution:delegate', 'sessions:create', 'messages:read', 'messages:send'] });
      secondNode.host = await start('connector', '0', secondNode);
      seed.upsertConnection({ id: secondNode.connectionId, kind: 'remote', label: 'Isolated Connector',
        connectorUrl: secondNode.host.origin, credentialToken: maintenanceTwo.token, capabilities: ['sessions', 'messages', 'events'] });
      seed.pinConnectionNode(secondNode.connectionId, 'default', seed.connectionAuthority(secondNode.connectionId), secondNode.nodeId);
      await seed.executionIssuers.configure('default', secondNode.connectionId, issuerTwo.token, () => {});
      for (const actor of actors) {
        const target = { ownerUserId: 'default', connectionId: secondNode.connectionId, userId: actor.id };
        const snapshot = seed.roles.snapshot(owner, target);
        seed.roles.save(owner, target, { role: 'developer', version: 0,
          nodeVersion: seed.connectionAuthority(secondNode.connectionId), environments: { codex: 'developer', openclaw: 'disabled' },
          migrateLegacy: true, grantSetDigest: snapshot.grantSetDigest });
      }
      result.independentConnectorCount = 2;
    }
    await seed.close(); seedOwner = undefined;
    hub = await start('hub');
    const administrator = { token: adminKey }, [alice, bob] = actors;
    const creationPath = '/api/hub/v1/shared/default/connections/isolated-codex/agents/codex/sessions';
    async function create(actor, label, base = creationPath) {
      const body = { label, idempotencyKey: `joint-create-${randomUUID()}` };
      const created = await api(actor, base, 'POST', body, 201);
      assert.equal((await api(actor, base, 'POST', body, 201)).key, created.key);
      assert.equal((await api(actor, base + '/creation-commands/' + body.idempotencyKey)).command.state, 'accepted');
      return { key: created.key, path: '/api/hub/v1/shared/default/sessions/' + encodeURIComponent(created.key), creation: body };
    }
    const first = await create(alice, 'Joint Alice'), second = await create(bob, 'Joint Bob');
    await api(alice, second.path + '/messages', 'GET', undefined, 404);
    await api(bob, first.path + '/messages', 'GET', undefined, 404);
    await api(bob, creationPath + '/creation-commands/' + first.creation.idempotencyKey, 'GET', undefined, 404);
    check('Two real native creations; exact ownership, idempotent original receipts, cross-user discovery/read denied');
    if (secondNode) {
      secondNode.creationPath = '/api/hub/v1/shared/default/connections/' + secondNode.connectionId + '/agents/codex/sessions';
      secondNode.session = await create(alice, 'Joint Alice', secondNode.creationPath);
      assert.notEqual(secondNode.session.key, first.key, 'Node-scoped session resource');
      await api(alice, secondNode.session.path + '/messages');
      await api(bob, secondNode.session.path + '/messages', 'GET', undefined, 404);
      await api(alice, creationPath + '/creation-commands/' + secondNode.session.creation.idempotencyKey, 'GET', undefined, 404);
      await api(alice, secondNode.creationPath + '/creation-commands/' + first.creation.idempotencyKey, 'GET', undefined, 404);
      const previousHost = secondNode.host, secondPort = new URL(previousHost.origin).port;
      await stop(previousHost); secondNode.host = await start('connector', secondPort, secondNode);
      assert.notEqual(previousHost.child.pid, secondNode.host.child.pid);
      assert.equal(hub.exit, undefined); assert.equal(connector.exit, undefined);
      await api(alice, secondNode.session.path + '/messages');
      await api(bob, secondNode.session.path + '/messages', 'GET', undefined, 404);
      assert.equal((await api(alice, secondNode.creationPath + '/creation-commands/' + secondNode.session.creation.idempotencyKey)).command.state, 'accepted');
      assert.equal(providerRequests, 0, 'Independent creation/restart must not manufacture model turns');
      check('Two actual Connector processes with independent identities/native homes, duplicate labels, exact node receipts and member isolation; replacing second node preserves first node and Hub');
    }
    connector = await verifyJointEmptyRestart({ connector, hub, secondHost: secondNode?.host,
      sessions: [{ actor: alice, foreign: bob, session: first }, { actor: bob, foreign: alice, session: second }],
      creationPath, api, stop, start, requestCount: () => providerRequests });
    result.emptySessionRecovery = { connectorReplaced: true, hubPreserved: true,
      originalReceiptsPreserved: true, ownershipPreserved: true, requestsBeforeFirstSend: providerRequests,
      firstSendCompleted: false };
    const shared = await api(alice, first.path + '/collaborators', 'POST',
      { userId: bob.id, role: 'collaborator', live: true, queue: true, media: true }, 201);
    const workspace = await verifyJointWorkspace({ api, alice, bob });
    check('Private workspace/card/board isolation despite active collaboration; exact machine task/field authority, retry receipt, human boundary, owner-only revoke and audit');
    if (mode.browser) {
      browsers = await openJointBrowsers({ config: mode.browser, origin: hub.origin, adminKey, actors: [alice, bob],
        onError: message => { result.errors.push(message); } });
      await browsers.denied(alice, second);
      check('Independent desktop/mobile UI logins, separate cookies and anonymous context; global management APIs denied to members');
      result.managementBrowser = await browsers.management(check);
    }
    async function send(actor, session, key = `joint-message-${randomUUID()}`, media = []) {
      const response = await fetch(hub.origin + session.path + '/messages', { method: 'POST', signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${actor.token}`, origin: hub.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ message: jointModelMessage(providerRequests + 1, mode.realModel), idempotencyKey: key,
          ...(media.length ? { media } : {}) }) });
      const body = await response.json();
      if (![200, 202].includes(response.status)) {
        result.failedAdmission = { status: response.status, commandState: body.command?.state,
          commandStatus: body.command?.result?.status, knownRejection: body.error === 'Command rejected' };
      }
      assert.ok([200, 202].includes(response.status), `Message acceptance status ${response.status}`);
      return { key, body };
    }
    async function reply(actor, session, text) {
      await until(`native reply ${text}`, async () => {
        const history = await api(actor, session.path + '/messages');
        return history.messages.some(message => message.role === 'assistant' && message.text.trim() === text);
      }, mode.realModel ? 180_000 : 45_000);
      await until('native terminal state', async () => {
        const state = await api(actor, session.path + '/state');
        return !state.hasActiveRun && state.runtime?.sync === 'current' && state.runtime?.phase === 'completed';
      });
    }
    const aliceMessage = browsers ? await browsers.chat(alice, first, jointModelMessage(1, mode.realModel)) : await send(alice, first);
    await reply(alice, first, 'JOINT_REPLY_1');
    if (browsers) await browsers.visible(alice, 'JOINT_REPLY_1');
    assert.equal(providerRequests, 1, 'First send after empty restart must produce exactly one native model request');
    assert.equal((await api(alice, creationPath + '/creation-commands/' + first.creation.idempotencyKey)).command.state, 'accepted');
    assert.equal((await api(alice, first.path + '/commands/' + aliceMessage.key)).command.state, 'accepted');
    await api(bob, first.path + '/commands/' + aliceMessage.key, 'GET', undefined, 404);
    result.emptySessionRecovery.firstSendCompleted = true;
    check('Empty-session Connector restart preserves original resource, creator and creation receipt; first actual send completes exactly once and foreign command receipt stays private');
    const bobMessage = browsers ? await browsers.chat(bob, first, jointModelMessage(2, mode.realModel), [image])
      : await send(bob, first, `joint-image-${randomUUID()}`, [image]);
    await reply(bob, first, 'JOINT_REPLY_2');
    await reply(alice, first, 'JOINT_REPLY_2');
    assert.ok(imageRequests > 0, 'Actual native provider request must include the submitted image');
    const attachmentMessage = await until('native attachment history', async () => {
      const history = await api(bob, first.path + '/messages');
      return history.messages.find(message => message.role === 'user' && message.media?.some(item => item.name === image.name));
    });
    const attachmentUrl = attachmentMessage.media.find(item => item.name === image.name).url;
    assert.ok(attachmentUrl.startsWith(first.path + '/messages/'), 'Attachment stays in exact shared-session resource');
    async function download(actor, status = 200, path = attachmentUrl) {
      const response = await fetch(hub.origin + path, { headers: { authorization: `Bearer ${actor.token}` }, signal: AbortSignal.timeout(15_000) });
      assert.equal(response.status, status, 'Exact attachment download status');
      if (status === 200) {
        assert.match(response.headers.get('content-type'), /^image\/png/);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), imageBytes, 'Original attachment bytes');
      } else await response.body?.cancel();
    }
    await download(alice); await download(bob);
    await download(bob, 404, attachmentUrl.replace(first.path, second.path));
    check('Shared original image bytes reach native provider and exact history/media download; creator and collaborator allowed, wrong-session resource denied');
    if (browsers) {
      for (const actor of [alice, bob]) await browsers.visible(actor, 'JOINT_REPLY_2');
      check('Actual desktop/mobile UI sends, original command receipts and rendered native replies on both independent cookie sessions');
    }
    await api(alice, first.path + '/commands/' + bobMessage.key, 'GET', undefined, 404);
    await api(bob, first.path + '/commands/' + aliceMessage.key, 'GET', undefined, 404);
    check(`Two member chat through production Hub/Connector/native chain; reply visibility and actor-owned receipts isolated (${mode.realModel ? 'real model' : 'synthetic provider'})`);
    await verifyJointDiscovery({ api, administrator, alice, bob, first, second, secondNode });
    check('Candidate HTTP discovery: exact grant pagination and foreign titles denied; received shares cannot fan out into owned catalog, usage, notifications, files or preferences; unconfigured research fails closed');
    const roles = await verifyJointRoles({ api, administrator: { token: adminKey }, alice, session: first, creationPath });
    check('Candidate HTTP role matrix: observer exact share, manager inherited read not execution, administrator boundaries, stale CAS, explicit legacy migration and none downgrade without grant resurrection');
    const hubPid = hub.child.pid, connectorPid = connector.child.pid, port = new URL(connector.origin).port;
    await stop(connector); connector = await start('connector', port);
    assert.notEqual(connector.child.pid, connectorPid); assert.equal(hub.child.pid, hubPid); assert.equal(hub.exit, undefined);
    assert.equal((await api(alice, creationPath + '/creation-commands/' + first.creation.idempotencyKey)).command.state, 'accepted');
    await reply(bob, first, 'JOINT_REPLY_2');
    await download(alice); await download(bob);
    assert.equal(providerRequests, 2, 'Restart must not replay any native message');
    check('Only Connector process replaced, Hub remains online; native history/creator/collaborator/original receipt persist, no replay');
    const streamAbort = new AbortController(); streams.push(streamAbort);
    const sse = await fetch(hub.origin + first.path + '/events/stream', {
      headers: { authorization: `Bearer ${bob.token}` }, signal: streamAbort.signal });
    assert.equal(sse.status, 200); const reader = sse.body.getReader();
    let streamEnded = false, streamFailure = false;
    const drained = (async () => { try { while (!(await reader.read()).done) {} streamEnded = true; } catch { streamFailure = true; streamEnded = true; } })();
    holdNext = true; await send(alice, first);
    await until('provider in flight', () => held);
    const queued = await send(bob, first);
    result.queueAdmission = { responseFields: Object.keys(queued.body), state: queued.body.command?.state,
      queued: queued.body.queued, status: queued.body.status };
    const ownedQueue = await api(bob, first.path + '/commands/' + queued.key + '/queue');
    assert.equal(ownedQueue.queue?.presence, 'present', 'Original command must be durably present in the native queue');
    assert.equal(ownedQueue.queue?.state, 'queued', 'Must exercise a queued command, not unknown delivery');
    await api(alice, first.path + '/commands/' + queued.key + '/queue', 'GET', undefined, 404);
    const collaborator = shared.grant ?? shared.collaborator;
    assert.ok(collaborator?.id && collaborator.version, 'Sharing route must return original grant/version');
    // Hold actual Connector response bodies, not synthetic denies or a mock
    // policy. History is still in flight; media has delivered only its public
    // PNG signature before the original collaborator is revoked below.
    const remoteKey = Buffer.from(first.key.slice(first.key.indexOf(':') + 1), 'base64url').toString('utf8');
    const connectorMessages = '/api/connector/v1/sessions/' + encodeURIComponent(remoteKey) + '/messages';
    const historyGate = readRelay.arm({ pathname: connectorMessages, query: { limit: '7' } });
    const readController = new AbortController(); streams.push(readController);
    const readSignal = AbortSignal.any([readController.signal, AbortSignal.timeout(45_000)]);
    const delayedHistory = fetch(hub.origin + first.path + '/messages?limit=7', {
      headers: { authorization: `Bearer ${bob.token}` }, signal: readSignal,
    }).then(async response => ({ status: response.status, text: await response.text() })).catch(() => ({ status: 0 }));
    assert.equal((await heldRead(historyGate, 'history')).status, 200, 'Original in-flight history response must be allowed upstream');
    const mediaGate = readRelay.arm({ pathname: connectorMessages + attachmentUrl.slice((first.path + '/messages').length), prefixBytes: 8 });
    const mediaResponse = await fetch(hub.origin + attachmentUrl, {
      headers: { authorization: `Bearer ${bob.token}` }, signal: readSignal,
    });
    assert.equal((await heldRead(mediaGate, 'media')).status, 200); assert.equal(mediaResponse.status, 200);
    const mediaReader = mediaResponse.body.getReader();
    const prefix = await mediaReader.read();
    assert.deepEqual(Buffer.from(prefix.value), imageBytes.subarray(0, 8), 'Only the PNG signature was delivered before revocation');
    const revoked = await api(alice, first.path + '/collaborators/' + collaborator.id, 'DELETE', { version: collaborator.version });
    assert.ok(['pending', 'confirmed'].includes(revoked.revocation?.state), 'Local revoke must expose remote confirmation state');
    result.revocationAtDelete = revoked.revocation;
    historyGate.release(); mediaGate.release();
    const historyAfterRevoke = await delayedHistory;
    // This request was admitted before revoke: its original pinned proof is
    // invalidated with 403. A new request below must instead be masked as 404.
    assert.equal(historyAfterRevoke.status, 403, 'Post-await authorization must reject the original history response');
    assert.ok(!historyAfterRevoke.text?.includes('JOINT_REPLY_'), 'Original private history body must not escape after revoke');
    let remainingMediaBytes = 0;
    try { for (;;) { const chunk = await mediaReader.read(); if (chunk.done) break; remainingMediaBytes += chunk.value.byteLength; } }
    catch { /* A revoked streaming body may fail rather than synthesize EOF. */ }
    finally { await mediaReader.cancel().catch(() => {}); mediaReader.releaseLock(); }
    assert.equal(remainingMediaBytes, 0, 'No remaining original attachment bytes may escape after revoke');
    result.inFlightRevocation = { originalHistoryStatus: 200, downstreamHistoryStatus: historyAfterRevoke.status,
      originalMediaStatus: 200, mediaBytesBeforeRevoke: prefix.value.byteLength, mediaBytesAfterRevoke: remainingMediaBytes };
    check('Actual Connector history body held across revoke is masked; original media stream stops after its pre-revoke PNG signature');
    const revocationPath = first.path + '/collaborators/' + collaborator.id + '/revocation?version=' + collaborator.version;
    await api(bob, revocationPath, 'GET', undefined, 404);
    for (const suffix of ['/messages', '/state', '/events/stream', '/queue',
      '/commands/' + queued.key, '/commands/' + queued.key + '/queue', '/messages/nonexistent/media/nonexistent']) {
      await api(bob, first.path + suffix, 'GET', undefined, 404);
    }
    await download(bob, 404); await download(alice);
    await api(bob, first.path + '/messages', 'POST', { message: 'Forbidden', idempotencyKey: 'revoked-post' }, 404);
    await until('existing SSE closes after revocation', () => streamEnded, 15_000); await drained;
    if (browsers) { await browsers.denied(bob, first); await browsers.revoked(bob); }
    assert.equal(streamFailure, false, 'Revocation must close SSE cleanly, not merely fail the connection');
    await until('exact original execution leases remotely revoke before queue release', async () => {
      const status = await api(alice, revocationPath);
      result.revocationBeforeRelease = status.revocation;
      return status.revocation?.state === 'confirmed' && status.revocation.pending === 0 && status.revocation.confirmed > 0;
    }, 20_000);
    held(); held = undefined;
    await reply(alice, first, 'JOINT_REPLY_3');
    await delay(1500); assert.equal(providerRequests, 3, 'Revoked queued message must not reach native provider');
    check('Live SSE closes; revoked history/state/send/own queue/receipt/media gate deny; original remote ACK confirmed before release; queued message never reaches native provider');
    await send(bob, second); await reply(bob, second, 'JOINT_REPLY_4');
    check('Unrelated member-owned session remains usable after collaboration revocation');
    const membershipPath = `/api/hub/v1/access/default/connections/isolated-codex/members/${alice.id}`;
    const membership = await api(administrator, membershipPath);
    await api(administrator, membershipPath, 'PUT', { role: 'none', version: membership.version, nodeVersion: membership.nodeVersion,
      environments: { codex: 'disabled', openclaw: 'disabled' }, migrateLegacy: false });
    for (const actor of [alice, bob]) await api(actor, first.path + '/messages', 'GET', undefined, 404);
    if (secondNode) await api(alice, secondNode.session.path + '/messages');
    await stop(connector); connector = await start('connector', port);
    for (const actor of [alice, bob]) await api(actor, first.path + '/messages', 'GET', undefined, 404);
    await reply(bob, second, 'JOINT_REPLY_4');
    assert.equal(providerRequests, 4);
    check('Parent environment revoke persists across independent Connector replacement; no grant restoration or queued-message replay');
    // Exercise global lifecycle through actual production HTTP and independent
    // owners, not live SQLite inspection or a replacement in-memory policy.
    const cookieActor = { cookie: bob.sessionCookie };
    const accessPath = `/api/hub/v1/users/${bob.id}/access`;
    const keysPath = `/api/hub/v1/users/${bob.id}/login-keys`;
    for (const actor of [bob, cookieActor]) assert.equal((await api(actor, '/api/hub/v1/me')).userId, bob.id);
    await api(bob, accessPath, 'PATCH', { status: 'disabled', expectedVersion: 0 }, 403);
    const adminAccess = (await api(administrator, '/api/hub/v1/users/default/access')).access;
    await api(administrator, '/api/hub/v1/users/default/access', 'PATCH',
      { status: 'disabled', expectedVersion: adminAccess.version }, 403);
    const before = (await api(administrator, accessPath)).access;
    const disabled = await api(administrator, accessPath, 'PATCH', { status: 'disabled', expectedVersion: before.version });
    assert.equal(disabled.access.status, 'disabled');
    assert.equal(disabled.access.version, before.version + 1);
    const deniedPaths = ['/api/hub/v1/me', '/api/hub/v1/shared/grants', '/api/hub/v1/connections',
      '/api/hub/v1/sessions/state', '/api/hub/v1/workspace/boards/default', second.path + '/messages',
      second.path + '/state', creationPath + '/creation-commands/' + second.creation.idempotencyKey];
    async function denyOldCredentials() {
      for (const actor of [bob, cookieActor]) for (const path of deniedPaths) await api(actor, path, 'GET', undefined, 401);
    }
    await denyOldCredentials();
    if (browsers) await browsers.disabled(bob);
    await api(administrator, keysPath, 'POST', undefined, 400);
    await api(administrator, accessPath, 'PATCH', { status: 'enabled', expectedVersion: before.version }, 409);
    assert.equal((await api(administrator, accessPath)).access.status, 'disabled');
    assert.equal((await api(alice, '/api/hub/v1/me')).userId, alice.id);
    check('Global disable rejects old Key and Cookie across discovery, workspace, history and original receipts; disabled issuance, stale CAS and administrator disable denied; independent identity survives');
    await stop(hub); hub = await start('hub', new URL(hub.origin).port);
    await denyOldCredentials();
    assert.equal((await api(administrator, accessPath)).access.version, disabled.access.version);
    const enabled = await api(administrator, accessPath, 'PATCH', { status: 'enabled', expectedVersion: disabled.access.version });
    assert.equal(enabled.access.status, 'enabled');
    assert.equal(enabled.access.version, disabled.access.version + 1);
    await denyOldCredentials();
    const keyList = await api(administrator, keysPath);
    assert.equal(keyList.keys.length, 0, 'Enable must not restore any old login Key');
    const issued = await api(administrator, keysPath, 'POST', undefined, 201);
    assert.ok(typeof issued.token === 'string' && issued.token.length > 0);
    const recovered = { id: bob.id, token: issued.token };
    if (browsers) await browsers.fresh(bob, issued.token);
    assert.equal((await api(recovered, '/api/hub/v1/me')).userId, bob.id);
    assert.equal((await api(recovered, '/api/hub/v1/shared/grants')).grants.length, 0);
    await api(recovered, second.path + '/messages', 'GET', undefined, 404);
    await api(recovered, first.path + '/messages', 'GET', undefined, 404);
    check('Physical Hub reopen preserves disabled epoch; enable requires fresh Key and cannot resurrect old credentials, creator grant or collaborator grant');
    await stop(hub); hub = await start('hub', new URL(hub.origin).port);
    await stop(connector); connector = await start('connector', port);
    await denyOldCredentials();
    assert.equal((await api(recovered, '/api/hub/v1/me')).userId, bob.id);
    assert.equal((await api(recovered, '/api/hub/v1/shared/grants')).grants.length, 0);
    for (const session of [first, second]) await api(recovered, session.path + '/messages', 'GET', undefined, 404);
    assert.equal((await api(alice, '/api/hub/v1/me')).userId, alice.id);
    assert.equal(providerRequests, 4, 'Lifecycle and independent process reopen must never replay native messages');
    await workspace.afterRestart(recovered);
    check('Private card/board ownership and revoked machine capability persist across account recovery and physical Hub/Connector reopen');
    await roles.afterRestart();
    check('Observer downgrade, explicit legacy none and read-only manager authority persist after physical Hub/Connector reopen');
    check('Fresh credential and revocation tombstones survive both process replacements; independent identity and original provider count preserved');
    if (browsers) {
      await browsers.disabled(bob);
      check('Real browser cookies stay revoked through global disable, Hub reopen, enable and fresh login; fresh account has no resurrected grants');
    }
    result.issuerRecovery = await verifyJointIssuerRecovery({ api, administrator, actor: recovered, create, send, reply,
      relay: readRelay, originalIssuer: issuer, replacementIssuer, nodeId, root, getHub: () => hub,
      replaceHub: value => { hub = value; }, stop, start, connector, providerCount: () => providerRequests, until, check });
    result.providerRequests = providerRequests; result.imageRequests = imageRequests; result.browser = Boolean(browsers); result.passed = result.errors.length === 0;
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    result.errors.push(String(error.message).slice(0, 500)); process.exitCode = 1;
    result.failureLocation = String(error.stack).split('\n').filter(line => line.includes('verify-isolated-permissions-joint.mjs:')).map(line => line.trim());
    console.error(JSON.stringify({ passed: false, error: result.errors.at(-1) }));
  } finally {
    try { await browsers?.close(); } catch { result.passed = false; result.errors.push('Browser cleanup failed'); process.exitCode = 1; }
    await seedOwner?.close();
    for (const controller of streams) controller.abort();
    await readRelay?.close();
    if (held) { if (mode.providerOrigin) held.cancel(); else held(); held = undefined; }
    for (const controller of upstreamControllers) controller.abort();
    await Promise.allSettled([...forwarding]);
    for (const host of hosts.toReversed()) {
      try { await stop(host); } catch {
        result.passed = false; result.errors.push(`${host.role} cleanup failed`); process.exitCode = 1;
        if (!host.exit) host.child.kill('SIGKILL');
      }
    }
    // Signal only registered, start-time matched groups generated by this test.
    for (const [pid, identity] of nativeGroups) {
      const current = await nativeIdentity(pid).catch(() => undefined);
      if (current?.start === identity.start && current.group === pid) {
        result.passed = false; result.errors.push('Native group did not drain gracefully'); process.exitCode = 1;
        try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    if (mode.candidateRoot) {
      try { assert.deepEqual(await verifyCandidateRelease(mode.candidateRoot), result.candidate); }
      catch { result.passed = false; result.errors.push('Sealed candidate changed during acceptance'); process.exitCode = 1; }
    }
    result.remainingScope = [...(mode.realModel ? [] : ['Real provider/model acceptance']), ...(mode.browser ? [] : ['Browser acceptance']), ...(!result.inFlightRevocation ? ['In-flight media/read revocation'] : []),
      ...(!result.issuerRecovery ? ['Sealed candidate old-issuer durable-ledger convergence'] : []),
      'Sealed candidate migration, stopped backup and rollback compatibility'];
    await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks.length, providerRequests,
      evidence: join(root, 'result.json'), realModel: mode.realModel }));
  }
}
