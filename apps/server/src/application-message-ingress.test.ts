import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplicationMessageIngress } from './application-message-ingress.js';
import { createApplicationCommandScopes, type ApplicationCommandIntent } from './auth/application-command-scope.js';
import { ConnectorTokenStore } from './auth/connector-token.js';
import { AsyncCodexMessages } from './connector/async-codex-messages.js';
import { AsyncOpenClawMessages } from './connector/async-openclaw-messages.js';
import { AsyncSdkMessages } from './connector/async-sdk-messages.js';
import { AsyncHermesMessages } from './connector/async-hermes-messages.js';
import { ConnectorUserStore } from './connector/connector-user-store.js';
import { createConnectorOwnerCommands } from './connector/connector-owner-domain.js';
import { NativeOperationError } from './connector/native-operation.js';
import { PerformanceDiagnostics } from './diagnostics/performance.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const wait = { timeoutMs: 10_000 };
const silent = new PerformanceDiagnostics(() => {});
const unknown = (error: unknown) => error instanceof NativeOperationError && error.outcome === 'unknown';
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
type Runtime = 'codex' | 'openclaw' | 'claude-code' | 'ghcp' | 'hermes';
type Command = ConstructorParameters<typeof AsyncSdkMessages>[0]['command'];

function fixture(runtime: Runtime) {
  const root = mkdtempSync(join(tmpdir(), 'original-message-ingress-'));
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'), 'isolated-original-connector-authority', silent);
  const authorization = 'Bearer isolated-original-connector-authority';
  const actor = tokens.authenticateAuthorization(authorization)!.tokenId;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const command = createConnectorOwnerCommands(store, tokens, { 'claude-code': { model: 'default' }, ghcp: { model: 'default' } });
  const key = runtime === 'openclaw' ? 'agent:main:original-message' : `${runtime}:original-message`;
  if (runtime === 'hermes') store.hermesJournal.save({ key, stored: 'native-original', title: 'Original', started: false, messages: [] });
  if (runtime === 'claude-code' || runtime === 'ghcp') (runtime === 'claude-code' ? store.claudeJournal : store.copilotJournal)
    .create({ key, nativeSessionId: 'native-original', title: 'Original', createdAt: 0 });
  const scope = JSON.stringify([actor, key]), controller = new AbortController();
  const request = new Request('http://application.invalid/', { headers: { 'x-agentopsdeck-key': 'original-application-key' }, signal: controller.signal });
  const input = { key, authorization, commandKey: 'original-message', payloadJson: '{"message":"original text"}' };
  const hooks: {
    before?: (kind: string) => Promise<void>;
    after?: (kind: string) => Promise<void>;
    authorize?: (check: number, request: Request) => Promise<void>;
    persist?: () => Promise<void>;
    notify?: () => Promise<void>;
  } = {};
  const seen: string[] = [], intents: ApplicationCommandIntent[] = [];
  let allowed = true, available = true, checks = 0, effects = 0, notices = 0;
  const commands = createApplicationCommandScopes({ diagnostics: silent,
    assertAvailable() { if (!available) throw Error('unavailable'); },
    async authorize(original) { checks++; await hooks.authorize?.(checks, original); return allowed; },
  });
  const owner = { command: (async (kind, value) => {
    seen.push(kind); await hooks.before?.(kind);
    const result = await command(kind, value); await hooks.after?.(kind); return result;
  }) as Command };
  const admitted = async () => { notices++; await hooks.notify?.(); };
  const options = { owner, defaultAgentId: 'main', ready: () => true, sessionExists: () => true, displayBlocked: () => false,
    admitted, diagnostics: silent, persist: async () => { effects++; await hooks.persist?.(); return []; } };
  const codex = new AsyncCodexMessages(options), openclaw = new AsyncOpenClawMessages(options);
  const sdk = new AsyncSdkMessages(owner, admitted, silent), hermes = new AsyncHermesMessages(owner, admitted, silent);
  const ingress = createApplicationMessageIngress({ run(original, intent, task) {
    intents.push(intent); return commands.run(original, intent, task);
  } }, { codex, openclaw, sdk, hermes });
  const messages = runtime === 'codex' ? codex : runtime === 'openclaw' ? openclaw : runtime === 'hermes' ? hermes : sdk;
  const send = (value = input, options: { timeoutMs: number; signal?: AbortSignal } = wait) => runtime === 'claude-code' || runtime === 'ghcp'
    ? ingress.sdk(request, { ...value, runtime }, options) : ingress[runtime](request, value, options);
  const read = () => runtime === 'claude-code' || runtime === 'ghcp'
    ? sdk.readSendReceipt({ runtime, key, authorization, commandKey: input.commandKey }, wait)
    : (runtime === 'codex' ? codex : runtime === 'openclaw' ? openclaw : hermes)
      .readSendReceipt({ key, authorization, commandKey: input.commandKey }, wait);
  return { store, tokens, actor, input, request, controller, hooks, commands, messages, seen, intents, send, read,
    receipt: () => store.commands.get(scope, input.commandKey),
    queued: () => store.turns.list(runtime, key).length,
    counts: () => ({ checks, effects, notices }),
    disallow: () => { allowed = false; }, unavailable: () => { available = false; },
    close: async () => { await commands.close(); await Promise.all([codex.close(), openclaw.close(), sdk.close(), hermes.close()]);
      command.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

for (const runtime of ['codex', 'openclaw', 'claude-code', 'ghcp', 'hermes'] as const) {
  for (const cancelled of [false, true]) test(`${runtime}: ${cancelled ? 'cancelled' : 'expired'} HTTP wait retains application scope through original commit ACK, notification and retirement`, async () => {
    const f = fixture(runtime), ack = gate(), committed = gate(), notification = gate();
    const mutation = runtime === 'codex' ? 'codexMessageCommit' : runtime === 'openclaw' ? 'openClawMessageCommit'
      : runtime === 'hermes' ? 'hermesMessageSend' : 'sdkMessageSend';
    const waiter = new AbortController();
    f.hooks.after = async kind => { if (kind === mutation) { committed.release(); await ack.promise; } };
    f.hooks.notify = () => notification.promise;
    try {
      const sending = f.send(f.input, { timeoutMs: cancelled ? 10_000 : 10, signal: waiter.signal });
      const rejected = assert.rejects(sending, unknown);
      await committed.promise;
      if (cancelled) waiter.abort();
      await rejected;
      assert.equal(f.commands.pending, 1); assert.equal(f.queued(), 1);
      assert.equal(f.receipt()?.state, 'accepted'); assert.equal(f.counts().notices, 0);
      f.disallow(); f.controller.abort();
      let closed = false;
      const closing = Promise.all([f.commands.close(), f.messages.close()]).then(() => { closed = true; });
      await tick(); assert.equal(closed, false);
      ack.release(); await tick();
      assert.equal(f.counts().notices, 1, 'an original committed ACK still notifies after cancellation and close');
      assert.equal(f.commands.pending, 1); assert.equal(closed, false);
      notification.release(); await closing;
      assert.equal(f.commands.pending, 0); assert.equal(f.queued(), 1);
      assert.equal(f.counts().notices, 1);
      if (runtime === 'codex' || runtime === 'openclaw') assert.ok(f.seen.at(-1)?.endsWith('Release'));
    } finally { ack.release(); notification.release(); await f.close(); }
  });

  test(`${runtime}: original input and intent are fixed before application identity I/O, and recovery never submits another mutation`, async () => {
    const f = fixture(runtime), auth = gate(), entered = gate();
    f.hooks.authorize = async (check, original) => {
      assert.equal(original.headers.get('x-agentopsdeck-key'), 'original-application-key');
      if (check === 1) { entered.release(); await auth.promise; }
    };
    try {
      const original = structuredClone(f.input), sending = f.send(original);
      await entered.promise;
      original.key = 'foreign'; original.authorization = 'Bearer foreign'; original.commandKey = 'foreign'; original.payloadJson = '{}';
      f.request.headers.set('x-agentopsdeck-key', 'replaced-application-key');
      auth.release();
      const result = await sending;
      assert.ok('receipt' in result && result.receipt?.state === 'accepted');
      assert.equal(f.queued(), 1); assert.equal(f.counts().notices, 1);
      assert.equal(f.intents[0]?.resource, f.input.key);
      assert.equal(f.intents[0]?.payloadDigest, createHash('sha256').update(f.input.payloadJson).digest('hex'));
      const writes = f.seen.length;
      const recovered = await f.read();
      assert.ok('receipt' in recovered); assert.deepEqual(recovered.receipt, result.receipt);
      assert.equal(f.seen.length, writes + 1); assert.ok(f.seen.at(-1)?.endsWith('SendReceiptRead'));
      assert.equal(f.counts().notices, 1); assert.equal(f.commands.pending, 0);
    } finally { auth.release(); await f.close(); }
  });

  test(`${runtime}: a lost original committed ACK is recovered by receipt read without notification or resubmission`, async () => {
    const f = fixture(runtime);
    const mutation = runtime === 'codex' ? 'codexMessageCommit' : runtime === 'openclaw' ? 'openClawMessageCommit'
      : runtime === 'hermes' ? 'hermesMessageSend' : 'sdkMessageSend';
    f.hooks.after = async kind => { if (kind === mutation) throw Error('isolated lost committed ACK'); };
    try {
      await assert.rejects(f.send(), unknown);
      assert.equal(f.queued(), 1); assert.equal(f.receipt()?.state, 'accepted');
      assert.equal(f.counts().notices, 0); assert.equal(f.commands.pending, 0);
      const writes = f.seen.length, recovered = await f.read();
      assert.ok('receipt' in recovered && recovered.receipt?.state === 'accepted');
      assert.equal(f.seen.length, writes + 1); assert.ok(f.seen.at(-1)?.endsWith('SendReceiptRead'));
      assert.equal(f.queued(), 1); assert.equal(f.counts().notices, 0);
      assert.equal(f.seen.filter(kind => kind === mutation).length, 1);
    } finally { await f.close(); }
  });

  for (const stop of ['revoke', 'cancel', 'close', 'binding'] as const) test(`${runtime}: ${stop} during application recheck prevents original SQL admission`, async () => {
    const f = fixture(runtime), auth = gate(), entered = gate();
    f.hooks.authorize = async check => { if (check === 2) { entered.release(); await auth.promise; } };
    try {
      const sending = f.send(), rejected = assert.rejects(sending, unknown);
      await entered.promise;
      if (stop === 'revoke') f.disallow();
      else if (stop === 'cancel') f.controller.abort();
      else if (stop === 'binding') f.unavailable();
      else void f.commands.close();
      assert.equal(f.commands.pending, 1);
      auth.release(); await rejected;
      assert.equal(f.queued(), 0); assert.equal(f.receipt(), undefined);
      assert.deepEqual(f.seen, []); assert.equal(f.counts().effects, 0); assert.equal(f.counts().notices, 0);
      assert.equal(f.commands.pending, 0);
    } finally { auth.release(); await f.close(); }
  });

  test(`${runtime}: application identity cannot substitute for missing or revoked original Connector authority`, async () => {
    const f = fixture(runtime);
    try {
      const missing = await f.send({ ...f.input, authorization: 'Bearer unknown-original-authority' });
      assert.deepEqual(missing, { error: 401 });
      f.tokens.revoke(f.actor);
      assert.deepEqual(await f.send(), { error: 401 });
      assert.equal(f.queued(), 0); assert.equal(f.counts().notices, 0); assert.equal(f.counts().effects, 0);
      assert.equal(f.commands.pending, 0);
    } finally { await f.close(); }
  });

  test(`${runtime}: application denial and already-aborted waiter never reach the Connector owner`, async () => {
    const f = fixture(runtime), aborted = new AbortController(); aborted.abort();
    try {
      await assert.rejects(f.send(f.input, { timeoutMs: 100, signal: aborted.signal }), error =>
        error instanceof NativeOperationError && error.outcome === 'not_started');
      assert.equal(f.counts().checks, 0);
      f.disallow(); await assert.rejects(f.send(), unknown);
      assert.deepEqual(f.seen, []); assert.equal(f.commands.pending, 0); assert.equal(f.queued(), 0);
    } finally { await f.close(); }
  });

  if (runtime === 'codex' || runtime === 'openclaw') {
    for (const boundary of ['claim', 'file'] as const) test(`${runtime}: revoke during ${boundary} I/O prevents further effects, retains unknown receipt and retires original intent`, async () => {
      const f = fixture(runtime), io = gate(), entered = gate();
      if (boundary === 'claim') f.hooks.after = async kind => { if (kind.endsWith('Claim')) { entered.release(); await io.promise; } };
      else f.hooks.persist = async () => { entered.release(); await io.promise; };
      try {
        const sending = f.send(), rejected = assert.rejects(sending, unknown);
        await entered.promise; f.disallow(); io.release(); await rejected;
        assert.equal(f.receipt()?.state, 'outcome_unknown'); assert.equal(f.queued(), 0); assert.equal(f.counts().notices, 0);
        assert.equal(f.counts().effects, boundary === 'file' ? 1 : 0);
        assert.ok(f.seen.at(-1)?.endsWith('Release'));
        assert.equal(f.seen.some(kind => kind.endsWith('Commit')), false);
        const writes = f.seen.length, recovered = await f.read();
        assert.ok('receipt' in recovered && recovered.receipt?.state === 'outcome_unknown');
        assert.equal(f.seen.length, writes + 1); assert.equal(f.queued(), 0);
      } finally { io.release(); await f.close(); }
    });
  }
}

test('fixed ingress captures original participants and rejects input getters without invoking them', async () => {
  const commands = createApplicationCommandScopes({ authorize: () => true, assertAvailable() {}, diagnostics: silent });
  let gets = 0, replacements = 0;
  const participant = { async sendPhysical() { return { error: 403 as const }; } };
  const ingress = createApplicationMessageIngress(commands, { hermes: participant });
  participant.sendPhysical = async () => { replacements++; return { error: 403 }; };
  const request = new Request('http://application.invalid/');
  const input = { key: 'hermes:original', authorization: 'Bearer original', commandKey: 'original', payloadJson: '{"message":"original"}' };
  try {
    await assert.rejects(ingress.hermes(request, { ...input, get payloadJson() { gets++; return '{}'; } }, wait));
    assert.equal(gets, 0); assert.equal(commands.pending, 0);
    assert.deepEqual(await ingress.hermes(request, input, wait), { error: 403 }); assert.equal(replacements, 0);
    await assert.rejects(ingress.codex(request, input, wait)); assert.equal(commands.pending, 0);
  } finally { await commands.close(); }
});

for (const runtime of ['codex', 'openclaw', 'hermes', 'claude-code', 'ghcp'] as const)
test(`linked ${runtime} ingress pins raw original credentials, not a caller-supplied application grant`, async () => {
  const entered = gate(), observed = gate(); let received: unknown, checks = 0;
  const request = new Request('http://application.invalid/', { headers: {
    'x-agentopsdeck-key': 'original-key', cookie: 'agentopsdeck_session=original-cookie', authorization: 'Bearer original-application',
  } });
  const commands = createApplicationCommandScopes({ diagnostics: silent, assertAvailable() {}, async authorize(original) {
    checks++;
    assert.equal(original.headers.get('x-agentopsdeck-key'), 'original-key');
    assert.equal(original.headers.get('cookie'), 'agentopsdeck_session=original-cookie');
    entered.release(); await observed.promise; return true;
  } });
  const capture = async (input: unknown) => { received = input; return { error: 403 as const }; };
  const ingress = createApplicationMessageIngress(commands, {
    sdk: { sendPhysical: capture }, codex: { sendPhysical: capture }, openclaw: { sendPhysical: capture }, hermes: { sendPhysical: capture },
  }, { messageTransactions: true });
  const input = { key: runtime === 'openclaw' ? 'agent:main:web:direct:original' : `${runtime}:original`, authorization: 'Bearer original-connector',
    commandKey: 'original', payloadJson: '{"message":"original"}' };
  const send = (value: typeof input & { application?: { accessKey: string } }) => runtime === 'claude-code' || runtime === 'ghcp'
    ? ingress.sdk(request, { ...value, runtime }, wait) : ingress[runtime](request, value, wait);
  try {
    await assert.rejects(send({ ...input, application: { accessKey: 'substituted' } }));
    assert.equal(checks, 0); assert.equal(received, undefined);
    const work = send(input);
    await entered.promise;
    request.headers.set('x-agentopsdeck-key', 'replacement'); request.headers.delete('cookie');
    request.headers.set('authorization', 'Bearer replacement');
    observed.release(); assert.deepEqual(await work, { error: 403 });
    assert.deepEqual(received, { ...input, ...(runtime === 'claude-code' || runtime === 'ghcp' ? { runtime } : {}),
      application: { accessKey: 'original-key', cookie: 'agentopsdeck_session=original-cookie', authorization: 'Bearer original-application' } });
  } finally { observed.release(); await commands.close(); }
});
