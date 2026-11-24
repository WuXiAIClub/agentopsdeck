import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncCodexMessages } from './async-codex-messages.js';
import { AsyncOpenClawMessages } from './async-openclaw-messages.js';
import { AsyncHermesMessages } from './async-hermes-messages.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { HERMES_MESSAGE_PAYLOAD_BYTES } from './connector-hermes-message-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
const wait = { timeoutMs: 10_000 }, silent = new PerformanceDiagnostics(() => {});
type Command = ConstructorParameters<typeof AsyncHermesMessages>[0]['command'];

for (const runtime of ['codex', 'openclaw', 'hermes'] as const) {
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'async-message-participants-'));
    const authorization = 'Bearer isolated-original-participant';
    const tokens = new ConnectorTokenStore(join(root, 'tokens.json'), authorization.slice(7), silent);
    const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
    const key = runtime === 'openclaw' ? 'agent:main:original' : `${runtime}:original`;
    if (runtime === 'hermes') store.hermesJournal.save({ key, stored: 'native', title: 'Original', started: false, messages: [] });
    const command = createConnectorOwnerCommands(store, tokens);
    const ack = gate(), submitted = gate(), notification = gate();
    let calls = 0, effects = 0, notices = 0, ready = true;
    const owner = { command: (async (kind, value) => {
      const result = await command(kind, value); calls++;
      if (calls === 1) { submitted.release(); await ack.promise; }
      return result;
    }) as Command };
    const admitted = async () => { notices++; await notification.promise; };
    const options = { owner, defaultAgentId: 'main', ready: () => ready, sessionExists: () => true,
      displayBlocked: () => false, persist: async () => { effects++; return []; }, admitted, diagnostics: silent };
    const messages = runtime === 'hermes' ? new AsyncHermesMessages(owner, admitted, silent)
      : runtime === 'codex' ? new AsyncCodexMessages(options) : new AsyncOpenClawMessages(options);
    return { messages, options, owner, command, store, ack, submitted, notification,
      request: { key, authorization, commandKey: 'original-message', payloadJson: '{"message":"original text"}' },
      counts: () => ({ calls, effects, notices }), unready: () => { ready = false; },
      close: async () => { ack.release(); notification.release(); await messages.close(); command.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); } };
  }

  test(`${runtime}: real receipt/queue/file chain retains original owner and callbacks through caller mutation and lost ACK`, async () => {
    const f = fixture();
    try {
      const request = structuredClone(f.request);
      const sending = f.messages.send(request, { timeoutMs: 1 });
      await assert.rejects(sending); await f.submitted.promise;
      request.key = `${runtime}:foreign`; request.payloadJson = '{}'; request.authorization = 'Bearer foreign';
      f.owner.command = (async () => { throw Error('replacement owner'); }) as Command;
      f.options.ready = () => false; f.options.sessionExists = () => false;
      f.options.defaultAgentId = 'foreign'; f.options.displayBlocked = () => true;
      f.options.persist = async () => { throw Error('replacement file effect'); };
      f.options.admitted = async () => { throw Error('replacement notification'); };
      f.ack.release();
      for (let i = 0; f.counts().notices === 0 && i < 1000; i++) await tick();
      assert.equal(f.counts().notices, 1);
      assert.equal(f.counts().effects, runtime === 'hermes' ? 0 : 1);
      let closed = false;
      const closing = f.messages.close().then(() => { closed = true; });
      await tick(); assert.equal(closed, false, 'original asynchronous notification owns drain');
      f.notification.release(); await closing;
      const actor = f.store.turns.list<{ actorId: string }>(runtime, f.request.key)[0];
      assert.ok(actor, 'one original queued turn survives lost ACK and close');
      assert.equal(f.store.turns.list(runtime, f.request.key).length, 1);
      assert.equal(f.counts().notices, 1);
    } finally { await f.close(); }
  });

  test(`${runtime}: input accessors are never invoked for send or either recovery read`, async () => {
    const f = fixture(); let getters = 0;
    try {
      const send = { ...f.request, get payloadJson() { getters++; return '{}'; } };
      const scope = { key: f.request.key, commandKey: f.request.commandKey,
        get authorization() { getters++; return f.request.authorization; } };
      await assert.rejects(f.messages.send(send, wait));
      await assert.rejects(f.messages.readReceipt(scope, wait));
      await assert.rejects(f.messages.readSendReceipt(scope, wait));
      assert.equal(getters, 0); assert.equal(f.counts().calls, 0);
    } finally { await f.close(); }
  });

  if (runtime !== 'hermes') test(`${runtime}: original readiness is rechecked, not snapshotted as an authorized boolean`, async () => {
    const f = fixture();
    try {
      const sending = f.messages.send(f.request, wait), rejected = assert.rejects(sending);
      await f.submitted.promise; f.unready(); f.ack.release(); await rejected;
      assert.equal(f.counts().effects, 0); assert.equal(f.counts().notices, 0);
      assert.equal(f.store.turns.list(runtime, f.request.key).length, 0);
    } finally { await f.close(); }
  });
}

test('Hermes: aggregate payload budget remains held through lost wait and is released by original completion only', async () => {
  const ack = gate(); let calls = 0;
  const messages = new AsyncHermesMessages({ command: (async () => { calls++; await ack.promise; return { error: 403 }; }) as Command }, () => {}, silent);
  const request = { key: 'hermes:original', authorization: 'Bearer original', commandKey: 'original',
    payloadJson: JSON.stringify({ message: 'original', padding: 'x'.repeat(HERMES_MESSAGE_PAYLOAD_BYTES - 100) }) };
  try {
    const first = messages.send(request, { timeoutMs: 1 }), firstRejected = assert.rejects(first);
    const second = messages.send({ ...request, commandKey: 'second' }, { timeoutMs: 1 }), secondRejected = assert.rejects(second);
    await Promise.all([firstRejected, secondRejected]); assert.equal(calls, 2);
    await assert.rejects(messages.send({ ...request, commandKey: 'third' }, wait)); assert.equal(calls, 2);
    ack.release(); await tick();
    assert.deepEqual(await messages.send({ ...request, commandKey: 'third' }, wait), { error: 403 }); assert.equal(calls, 3);
  } finally { ack.release(); await messages.close(); }
});
