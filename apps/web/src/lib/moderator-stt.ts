/**
 * Zero-dependency multi-provider STT, PCM/WAV encoder, and speech batching engine
 * for AgentOpsDeck Moderator Mode (v2.4.1).
 */

export type SttProviderId = 'web-speech' | 'deepgram-ws' | 'openai-whisper';
export type AudioSourceMode = 'microphone' | 'system-audio' | 'both';

export interface SttProviderConfig {
  provider: SttProviderId;
  lang: string;
  endpointUrl: string;
  model: string;
  apiKey: string;
  pauseMs: number;
  fixedWindowMs: number;
  sourceMode: AudioSourceMode;
}

export const DEFAULT_STT_CONFIG: SttProviderConfig = {
  provider: 'web-speech',
  lang: 'zh-CN',
  endpointUrl: 'https://api.openai.com/v1/audio/transcriptions',
  model: 'whisper-1',
  apiKey: '',
  pauseMs: 2500,
  fixedWindowMs: 25000,
  sourceMode: 'microphone',
};

export interface SttSegment {
  id: string;
  text: string;
  isFinal: boolean;
  timestampMs: number;
}

export interface SttBatch {
  id: string;
  text: string;
  reason: 'pause' | 'window' | 'manual';
  startedAtMs: number;
  flushedAtMs: number;
  segmentCount: number;
}

/** Downsample mono Float32 samples from srcRate to dstRate using linear interpolation. */
export function downsampleFloat32(input: Float32Array, srcRate: number, dstRate = 16000): Float32Array {
  if (!input.length || srcRate <= 0 || dstRate <= 0) return new Float32Array(0);
  if (srcRate === dstRate) return input.slice();
  const ratio = srcRate / dstRate;
  const outLen = Math.max(0, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio;
    const i0 = Math.floor(srcIdx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = srcIdx - i0;
    out[i] = input[i0]! * (1 - t) + input[i1]! * t;
  }
  return out;
}

/** Compute Root-Mean-Square level (0..1) for audio level meter and silence detection. */
export function computeAudioRms(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]!;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / samples.length));
}

/** Convert Float32 (-1..1) samples to 16-bit signed little-endian PCM bytes. */
export function float32ToPcm16Le(samples: Float32Array): Uint8Array {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    const int16 = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    view.setInt16(i * 2, int16, true);
  }
  return new Uint8Array(buffer);
}

/** Wrap 16-bit mono PCM into a standard 44-byte RIFF WAV container for Whisper HTTP endpoints. */
export function encodeWavPcm16Mono(samples: Float32Array, sampleRate = 16000): Uint8Array {
  const pcm = float32ToPcm16Le(samples);
  const wav = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(wav);
  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  new Uint8Array(wav, 44).set(pcm);
  return new Uint8Array(wav);
}

/**
 * Stateful speech accumulator that flushes transcripts when either:
 * 1) Silence/pause exceeds `pauseMs` since the last speech update, OR
 * 2) Total elapsed time since the first buffered segment reaches `fixedWindowMs`, OR
 * 3) The user triggers a manual flush.
 */

const SPOKEN_TECH_REPLACEMENTS: ReadonlyArray<[RegExp, string]> = [
  [/雷\s*out/gi, 'layout'],
  [/雷\s*奥\s*特/g, 'layout'],
  [/赛\s*神/g, 'session'],
  [/塔\s*斯\s*克\s*보\s*드|塔\s*斯\s*克\s*板/g, 'taskboard'],
];

/**
 * Normalize mixed Chinese + English speech transcripts:
 * - Collapses accidental spaces between adjacent CJK characters
 * - Inserts a clean single space at CJK <-> Latin/number boundaries
 * - Repairs common bilingual homophone/code-switching artifacts (e.g. "雷out" -> "layout")
 */
export function normalizeMixedZhEnTranscript(raw: string): string {
  if (!raw) return '';
  let text = raw.trim();
  for (const [pattern, replacement] of SPOKEN_TECH_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }
  // Collapse whitespace between CJK characters (run twice for overlapping pairs)
  text = text.replace(/([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])\s+(?=[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])/g, '$1');
  text = text.replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '$1');
  // Ensure a clean space between CJK and Latin/alphanumeric words
  text = text.replace(/([\u4e00-\u9fff])([A-Za-z0-9])/g, '$1 $2');
  text = text.replace(/([A-Za-z0-9])([\u4e00-\u9fff])/g, '$1 $2');
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Upsert a live STT segment in-place:
 * - Overwrites an existing segment with the same ID
 * - Or overwrites the trailing non-final (interim) segment so the stream updates in-place
 *   instead of appending a new line per word/syllable.
 */
export function upsertLiveSttSegment(
  prev: readonly SttSegment[],
  incoming: SttSegment,
  maxItems = 30,
): SttSegment[] {
  const normalized: SttSegment = {
    ...incoming,
    text: normalizeMixedZhEnTranscript(incoming.text) || incoming.text.trim(),
  };
  if (!normalized.text) return [...prev];
  const byIdIdx = prev.findIndex(item => item.id === normalized.id);
  if (byIdIdx >= 0) {
    const next = [...prev];
    next[byIdIdx] = normalized;
    return next.slice(-maxItems);
  }
  if (prev.length > 0 && !prev[prev.length - 1]!.isFinal) {
    const next = [...prev.slice(0, -1), normalized];
    return next.slice(-maxItems);
  }
  return [...prev.slice(-(maxItems - 1)), normalized];
}

export class SttChunkAccumulator {
  private segments: string[] = [];
  private partial = '';
  private firstAtMs: number | null = null;
  private lastAtMs: number | null = null;
  private seq = 0;

  constructor(private config: Pick<SttProviderConfig, 'pauseMs' | 'fixedWindowMs'>) {}

  updateConfig(config: Pick<SttProviderConfig, 'pauseMs' | 'fixedWindowMs'>): void {
    this.config = config;
  }

  pushSegment(text: string, isFinal: boolean, nowMs = Date.now()): SttBatch | null {
    const cleaned = normalizeMixedZhEnTranscript(text);
    if (!cleaned) return null;
    if (this.firstAtMs === null) this.firstAtMs = nowMs;
    this.lastAtMs = nowMs;
    if (isFinal) {
      this.segments.push(cleaned);
      this.partial = '';
    } else {
      this.partial = cleaned;
    }
    if (this.config.fixedWindowMs > 0 && nowMs - this.firstAtMs >= this.config.fixedWindowMs) {
      return this.flush('window', nowMs);
    }
    return null;
  }

  tick(nowMs = Date.now()): SttBatch | null {
    if (this.firstAtMs === null || this.lastAtMs === null) return null;
    if (this.config.fixedWindowMs > 0 && nowMs - this.firstAtMs >= this.config.fixedWindowMs) {
      return this.flush('window', nowMs);
    }
    if (this.config.pauseMs > 0 && nowMs - this.lastAtMs >= this.config.pauseMs) {
      return this.flush('pause', nowMs);
    }
    return null;
  }

  flush(reason: SttBatch['reason'] = 'manual', nowMs = Date.now()): SttBatch | null {
    const parts = [...this.segments];
    if (this.partial.trim()) parts.push(this.partial.trim());
    const combined = normalizeMixedZhEnTranscript(parts.join(' '));
    const startedAtMs = this.firstAtMs ?? nowMs;
    const count = parts.length;
    this.segments = [];
    this.partial = '';
    this.firstAtMs = null;
    this.lastAtMs = null;
    if (!combined) return null;
    return {
      id: `stt-batch-${++this.seq}-${nowMs}`,
      text: combined,
      reason,
      startedAtMs,
      flushedAtMs: nowMs,
      segmentCount: count,
    };
  }

  previewText(): string {
    return normalizeMixedZhEnTranscript([...this.segments, ...(this.partial ? [this.partial] : [])].join(' '));
  }
}

const STT_STORAGE_PREFIX = 'agentopsdeck.moderator-stt:v1:';

export function loadModeratorSttConfig(scope: string): SttProviderConfig {
  try {
    const raw = localStorage.getItem(`${STT_STORAGE_PREFIX}${scope || 'default'}`);
    if (!raw) return { ...DEFAULT_STT_CONFIG };
    const parsed = JSON.parse(raw) as Partial<SttProviderConfig>;
    return {
      provider: parsed.provider === 'deepgram-ws' || parsed.provider === 'openai-whisper' ? parsed.provider : 'web-speech',
      lang: typeof parsed.lang === 'string' && parsed.lang ? parsed.lang : DEFAULT_STT_CONFIG.lang,
      endpointUrl: typeof parsed.endpointUrl === 'string' && parsed.endpointUrl ? parsed.endpointUrl : DEFAULT_STT_CONFIG.endpointUrl,
      model: typeof parsed.model === 'string' && parsed.model ? parsed.model : DEFAULT_STT_CONFIG.model,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      pauseMs: typeof parsed.pauseMs === 'number' && parsed.pauseMs >= 500 ? parsed.pauseMs : DEFAULT_STT_CONFIG.pauseMs,
      fixedWindowMs: typeof parsed.fixedWindowMs === 'number' && parsed.fixedWindowMs >= 3000 ? parsed.fixedWindowMs : DEFAULT_STT_CONFIG.fixedWindowMs,
      sourceMode: parsed.sourceMode === 'system-audio' || parsed.sourceMode === 'both' ? parsed.sourceMode : 'microphone',
    };
  } catch {
    return { ...DEFAULT_STT_CONFIG };
  }
}

export function saveModeratorSttConfig(scope: string, config: SttProviderConfig): void {
  try {
    localStorage.setItem(`${STT_STORAGE_PREFIX}${scope || 'default'}`, JSON.stringify(config));
  } catch {
    // Ignore storage quota errors
  }
}

export interface ModeratorLiveCaptureCallbacks {
  onSegment: (segment: SttSegment) => void;
  onBatch: (batch: SttBatch) => void;
  onLevel: (rms: number) => void;
  onError: (message: string) => void;
}

export interface ModeratorLiveCaptureHandle {
  stop: () => void;
  flushNow: () => SttBatch | null;
}

export async function startModeratorLiveCapture(
  config: SttProviderConfig,
  callbacks: ModeratorLiveCaptureCallbacks,
  signal?: AbortSignal,
): Promise<ModeratorLiveCaptureHandle> {
  const accumulator = new SttChunkAccumulator({ pauseMs: config.pauseMs, fixedWindowMs: config.fixedWindowMs });
  const streams: MediaStream[] = [];
  let audioCtx: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  let ws: WebSocket | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let recognition: any = null;
  let stopped = false;

  const whisperSamples: Float32Array[] = [];
  let whisperSampleCount = 0;
  let whisperRequest: AbortController | undefined;
  let requestTimer: number | undefined;
  let tickTimer: number | undefined;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    signal?.removeEventListener('abort', stop);
    window.clearInterval(tickTimer);
    window.clearTimeout(requestTimer);
    whisperRequest?.abort();
    whisperSamples.length = 0;
    whisperSampleCount = 0;
    if (recognition) {
      recognition.onresult = recognition.onerror = recognition.onend = null;
      try { if (recognition.abort) recognition.abort(); else recognition.stop(); } catch {}
    }
    if (ws) {
      ws.onmessage = ws.onerror = null;
      try { ws.close(); } catch {}
    }
    if (processor) {
      processor.onaudioprocess = null;
      try { processor.disconnect(); } catch {}
    }
    try { void audioCtx?.close().catch(() => {}); } catch {}
    for (const stream of streams) stream.getTracks().forEach(track => track.stop());
  };
  const aborted = () => new DOMException('Capture cancelled', 'AbortError');
  if (signal?.aborted) throw aborted();
  signal?.addEventListener('abort', stop, { once: true });

  const acquireStream = (pending: Promise<MediaStream>) => new Promise<MediaStream>((resolve, reject) => {
    const cancel = () => reject(aborted());
    signal?.addEventListener('abort', cancel, { once: true });
    void pending.then(stream => {
      signal?.removeEventListener('abort', cancel);
      if (stopped) {
        stream.getTracks().forEach(track => track.stop());
        reject(aborted());
      } else {
        streams.push(stream);
        resolve(stream);
      }
    }, error => {
      signal?.removeEventListener('abort', cancel);
      reject(error);
    });
    if (stopped) {
      signal?.removeEventListener('abort', cancel);
      cancel();
    }
  });

  tickTimer = window.setInterval(() => {
    if (stopped) return;
    const batch = accumulator.tick(Date.now());
    if (batch) callbacks.onBatch(batch);
  }, 400);

  async function flushWhisperWindow() {
    if (stopped || whisperRequest || !whisperSampleCount || config.provider !== 'openai-whisper') return;
    const merged = new Float32Array(whisperSampleCount);
    let offset = 0;
    for (const chunk of whisperSamples) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    whisperSamples.length = 0;
    whisperSampleCount = 0;
    if (computeAudioRms(merged) < 0.008) return;
    const request = new AbortController();
    whisperRequest = request;
    requestTimer = window.setTimeout(() => request.abort(), 20_000);
    try {
      const wav = encodeWavPcm16Mono(merged, 16000);
      const form = new FormData();
      form.append('file', new Blob([wav.buffer as ArrayBuffer], { type: 'audio/wav' }), 'speech.wav');
      form.append('model', config.model || 'whisper-1');
      if (config.lang && config.lang !== 'auto') form.append('language', config.lang.split('-')[0] || 'zh');
      form.append('prompt', '以下是普通话与英文混合的会议讨论，包含 layout, session, agent, token, notebook, taskboard, Codex, API 等技术词汇。');
      const res = await fetch(config.endpointUrl || DEFAULT_STT_CONFIG.endpointUrl, {
        method: 'POST',
        headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
        body: form,
        signal: request.signal,
      });
      if (stopped || request.signal.aborted) return;
      if (!res.ok) throw new Error(`STT HTTP ${res.status}`);
      const data = (await res.json()) as { text?: string };
      if (stopped || request.signal.aborted) return;
      const text = normalizeMixedZhEnTranscript(data.text ?? '');
      if (text) {
        const now = Date.now();
        callbacks.onSegment({ id: `seg-${now}`, text, isFinal: true, timestampMs: now });
        if (stopped) return;
        const batch = accumulator.pushSegment(text, true, now);
        if (batch) callbacks.onBatch(batch);
      }
    } catch (err) {
      if (!stopped) callbacks.onError(err instanceof Error ? err.message : 'Whisper STT request failed');
    } finally {
      window.clearTimeout(requestTimer);
      requestTimer = undefined;
      whisperRequest = undefined;
    }
  }

  try {
    if (config.sourceMode === 'microphone' || config.sourceMode === 'both') {
      await acquireStream(navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      }));
      if (stopped) throw aborted();
    }
    if (config.sourceMode === 'system-audio' || config.sourceMode === 'both') {
      await acquireStream(navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }));
      if (stopped) throw aborted();
    }

    audioCtx = new AudioContext();
    const mixer = audioCtx.createGain();
    for (const stream of streams) {
      if (stream.getAudioTracks().length > 0) {
        const source = audioCtx.createMediaStreamSource(stream);
        source.connect(mixer);
      }
    }
    processor = audioCtx.createScriptProcessor(4096, 1, 1);
    mixer.connect(processor);
    processor.connect(audioCtx.destination);

    if (config.provider === 'deepgram-ws') {
      const sessionStart = Date.now();
      let dgUtteranceSeq = 0;
      const base = config.endpointUrl.startsWith('ws')
        ? config.endpointUrl
        : 'wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1&interim_results=true&model=nova-2&smart_format=true';
      ws = new WebSocket(base, config.apiKey ? ['token', config.apiKey] : undefined);
      ws.onmessage = event => {
        if (stopped) return;
        try {
          const msg = JSON.parse(String(event.data));
          const transcript = normalizeMixedZhEnTranscript(String(msg?.channel?.alternatives?.[0]?.transcript ?? ''));
          const isFinal = Boolean(msg?.is_final);
          if (transcript) {
            const now = Date.now();
            const segId = `dg-${sessionStart}-${dgUtteranceSeq}`;
            if (isFinal) dgUtteranceSeq += 1;
            callbacks.onSegment({ id: segId, text: transcript, isFinal, timestampMs: now });
            if (stopped) return;
            const batch = accumulator.pushSegment(transcript, isFinal, now);
            if (batch) callbacks.onBatch(batch);
          }
        } catch {
          // Ignore malformed WS frame
        }
      };
      ws.onerror = () => { if (!stopped) callbacks.onError('Deepgram WebSocket connection error'); };
    } else if (config.provider === 'web-speech') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRec) {
        const sessionStart = Date.now();
        let restartEpoch = 0;
        recognition = new SpeechRec();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = !config.lang || config.lang === 'auto' ? 'zh-CN' : config.lang;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        recognition.onresult = (event: any) => {
          if (stopped) return;
          for (let i = event.resultIndex; i < event.results.length; i++) {
            if (stopped) return;
            const res = event.results[i];
            const transcript = normalizeMixedZhEnTranscript(String(res?.[0]?.transcript ?? ''));
            const isFinal = Boolean(res?.isFinal);
            if (transcript) {
              const now = Date.now();
              callbacks.onSegment({ id: `ws-${sessionStart}-${restartEpoch}-${i}`, text: transcript, isFinal, timestampMs: now });
              if (stopped) return;
              const batch = accumulator.pushSegment(transcript, isFinal, now);
              if (batch) callbacks.onBatch(batch);
            }
          }
        };
        recognition.onerror = () => {
          // Keep audio meter active even if Web Speech pauses
        };
        recognition.onend = () => {
          if (!stopped && recognition) {
            restartEpoch += 1;
            try { recognition.start(); } catch { /* ignore */ }
          }
        };
        recognition.start();
      }
    }

    const srcRate = audioCtx.sampleRate;
    processor.onaudioprocess = event => {
      if (stopped) return;
      const input = event.inputBuffer.getChannelData(0);
      callbacks.onLevel(computeAudioRms(input));
      if (stopped) return;
      const down = downsampleFloat32(input, srcRate, 16000);
      if (config.provider === 'deepgram-ws' && ws && ws.readyState === WebSocket.OPEN) {
        const pcm = float32ToPcm16Le(down);
        if (ws.bufferedAmount + pcm.byteLength <= 256 * 1024) ws.send(pcm.buffer);
      } else if (config.provider === 'openai-whisper' && !whisperRequest) {
        const chunk = down.subarray(0, Math.max(0, 16000 * 6 - whisperSampleCount));
        whisperSamples.push(chunk);
        whisperSampleCount += chunk.length;
        if (whisperSampleCount >= 16000 * 6) {
          void flushWhisperWindow();
        }
      }
    };
  } catch (err) {
    stop();
    throw err;
  }

  return {
    stop,
    flushNow: () => {
      if (stopped) return null;
      if (config.provider === 'openai-whisper' && whisperSampleCount > 0) {
        void flushWhisperWindow();
      }
      if (stopped) return null;
      const batch = accumulator.flush('manual', Date.now());
      if (batch) callbacks.onBatch(batch);
      return batch;
    },
  };
}
