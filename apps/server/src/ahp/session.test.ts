import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryTransport } from '@microsoft/agent-host-protocol/client';
import { AhpSession } from './session.js';
import { selectVsCodeEndpoint } from './vscode-transport.js';

const sessionUri = 'ahp-session:/11111111-1111-4111-8111-111111111111';
const chatUri = 'ahp-chat:/selected-chat';

async function host(timeoutMs?: number, options: { member?: boolean; readOnly?: boolean } = {}) {
  const [client, peer] = InMemoryTransport.pair();
  const session = AhpSession.attach(client, { sessionUri }, timeoutMs);
  const next = async () => {
    const frame = await peer.recv();
    assert.equal(frame?.kind, 'text');
    return JSON.parse(frame.text);
  };
  const respond = (id: number, result: object) => peer.send({ jsonrpc: '2.0', id, result });
  const init = await next();
  assert.equal(init.method, 'initialize');
  assert.equal(init.params.initialSubscriptions, undefined);
  await respond(init.id, { protocolVersion: '1.1.0', serverSeq: 0, snapshots: [] });
  const subscribe = await next();
  assert.deepEqual(subscribe.params, { channel: sessionUri });
  await respond(subscribe.id, { snapshot: { resource: sessionUri, fromSeq: 0, state: {
    lifecycle: 'ready', defaultChat: chatUri, chats: options.member === false ? [] : [{ resource: chatUri }],
  } } });
  if (options.member !== false) {
    const chat = await next();
    assert.deepEqual(chat.params, { channel: chatUri, view: { turns: 100 } });
    await respond(chat.id, { snapshot: { resource: chatUri, fromSeq: 1, state: {
      resource: chatUri, title: 'Synthetic chat', status: 1, turns: [{ id: 'earlier', message: { text: 'Earlier' },
        responseParts: [{ kind: 'markdown', id: 'part', content: 'Answer' }] }],
      ...(options.readOnly ? { interactivity: 'read-only' } : {}),
    } } });
  }
  let serverSeq = 1;
  const emit = (action: object, extra: object = {}) => peer.send({ jsonrpc: '2.0', method: 'action',
    params: { channel: chatUri, serverSeq: ++serverSeq, action, ...extra } });
  return { session, peer, next, emit, clientId: init.params.clientId as string };
}

test('AHP projects existing text and acknowledges only the exact locally dispatched turn', { timeout: 3_000 }, async () => {
  const fixture = await host();
  const session = await fixture.session;
  try {
    assert.deepEqual(session.view().turns, [{ id: 'earlier', prompt: 'Earlier', response: 'Answer', active: false }]);
    const sent = session.sendText('New message');
    await assert.rejects(session.sendText('Concurrent message'), /not accepting/);
    const dispatch = await fixture.next();
    const { channel, clientSeq, action } = dispatch.params;
    assert.equal(dispatch.method, 'dispatchAction');
    assert.equal(channel, chatUri);
    assert.equal(action.type, 'chat/turnStarted');
    assert.equal(action.message.text, 'New message');
    await fixture.emit(action, { origin: { clientId: 'other-client', clientSeq }, rejectionReason: 'Synthetic rejection' });
    await fixture.emit(action, { origin: { clientId: fixture.clientId, clientSeq } });
    assert.equal(await sent, action.turnId);
    await fixture.emit({ type: 'chat/responsePart', turnId: action.turnId, part: { kind: 'markdown', id: 'live', content: 'Par' } });
    await fixture.emit({ type: 'chat/delta', turnId: action.turnId, partId: 'live', content: 'tial' });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(session.view().turns.at(-1),
      { id: action.turnId, prompt: 'New message', response: 'Partial', active: true });
  } finally {
    await session.close();
  }
});

test('AHP does not follow a chat absent from the selected session and cannot send into read-only chats', { timeout: 3_000 }, async () => {
  const mismatched = await host(undefined, { member: false });
  await assert.rejects(mismatched.session, /AHP session unavailable/);
  assert.equal(await mismatched.peer.recv(), null);
  const readOnly = await host(undefined, { readOnly: true });
  const session = await readOnly.session;
  try {
    assert.equal(session.view().canSend, false);
    await assert.rejects(session.sendText('Must not be dispatched'), /not accepting/);
  } finally {
    await session.close();
  }
  assert.equal(await readOnly.peer.recv(), null);
});

for (const reason of ['disconnect', 'timeout']) {
  test(`AHP fences an unconfirmed dispatch on ${reason} rather than sending it again`, { timeout: 3_000 }, async () => {
    const fixture = await host(250);
    const session = await fixture.session;
    const failure = assert.rejects(session.sendText('Unconfirmed message'), /outcome unknown/);
    assert.equal((await fixture.next()).method, 'dispatchAction');
    if (reason === 'disconnect') await fixture.peer.close();
    await failure;
    await assert.rejects(session.sendText('Retry'), /not accepting/);
    await session.close();
    assert.equal(await fixture.peer.recv(), null);
  });
}

test('VS Code discovery requires one exact named-pipe editor instance and a private token', () => {
  const instanceId = 'selected-instance';
  const path = '\\\\.\\pipe\\vscode-agent-host-synthetic-test-pipe';
  const connectionToken = 'synthetic-test-token';
  const entry = { schemaVersion: 2, type: 'editor', instanceId, endpoint: { type: 'socket', path }, connectionToken };
  assert.deepEqual(selectVsCodeEndpoint({ endpoints: [{ ...entry, instanceId: 'another-instance' }, entry] }, instanceId),
    { path, connectionToken });
  for (const endpoints of [
    [entry, entry],
    [{ ...entry, endpoint: { type: 'tcp', host: 'localhost', port: 443 } }],
    [{ ...entry, endpoint: { type: 'socket', path: '\\\\not-local\\pipe\\vscode-agent-host-synthetic-test-pipe' } }],
    [{ ...entry, endpoint: { ...entry.endpoint, path: `${path}\\nested` } }],
    [{ ...entry, connectionToken: '' }],
  ]) assert.throws(() => selectVsCodeEndpoint({ endpoints }, instanceId), /^Error: VS Code Agent Host discovery failed$/);
});
