export function adaptSpeechComposer(code) {
  const state = "  const [voiceState, setVoiceState] = useState<VoiceState>(() => getVoiceUnavailableReason() ? 'unsupported' : 'idle');";
  const stop = "    if (voiceState === 'listening') {\n      recognitionRef.current?.stop();";
  const start = "    recognitionRef.current = recognition;\n    setVoiceState('listening');";
  for (const marker of [state, stop, start]) {
    if (code.split(marker).length !== 3) throw new Error('Voice composer changed; review Android lifecycle feedback');
  }
  const result = '    recognition.onresult = (event: any) => {\n      if (recognitionRef.current !== recognition) return;';
  const error = '    recognition.onerror = (event: any) => {\n      if (recognitionRef.current !== recognition) return;';
  for (const marker of [result, error]) {
    if (code.split(marker).length !== 3) throw new Error('Voice result handler changed; review Android auto-send');
  }
  return code.replaceAll(state, state + `
  const [voicePhase, setVoicePhase] = useState('starting');
  const [voiceRetry, setVoiceRetry] = useState(false);
  useEffect(() => { setVoiceRetry(false); }, [session.sessionKey]);`)
    .replaceAll('  function toggleVoiceInput() {', `  function toggleVoiceInput() {
    if (voiceRetry && recognitionRef.current) {
      setVoiceRetry(false); setVoiceError(undefined); setVoicePhase('stopping'); setVoiceState('listening');
      void recognitionRef.current.retry(); return;
    }`)
    .replaceAll(stop, "    if (voiceState === 'listening') {\n      if (voicePhase === 'stopping') return;\n      setVoicePhase('stopping');\n      recognitionRef.current?.stop();")
    .replaceAll(result, result + `
      if (event.voiceSent) {
        setVoiceRetry(false);
        setVoiceError(event.response?.status === 'queued' ? '语音已转成文字并加入当前会话队列。' : '语音已转成文字并提交到当前会话。');
        void onSent().catch(() => setVoiceError('语音已提交，刷新失败；请刷新会话，不要重新发送。'));
        return;
      }`)
    .replaceAll(error, error + `
      if (event.retryable) {
        setVoiceRetry(true); setVoiceState('idle');
        const errors: Record<string, string> = {
          voice_no_speech: '没有识别到语音，请放弃这段录音后重新录制。',
          voice_transcription_busy: '服务端正在转写其他录音，稍后点击麦克风重试。',
          voice_transcription_failed: '服务端转写失败，请检查本地 Whisper 环境，或重试。',
          voice_python_unavailable: '服务端未找到 Python，请配置转写运行环境。',
          voice_transcription_timeout: '服务端转写超时，点击麦克风可重试同一段录音。',
          voice_outcome_unknown: '发送结果暂未确认，重试会沿用原请求，不会创建新消息。',
        };
        setVoiceError(errors[event.message] ?? ('转写或发送未完成，点击麦克风重试同一段录音：' + event.message));
        return;
      }`)
    .replaceAll(start, `    const voiceSessionKey = session.sessionKey;
    const voiceDeliveryMode = deliveryMode;
    recognition.voiceSend = (audio: { contentBase64: string; mimeType: string }, key: string, signal: AbortSignal) =>
      api.sendVoiceMessage(voiceSessionKey, audio, key, voiceDeliveryMode, signal);
    recognition.onprogress = () => { if (recognitionRef.current === recognition) setVoicePhase('stopping'); };
    recognition.onstart = () => { if (recognitionRef.current === recognition) setVoicePhase('listening'); };
    setVoiceRetry(false);
    setVoicePhase('starting');
` + start)
    .replaceAll("'Listening · tap mic to finish'", "(voicePhase === 'starting' ? '正在启动录音…' : voicePhase === 'stopping' ? '正在转写并发送，请稍候…' : '正在录音 · 点击结束并发送（最长60秒）')")
    .replaceAll("'Listening… speech will become text'", "(voicePhase === 'starting' ? '正在启动录音…' : voicePhase === 'stopping' ? '服务端正在转写并发送…' : '正在录音 · 结束后自动发送，不改动草稿')")
    .replaceAll("'Stop voice input'", "(voicePhase === 'stopping' ? '正在转写并发送' : '结束录音并发送')")
    .replaceAll("'Start voice input'", "(voiceRetry ? '重试上一段语音消息' : '录音并发送语音消息')")
    .replaceAll("'Dictate editable text'", "(voiceRetry ? '点击重试上一段录音，沿用原请求避免重复发送' : '录音结束后自动转写并发送到当前会话')")
    .replace(/(<(?:Button|button)\b[^\n]*onClick=\{toggleVoiceInput\}[^\n]*?<Mic[^\n]*?<\/(?:Button|button)>)/g,
      `$1{(voiceRetry || (voiceState === 'listening' && voicePhase !== 'stopping')) && <button type="button" className="composer-action" onClick={() => { discardVoiceInput(); setVoiceRetry(false); setVoiceError(undefined); }} aria-label="取消录音">{voiceRetry ? '放弃录音' : '取消录音'}</button>}`);
}
