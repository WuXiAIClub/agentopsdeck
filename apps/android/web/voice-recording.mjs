export function installVoiceRecording(target, send) {
  const sessions = new Map();
  let paused = false;
  target.addEventListener?.('agentopsdeck:android-pause', () => { paused = true; });
  target.addEventListener?.('agentopsdeck:android-resume', () => { paused = false; });
  class VoiceRecording extends EventTarget {
    id = null;
    audio = null;
    controller = null;
    uploading = false;
    stopping = false;
    voiceSend = null;
    onstart = null;
    onresult = null;
    onerror = null;
    onend = null;
    lang = 'zh-CN';
    continuous = false;
    interimResults = false;
    emit(type, values = {}) {
      const event = Object.assign(new Event(type), values);
      this.dispatchEvent(event);
      this[`on${type}`]?.(event);
    }
    start() {
      if (this.id || paused) throw new DOMException('Recording unavailable', 'InvalidStateError');
      if (target.navigator?.userActivation?.isActive === false) throw new DOMException('Tap to record', 'NotAllowedError');
      if (typeof this.voiceSend !== 'function') throw new Error('This view does not support voice messages');
      this.stopping = false;
      this.id = target.crypto.randomUUID();
      sessions.set(this.id, this);
      try { send({ type: 'speech.start', id: this.id }); }
      catch (error) { sessions.delete(this.id); this.id = null; throw error; }
    }
    stop() {
      if (!this.id || this.stopping) return;
      this.stopping = true;
      send({ type: 'speech.stop', id: this.id });
    }
    abort() {
      this.controller?.abort();
      if (this.id) send({ type: 'speech.abort', id: this.id });
      this.end();
    }
    end() {
      if (!this.id) return;
      sessions.delete(this.id);
      this.id = null;
      this.audio = null;
      this.emit('end');
    }
    async retry() {
      if (!this.id || !this.audio || this.uploading) return;
      const id = this.id;
      this.uploading = true;
      this.controller = new AbortController();
      try {
        const result = await this.voiceSend(this.audio, id, this.controller.signal);
        if (this.id !== id) return;
        if (result?.status === 'outcome_unknown' || result?.command?.state === 'outcome_unknown')
          throw new Error('voice_outcome_unknown');
        this.emit('result', { voiceSent: true, response: result });
        send({ type: 'speech.finish', id });
        this.end();
      } catch (error) {
        if (this.id !== id) return;
        this.emit('error', { error: 'voice-upload', message: error instanceof Error ? error.message : String(error), retryable: true });
      } finally { this.uploading = false; }
    }
  }
  target.SpeechRecognition = VoiceRecording;
  target.webkitSpeechRecognition = VoiceRecording;
  target.__AGENTOPSDECK_NATIVE_SPEECH__ = true;
  target.__AGENTOPSDECK_VOICE_MESSAGES__ = true;
  return packet => {
    if (packet.type !== 'speech.event') return;
    const recording = sessions.get(packet.id);
    if (!recording) return;
    if (packet.event === 'audio') {
      recording.audio = { contentBase64: String(packet.base64), mimeType: packet.mimeType };
      recording.stopping = true;
      recording.emit('progress');
      void recording.retry();
    } else if (packet.event === 'start') recording.emit('start');
    else if (packet.event === 'error') recording.emit('error', { error: packet.error });
    else if (packet.event === 'end') recording.end();
  };
}
