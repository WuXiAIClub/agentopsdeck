import test from 'node:test';
import assert from 'node:assert/strict';
import { installSpeechRecognition } from './speech-recognition.mjs';

function fixture() {
  const target = new EventTarget();
  target.navigator = { userActivation: { isActive: true } };
  const sent = [];
  const receive = installSpeechRecognition(target, packet => sent.push(packet));
  const recognition = new target.SpeechRecognition();
  const emit = (event, extra = {}) => receive({ type: 'speech.event', id: recognition.id, event, ...extra });
  return { target, sent, receive, recognition, emit };
}

test('both browser constructors use native speech even in a LAN insecure context', () => {
  const { target, sent, recognition } = fixture();
  assert.equal(target.SpeechRecognition, target.webkitSpeechRecognition);
  assert.equal(target.__AGENTOPSDECK_NATIVE_SPEECH__, true);
  recognition.lang = 'zh-CN';
  recognition.interimResults = true;
  recognition.start();
  assert.deepEqual(sent[0], { type: 'speech.start', id: 'speech-1', lang: 'zh-CN', interimResults: true });
  assert.throws(() => recognition.start(), { name: 'InvalidStateError' });
});

test('partial and final results match existing composer Web Speech consumers', () => {
  const { recognition, emit } = fixture();
  const results = [];
  recognition.onresult = event => results.push(event);
  let listenerCalls = 0;
  recognition.addEventListener('result', () => listenerCalls++);
  recognition.start();
  emit('result', { transcript: '你好', final: false });
  emit('result', { transcript: '你好世界', final: true });
  assert.equal(listenerCalls, 2);
  assert.equal(results[0].resultIndex, 0);
  assert.equal(results[0].results[0].isFinal, false);
  assert.equal(results[1].results.item(0).item(0).transcript, '你好世界');
  assert.equal(results[1].results[0].isFinal, true);
});

test('stop and abort correlate ids, end clears state before callbacks, stale results ignored', () => {
  const { recognition, sent, emit, receive } = fixture();
  recognition.start();
  const oldId = recognition.id;
  recognition.stop();
  recognition.abort();
  assert.deepEqual(sent.slice(1).map(packet => packet.type), ['speech.stop', 'speech.abort']);
  let results = 0;
  recognition.onresult = () => results++;
  recognition.onend = () => recognition.start();
  emit('end');
  assert.notEqual(recognition.id, oldId);
  receive({ type: 'speech.event', id: oldId, event: 'result', transcript: 'stale' });
  receive({ type: 'cache.snapshot', id: recognition.id, event: 'result' });
  assert.equal(results, 0);
});

test('permission failure reaches handlers and can retry after end', () => {
  const { recognition, emit } = fixture();
  const events = [];
  recognition.onerror = event => events.push(event.error);
  recognition.onend = () => events.push('end');
  recognition.start();
  emit('error', { error: 'not-allowed' });
  emit('end');
  assert.deepEqual(events, ['not-allowed', 'end']);
  recognition.start();
  assert.ok(recognition.id);
});

test('initial recording requires a gesture and background sessions cannot restart', () => {
  const { target, recognition, sent, emit } = fixture();
  target.navigator.userActivation.isActive = false;
  assert.throws(() => recognition.start(), { name: 'NotAllowedError' });
  assert.equal(sent.length, 0);
  target.navigator.userActivation.isActive = true;
  recognition.start();
  emit('end');
  target.navigator.userActivation.isActive = false;
  recognition.start();
  emit('end');
  target.dispatchEvent(new Event('agentopsdeck:android-pause'));
  assert.throws(() => recognition.start(), { name: 'InvalidStateError' });
  target.dispatchEvent(new Event('agentopsdeck:android-resume'));
  recognition.start();
  assert.ok(recognition.id);
});

test('failed bridge sends release state so the same recognizer can retry', () => {
  const target = {};
  let fail = true;
  installSpeechRecognition(target, () => { if (fail) throw new Error('bridge unavailable'); });
  const recognition = new target.SpeechRecognition();
  assert.throws(() => recognition.start(), /bridge unavailable/);
  assert.equal(recognition.id, null);
  fail = false;
  recognition.start();
  assert.ok(recognition.id);
});
