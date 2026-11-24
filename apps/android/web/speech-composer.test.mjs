import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptSpeechComposer } from './speech-composer.mjs';

const composer = `  const [voiceState, setVoiceState] = useState<VoiceState>(() => getVoiceUnavailableReason() ? 'unsupported' : 'idle');
    if (voiceState === 'listening') {
      recognitionRef.current?.stop();
    }
    recognitionRef.current = recognition;
    setVoiceState('listening');
    recognition.onresult = (event: any) => {
      if (recognitionRef.current !== recognition) return;
    };
    recognition.onerror = (event: any) => {
      if (recognitionRef.current !== recognition) return;
    };
    'Listening · tap mic to finish';
    'Listening… speech will become text';
    'Stop voice input';`;

test('both Android composers distinguish starting, listening and stopping', () => {
  const adapted = adaptSpeechComposer(composer + '\n' + composer);
  assert.equal(adapted.split("setVoicePhase('starting')").length - 1, 2);
  assert.equal(adapted.split("setVoicePhase('listening')").length - 1, 2);
  assert.equal(adapted.split("setVoicePhase('stopping')").length - 1, 4);
  assert.match(adapted, /recognition\.onstart/);
  assert.match(adapted, /结束录音并发送/);
  assert.match(adapted, /api\.sendVoiceMessage\(voiceSessionKey/);
  assert.match(adapted, /服务端正在转写并发送/);
  assert.match(adapted, /event\.voiceSent/);
});

test('frontend changes fail loudly rather than shipping a partial adaptation', () => {
  assert.throws(() => adaptSpeechComposer(composer), /Voice composer changed/);
  assert.throws(() => adaptSpeechComposer((composer + composer).replaceAll('?.stop()', '?.finish()')), /Voice composer changed/);
});
