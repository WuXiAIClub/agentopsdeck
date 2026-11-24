import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatMessage } from '@agentopsdeck/shared';
import { originalApplicationAuthFixture } from './auth/application-transaction-test-fixture.js';
import { createApplicationTransactionClient, createApplicationTransactionLink } from './auth/application-transaction-gate.js';
import { createApplicationCommandScopes } from './auth/application-command-scope.js';
import { ConnectorTokenStore } from './auth/connector-token.js';
import { ConnectorUserStore } from './connector/connector-user-store.js';
import { createConnectorOwnerCommands } from './connector/connector-owner-domain.js';
import { AsyncOpenClawStatus } from './connector/async-openclaw-status.js';
import { AsyncSdkStatus } from './connector/async-sdk-status.js';
import { AsyncHermesLocalControl } from './connector/async-hermes-local-control.js';
import { createApplicationStatusIngress } from './application-status-ingress.js';
import { PerformanceDiagnostics } from './diagnostics/performance.js';

const runtimes = ['openclaw', 'hermes', 'claude-code', 'ghcp'] as const;
const silent = new PerformanceDiagnostics(() => {}), session = 's'.repeat(43), wait = { timeoutMs: 15_000 };
async function fixture(t: TestContext, runtime: typeof runtimes[number], role: 'hub' | 'standalone', mode: 'json' | 'sqlite') {
  const root = mkdtempSync(join(tmpdir(), 'application-status-')), link = createApplicationTransactionLink();
  const auth = originalApplicationAuthFixture(root, role, mode, 'original-application-key', silent, link.auth);
  link.connector.begin(); link.connector.data.ref();
  const client = createApplicationTransactionClient(link.connector.data);
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'), 'original-transport', silent);
  const authorization = 'Bearer original-transport', actor = tokens.authenticateAuthorization(authorization)!.tokenId;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const command = createConnectorOwnerCommands(store, tokens, undefined, undefined, undefined, false, undefined, client);
  const key = runtime === 'openclaw' ? 'agent:main:dashboard:original' : `${runtime}:original`;
  if (runtime === 'hermes') store.hermesJournal.save({ key, stored: 'original', title: 'Original', started: true, messages: [] });
  if (runtime === 'claude-code' || runtime === 'ghcp') (runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal)
    .create({ key, nativeSessionId: 'original', title: 'Original', createdAt: 1 });
  let allowed = true, failProjection = false, displays = 0;
  const projected = new Map<string, ChatMessage>();
  const project = (messages: [ChatMessage, ChatMessage]) => {
    projected.set(messages[0].id, messages[0]); if (failProjection) throw Error('isolated partial projection');
    projected.set(messages[1].id, messages[1]);
  };
  const display = () => ({ connected: true, gateway: 'connected', session: { model: `original-${++displays}` } });
  const openclaw = new AsyncOpenClawStatus({ owner: { command }, display: () => {
    const { gateway, session } = display(); return { gateway, session, connectionId: 'original' };
  }, project, diagnostics: silent });
  const sdk = new AsyncSdkStatus({ command }, display, project, silent);
  const hermes = new AsyncHermesLocalControl({ command }, display, project, silent);
  const commands = createApplicationCommandScopes({ authorize: () => allowed, assertAvailable() {}, diagnostics: silent });
  const participants = { openclaw, sdk, hermes }, ingress = createApplicationStatusIngress(commands, participants, { transactions: true });
  const scope = { key, commandKey: 'original-status', authorization };
  const request = () => new Request('http://application.invalid/', { headers: { cookie: `agentopsdeck_session=${session}` } });
  const send = (commandKey = scope.commandKey) => {
    const input = { ...scope, commandKey, payloadJson: '{"message":"/status"}' };
    return runtime === 'claude-code' || runtime === 'ghcp' ? ingress.sdk(request(), { ...input, runtime }, wait)
      : ingress[runtime](request(), input, wait);
  };
  const recover = () => commands.run(request(), { action: 'message', runtime, resource: key,
    commandKey: scope.commandKey, payloadDigest: '0'.repeat(64) }, authority => ingress.recoverPhysical(runtime, scope, authority));
  t.after(async () => {
    await commands.close(); await Promise.all([openclaw.close(), hermes.close()]);
    command.dispose(); store.close(); link.connector.data.close(); link.connector.confirmExit();
    await auth.closeForShutdown(); link.closeUnused(); rmSync(root, { recursive: true, force: true });
  });
  await auth.open(); await auth.issueSession(session);
  return { auth, store, scope, send, recover, projected, participants, command, request, commands,
    receipt: (commandKey = scope.commandKey) => store.commands.get(JSON.stringify([actor, key]), commandKey),
    allowed: (value: boolean) => { allowed = value; }, fail: (value: boolean) => { failProjection = value; }, displays: () => displays };
}

for (const runtime of runtimes) for (const role of ['hub', 'standalone'] as const) for (const mode of ['json', 'sqlite'] as const) {
  test(`${runtime}/${role}/${mode}: original status transaction, immutable recovery, partial projection and revocation`, { timeout: 30_000 }, async t => {
    const f = await fixture(t, runtime, role, mode);
    const first = await f.send(); assert.ok('report' in first && first.report && first.receipt?.state === 'accepted');
    const original = structuredClone(first); assert.equal(f.projected.size, 0, 'admission never projects unverified buffered reports');
    f.fail(true); await assert.rejects(f.recover()); assert.equal(f.projected.size, 1);
    f.fail(false); await f.recover(); assert.deepEqual([...f.projected.values()], first.report);
    assert.deepEqual(await f.send(), original, 'duplicate uses original immutable report, not current display');
    const displays = f.displays(); await f.recover(); assert.equal(f.displays(), displays);
    await f.auth.revokeSession(session);
    await assert.rejects(f.send('after-revoke')); assert.equal(f.receipt('after-revoke'), undefined);
    f.projected.clear(); f.allowed(false); await assert.rejects(f.recover()); assert.equal(f.projected.size, 0);
    assert.deepEqual(f.receipt(), first.receipt, 'logout cannot erase a committed report');
    assert.equal(f.store.turns.list(runtime, f.scope.key).length, 0, 'status/recovery never queues native work');
  });
}

test('status ingress rejects missing transaction pairing and caller-supplied evidence before invocation', async t => {
  const f = await fixture(t, 'claude-code', 'standalone', 'json');
  const input = { ...f.scope, runtime: 'claude-code' as const, payloadJson: '{"message":"/status"}' };
  const unpaired = createApplicationStatusIngress(f.commands, f.participants, { transactions: false });
  await assert.rejects(unpaired.sdk(f.request(), input, wait)); assert.equal(f.receipt(), undefined);
  const ingress = createApplicationStatusIngress(f.commands, f.participants, { transactions: true });
  await assert.rejects(ingress.sdk(f.request(), { ...input, application: { accessKey: 'forged' } }, wait));
  await assert.rejects(createApplicationStatusIngress(f.commands, {}, { transactions: true }).sdk(f.request(), input, wait));
  assert.equal(f.receipt(), undefined);
  // The validator accepts bounded evidence only on writes, not report reads.
  await assert.rejects(f.command('sdkMessageStatusRead', { ...f.scope, runtime: 'claude-code', application: {} } as never));
});
