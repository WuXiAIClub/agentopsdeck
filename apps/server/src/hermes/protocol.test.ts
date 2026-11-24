import assert from 'node:assert/strict';
import test from 'node:test';
import { HermesFrameDecoder, HermesProtocolError, parseHermesEvent, parseRpcFrame, readyEpoch, terminalStatus } from './protocol.js';

test('Hermes NDJSON handles byte-split UTF-8, CRLF, blank lines and multiple frames', () => {
  const decoder = new HermesFrameDecoder();
  const bytes = Buffer.from('\r\n' + JSON.stringify({ jsonrpc: '2.0', id: 'x', result: { text: '你好🦀' } })
    + '\r\n' + JSON.stringify({ jsonrpc: '2.0', id: 0, result: null }) + '\n');
  const frames = [...bytes].flatMap(byte => decoder.push(Uint8Array.of(byte)));
  decoder.finish();
  assert.deepEqual(frames, [{ kind: 'response', id: 'x', result: { text: '你好🦀' } }, { kind: 'response', id: 0, result: null }]);
});

test('Hermes NDJSON enforces bytes on complete and unterminated lines and poisons invalid input', () => {
  for (const suffix of ['', '\n']) {
    const decoder = new HermesFrameDecoder(10);
    assert.throws(() => decoder.push(Buffer.from('你'.repeat(4) + suffix)), /byte limit/);
    assert.throws(() => decoder.push(Buffer.from('\n')), /closed/);
  }
  const wire = Buffer.from('{"jsonrpc":"2.0","id":1,"result":null}');
  const exact = new HermesFrameDecoder(wire.length);
  assert.equal(exact.push(Buffer.concat([wire, Buffer.from('\n')])).length, 1);
  exact.finish();
  assert.throws(() => new HermesFrameDecoder(0), RangeError);
});

test('Hermes decoder rejects invalid UTF-8, JSON, partial EOF and log noise without disclosing content', () => {
  for (const wire of [Buffer.from([0xff, 10]), Buffer.from('SECRET invalid JSON\n'), Buffer.from('runtime ready\n')]) {
    assert.throws(() => new HermesFrameDecoder().push(wire), (e: unknown) => {
      assert.ok(e instanceof HermesProtocolError);
      assert.ok(!e.message.includes('SECRET')); return true;
    });
  }
  const decoder = new HermesFrameDecoder();
  decoder.push(Buffer.from('{"jsonrpc":"2.0","id":1,"result":null}'));
  assert.throws(() => decoder.finish(), /Incomplete/);
});

test('Hermes decoder grows a bounded byte buffer for many small chunks', () => {
  const wire = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'x', result: 'x'.repeat(20_000) }) + '\n');
  const decoder = new HermesFrameDecoder(wire.length);
  let frames = 0;
  for (let i = 0; i < wire.length; i += 3) frames += decoder.push(wire.subarray(i, i + 3)).length;
  assert.equal(frames, 1); decoder.finish();
});

test('Hermes JSON-RPC validates identity and separates errors, requests and notifications', () => {
  assert.deepEqual(parseRpcFrame({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'SECRET', data: 'SECRET' } }),
    { kind: 'error', id: null, code: -32700 });
  assert.deepEqual(parseRpcFrame({ jsonrpc: '2.0', id: 'req', method: 'approval', params: {} }),
    { kind: 'request', id: 'req', method: 'approval', params: {} });
  for (const value of [null, [], { jsonrpc: '1.0' }, { jsonrpc: '2.0', id: null, result: {} },
    { jsonrpc: '2.0', id: {}, result: {} }, { jsonrpc: '2.0', id: 1.5, result: {} },
    { jsonrpc: '2.0', id: 'x', result: {}, error: {} }, { jsonrpc: '2.0', id: 1, method: 'x', result: {} },
    { jsonrpc: '2.0', id: null, method: 'x' }]) assert.throws(() => parseRpcFrame(value), HermesProtocolError);
});

test('Hermes startup is global and unsequenced; session event uses payload, not data', () => {
  const ready = parseHermesEvent({ type: 'gateway.ready', payload: { skin: {}, change_events: true, replay_epoch: 'epoch' } });
  assert.equal(readyEpoch(ready), 'epoch'); assert.equal(ready.sessionId, undefined);
  const started = parseHermesEvent({ type: 'message.start', session_id: 'live', seq: 1 });
  assert.equal(started.payload, undefined); assert.equal(readyEpoch(started), undefined);
  assert.equal(parseHermesEvent({ type: 'message.delta', session_id: 'live', payload: { text: 'hi' }, seq: 2 }).payload?.text, 'hi');
  assert.throws(() => parseHermesEvent({ type: 'message.delta', data: { text: 'wrong' } }), HermesProtocolError);
  assert.throws(() => parseHermesEvent({ type: 'message.start', seq: 1 }), HermesProtocolError);
  assert.throws(() => readyEpoch(parseHermesEvent({ type: 'gateway.ready', payload: {} })), HermesProtocolError);
});

test('Hermes terminal observation preserves failure and interruption, never completes a status-less child', () => {
  for (const [native, expected] of [['complete', 'completed'], ['error', 'failed'], ['interrupted', 'interrupted']]) {
    assert.equal(terminalStatus(parseHermesEvent({ type: 'message.complete', session_id: 'live', payload: { status: native } })), expected);
  }
  for (const event of [
    { type: 'message.complete', session_id: 'child', payload: { text: 'child mirror' } },
    { type: 'message.complete', payload: { status: 'complete' } },
    { type: 'session.interrupt', session_id: 'live', payload: { status: 'interrupted' } },
    { type: 'message.complete', session_id: 'live', payload: { status: 'new-unknown-status' } },
  ]) assert.equal(terminalStatus(parseHermesEvent(event)), undefined);
});
