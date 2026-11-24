import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyJointEmptyRestart } from './permissions-joint-empty-restart.mjs';

function fixture(fault) {
  let restarted = false, requests = fault === 'prior-send' ? 1 : 0;
  const calls = [];
  const sessions = ['alice', 'bob'].map((actor, index) => ({ actor,
    foreign: index === 0 ? 'bob' : 'alice',
    session: { key: actor, path: '/' + actor, creation: { label: actor, idempotencyKey: actor } } }));
  const connector = { child: { pid: 1 }, origin: 'http://127.0.0.1:1234' };
  const hub = { child: { pid: 2 } }, secondHost = { child: { pid: 3 } };
  const options = { connector, hub, secondHost, sessions, creationPath: '/create', requestCount: () => requests,
    stop: async host => { assert.equal(host, connector); calls.push('stop'); },
    start: async (role, port) => {
      assert.equal(role, 'connector'); assert.equal(port, '1234'); restarted = true; calls.push('start');
      if (fault === 'hub-exit') hub.exit = { code: 0 };
      if (fault === 'second-exit') secondHost.exit = { code: 0 };
      if (fault === 'replay') requests++;
      return { child: { pid: fault === 'same-pid' ? 1 : 4 }, origin: connector.origin };
    },
    api: async (actor, path, method, body, expected) => {
      calls.push({ actor, path, method, body, expected });
      const owner = path.split('/').at(-1);
      if (expected === 404) {
        assert.ok(path.startsWith('/' + (actor === 'alice' ? 'bob' : 'alice')) || owner !== actor);
        if (fault === 'foreign-allowed') throw new Error('Expected 404, got 200');
        return;
      }
      if (method === 'POST') {
        assert.equal(body.idempotencyKey, actor); assert.equal(expected, 201);
        return { key: fault === 'replacement-session' ? 'new-session' : actor };
      }
      if (path.endsWith('/messages')) return { messages: restarted && fault === 'not-empty' ? [{ role: 'assistant' }] : [] };
      assert.equal(owner, actor);
      return { command: { state: 'accepted', id: restarted && fault === 'replacement-receipt' ? 'new-receipt' : owner } };
    } };
  return { options, calls };
}

test('empty-restart checkpoint replaces only Connector and checks exact original identity, receipts and both foreign denies', async () => {
  const { options, calls } = fixture();
  assert.equal((await verifyJointEmptyRestart(options)).child.pid, 4);
  assert.ok(calls.indexOf('stop') < calls.indexOf('start'));
  assert.equal(calls.filter(call => call.expected === 404).length, 4);
  assert.equal(calls.filter(call => call.method === 'POST').length, 2);
});

for (const fault of ['prior-send', 'same-pid', 'hub-exit', 'second-exit', 'replay',
  'not-empty', 'replacement-session', 'replacement-receipt', 'foreign-allowed']) {
  test('empty-restart checkpoint rejects ' + fault, async () => {
    await assert.rejects(verifyJointEmptyRestart(fixture(fault).options));
  });
}
