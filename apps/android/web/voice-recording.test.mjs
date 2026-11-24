import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { installVoiceRecording } from './voice-recording.mjs';

function fixture(upload = async () => ({ status: 'queued' })) {
  const target = new EventTarget();
  target.crypto = { randomUUID };
  target.navigator = { userActivation: { isActive: true } };
  const sent = [], uploads = [], results = [], errors = [];
  const receive = installVoiceRecording(target, packet => sent.push(packet));
  const recording = new target.SpeechRecognition();
  recording.voiceSend = async (...args) => { uploads.push(args); return upload(...args); };
  recording.onresult = event => results.push(event);
  recording.onerror = event => errors.push(event);
  const emit = (event, extra = {}) => receive({ type: 'speech.event', id: recording.id, event, ...extra });
  return { target, recording, sent, uploads, results, errors, receive, emit };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('uses native recording without a system recognition provider', () => {
  const state = fixture();
  state.recording.start();
  state.recording.stop(); state.recording.stop();
  assert.equal(state.sent.filter(item => item.type === 'speech.stop').length, 1);
  assert.equal(state.target.__AGENTOPSDECK_VOICE_MESSAGES__, true);
  assert.equal(state.target.SpeechRecognition, state.target.webkitSpeechRecognition);
});

test('audio uploads and reports submitted message without draft transcript', async () => {
  const state = fixture();
  state.recording.start();
  const id = state.recording.id;
  state.emit('audio', { base64: 'AAAA', mimeType: 'audio/mp4' });
  await tick();
  assert.equal(state.uploads[0][1], id);
  assert.equal(state.results[0].voiceSent, true);
  assert.equal(state.results[0].results, undefined);
  assert.equal(state.recording.id, null);
  assert.equal(state.sent.at(-1).type, 'speech.finish');
});

test('failure retains audio and retries using the same command key', async () => {
  let attempts = 0;
  const state = fixture(async () => { if (++attempts === 1) throw new Error('network failed'); return { status: 'queued' }; });
  state.recording.start();
  const id = state.recording.id;
  state.emit('audio', { base64: 'AAAA', mimeType: 'audio/mp4' });
  await tick();
  assert.equal(state.errors[0].retryable, true);
  assert.equal(state.recording.id, id);
  await state.recording.retry();
  assert.equal(state.uploads[1][1], id);
  assert.deepEqual(state.uploads[0][0], state.uploads[1][0]);
  assert.equal(state.results.length, 1);
});

test('unknown outcomes are not reported as sent', async () => {
  const state = fixture(async () => ({ status: 'outcome_unknown' }));
  state.recording.start(); state.emit('audio', { base64: 'AAAA', mimeType: 'audio/mp4' });
  await tick();
  assert.equal(state.results.length, 0);
  assert.equal(state.errors[0].message, 'voice_outcome_unknown');
});

test('cancel ignores late audio and late upload responses', async () => {
  let release;
  const state = fixture(() => new Promise(resolve => { release = resolve; }));
  state.recording.start();
  const id = state.recording.id;
  state.emit('audio', { base64: 'AAAA', mimeType: 'audio/mp4' });
  state.recording.abort();
  release({ status: 'queued' });
  state.receive({ type: 'speech.event', id, event: 'audio', base64: 'BBBB' });
  await tick();
  assert.equal(state.results.length, 0);
  assert.equal(state.uploads.length, 1);
});

test('background and programmatic starts cannot open a microphone', () => {
  const state = fixture();
  state.target.navigator.userActivation.isActive = false;
  assert.throws(() => state.recording.start(), { name: 'NotAllowedError' });
  state.target.navigator.userActivation.isActive = true;
  state.target.dispatchEvent(new Event('agentopsdeck:android-pause'));
  assert.throws(() => state.recording.start(), { name: 'InvalidStateError' });
});
