export function installSpeechRecognition(target, send) {
  let sequence = 0;
  let paused = false;
  target.addEventListener?.('agentopsdeck:android-pause', () => { paused = true; });
  target.addEventListener?.('agentopsdeck:android-resume', () => { paused = false; });
  const sessions = new Map();
  class NativeSpeechRecognition extends EventTarget {
    lang = 'zh-CN';
    continuous = false;
    interimResults = false;
    maxAlternatives = 1;
    onstart = null;
    onresult = null;
    onerror = null;
    onend = null;
    id = null;
    authorized = false;

    start() {
      if (this.id) throw new DOMException('Recognition is already active', 'InvalidStateError');
      if (paused) throw new DOMException('Voice input is paused', 'InvalidStateError');
      if (!this.authorized && target.navigator?.userActivation?.isActive === false) {
        throw new DOMException('Tap the microphone to start voice input', 'NotAllowedError');
      }
      this.authorized = true;
      this.id = `speech-${++sequence}`;
      sessions.set(this.id, this);
      try {
        send({ type: 'speech.start', id: this.id, lang: this.lang, interimResults: this.interimResults });
      } catch (error) {
        sessions.delete(this.id);
        this.id = null;
        throw error;
      }
    }

    stop() { if (this.id) send({ type: 'speech.stop', id: this.id }); }
    abort() { if (this.id) send({ type: 'speech.abort', id: this.id }); }
  }
  target.SpeechRecognition = NativeSpeechRecognition;
  target.webkitSpeechRecognition = NativeSpeechRecognition;
  target.__AGENTOPSDECK_NATIVE_SPEECH__ = true;
  return packet => {
    if (packet.type !== 'speech.event') return;
    const recognition = sessions.get(packet.id);
    if (!recognition || !['start', 'result', 'error', 'end'].includes(packet.event)) return;
    const event = new Event(packet.event);
    if (packet.event === 'result') {
      const result = [{ transcript: String(packet.transcript ?? ''), confidence: 1 }];
      result.isFinal = Boolean(packet.final);
      result.item = index => result[index];
      const results = [result];
      results.item = index => results[index];
      Object.assign(event, { resultIndex: 0, results });
    }
    if (packet.event === 'error') Object.assign(event, { error: packet.error });
    if (packet.event === 'end') {
      sessions.delete(packet.id);
      recognition.id = null;
    }
    recognition.dispatchEvent(event);
    recognition[`on${packet.event}`]?.(event);
  };
}
