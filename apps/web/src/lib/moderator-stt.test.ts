import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DEFAULT_STT_CONFIG, startModeratorLiveCapture, type SttProviderConfig } from './moderator-stt.js';

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function captureFixture(context: TestContext, overrides: Partial<SttProviderConfig> = {}) {
  const intervals = new Map<number, () => void>();
  const timeouts = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0, trackStops = 0, audioCloses = 0, disconnects = 0, restarts = 0;
  const processor = { onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null,
    connect() {}, disconnect() { disconnects++; } };
  const stream = { getTracks: () => [{ stop: () => { trackStops++; } }], getAudioTracks: () => [{}] } as unknown as MediaStream;
  class Audio {
    sampleRate = 16000;
    destination = {};
    createGain() { return { connect() {} }; }
    createMediaStreamSource() { return { connect() {} }; }
    createScriptProcessor() { return processor; }
    close() { audioCloses++; return Promise.resolve(); }
  }
  class Socket {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    sent: ArrayBuffer[] = [];
    closed = false;
    constructor() { sockets.push(this); }
    send(packet: ArrayBuffer) { this.sent.push(packet); }
    close() { this.closed = true; }
  }
  const sockets: Socket[] = [];
  class Recognition {
    onresult: ((event: unknown) => void) | null = null;
    onerror: (() => void) | null = null;
    onend: (() => void) | null = null;
    aborted = false;
    constructor() { recognitions.push(this); }
    start() { restarts++; }
    abort() { this.aborted = true; }
  }
  const recognitions: Recognition[] = [];
  const media = { getUserMedia: async () => stream, getDisplayMedia: async () => stream };
  const globals: Record<string, unknown> = {
    navigator: { mediaDevices: media }, AudioContext: Audio, WebSocket: Socket,
    window: {
      SpeechRecognition: Recognition,
      setInterval: (callback: () => void) => { intervals.set(++timerId, callback); return timerId; },
      clearInterval: (id: number) => { intervals.delete(id); },
      setTimeout: (callback: () => void, delay: number) => { timeouts.set(++timerId, { callback, delay }); return timerId; },
      clearTimeout: (id: number) => { timeouts.delete(id); },
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    context.after(() => { if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name); });
  }
  const segments: unknown[] = [], batches: unknown[] = [], errors: string[] = [], levels: number[] = [];
  const callbacks = { onSegment: (value: unknown) => { segments.push(value); }, onBatch: (value: unknown) => { batches.push(value); },
    onError: (value: string) => { errors.push(value); }, onLevel: (value: number) => { levels.push(value); } };
  const feed = (samples = 16000 * 6) => processor.onaudioprocess?.({
    inputBuffer: { getChannelData: () => new Float32Array(samples).fill(0.1) },
  } as unknown as AudioProcessingEvent);
  return { config: { ...DEFAULT_STT_CONFIG, provider: 'openai-whisper' as const, ...overrides }, callbacks, media, stream,
    intervals, timeouts, processor, sockets, recognitions, segments, batches, errors, levels, feed,
    counts: () => ({ trackStops, audioCloses, disconnects, restarts }) };
}

test('capture abort before permission settles rejects promptly and stops the late stream', async context => {
  const fixture = captureFixture(context), permission = deferred<MediaStream>(), controller = new AbortController();
  fixture.media.getUserMedia = () => permission.promise;
  const capture = startModeratorLiveCapture(fixture.config, fixture.callbacks, controller.signal);
  controller.abort();
  await assert.rejects(capture, { name: 'AbortError' });
  assert.equal(fixture.intervals.size, 0);
  permission.resolve(fixture.stream);
  await settle();
  assert.equal(fixture.counts().trackStops, 1);
  assert.equal(fixture.counts().audioCloses, 0);
  assert.deepEqual(fixture.segments, []);
});

test('pre-aborted capture never requests microphone permission', async context => {
  const fixture = captureFixture(context), controller = new AbortController();
  fixture.media.getUserMedia = async () => assert.fail('permission must not be requested');
  controller.abort();
  await assert.rejects(startModeratorLiveCapture(fixture.config, fixture.callbacks, controller.signal), { name: 'AbortError' });
  assert.equal(fixture.intervals.size, 0);
});

test('abort during permission invocation rejects before a late stream settles', async context => {
  const fixture = captureFixture(context), permission = deferred<MediaStream>(), controller = new AbortController();
  fixture.media.getUserMedia = () => { controller.abort(); return permission.promise; };
  await assert.rejects(startModeratorLiveCapture(fixture.config, fixture.callbacks, controller.signal), { name: 'AbortError' });
  assert.equal(fixture.intervals.size, 0);
  permission.resolve(fixture.stream);
  await settle();
  assert.equal(fixture.counts().trackStops, 1);
});

test('abort during display permission releases microphone and late display tracks', async context => {
  const fixture = captureFixture(context, { sourceMode: 'both' }), permission = deferred<MediaStream>(), controller = new AbortController();
  fixture.media.getDisplayMedia = () => permission.promise;
  const capture = startModeratorLiveCapture(fixture.config, fixture.callbacks, controller.signal);
  await settle();
  controller.abort();
  await assert.rejects(capture, { name: 'AbortError' });
  permission.resolve(fixture.stream);
  await settle();
  assert.equal(fixture.counts().trackStops, 2);
  assert.equal(fixture.intervals.size, 0);
});

test('stop aborts pending HTTP, clears timers, and suppresses late transcription and manual batches', async context => {
  const fixture = captureFixture(context), response = deferred<Response>();
  let requestSignal: AbortSignal | undefined;
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { requestSignal = init.signal as AbortSignal; return response.promise; });
  const handle = await startModeratorLiveCapture(fixture.config, fixture.callbacks);
  fixture.feed();
  const lateAudio = fixture.processor.onaudioprocess!, lateTick = [...fixture.intervals.values()][0]!;
  handle.stop(); handle.stop();
  assert.equal(requestSignal?.aborted, true);
  assert.equal(fixture.timeouts.size + fixture.intervals.size, 0);
  assert.equal(fixture.processor.onaudioprocess, null);
  response.resolve(new Response(JSON.stringify({ text: 'late transcript' })));
  await settle(); lateTick(); lateAudio({} as AudioProcessingEvent);
  assert.equal(handle.flushNow(), null);
  assert.deepEqual(fixture.segments, []); assert.deepEqual(fixture.batches, []); assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.counts(), { trackStops: 1, audioCloses: 1, disconnects: 1, restarts: 0 });
});

test('stop while response JSON is pending fences late segments and errors', async context => {
  const fixture = captureFixture(context), body = deferred<{ text: string }>();
  context.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: () => body.promise }));
  const handle = await startModeratorLiveCapture(fixture.config, fixture.callbacks);
  fixture.feed(); await settle(); handle.stop(); body.reject(new Error('late body failure'));
  await settle();
  assert.deepEqual(fixture.errors, []); assert.deepEqual(fixture.segments, []);
});

test('manual flush cannot emit buffered text when starting its request synchronously stops capture', async context => {
  const fixture = captureFixture(context);
  context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ text: 'buffered transcript' })));
  const handle = await startModeratorLiveCapture(fixture.config, fixture.callbacks);
  fixture.feed(); await settle();
  assert.equal(fixture.segments.length, 1);
  assert.deepEqual(fixture.batches, []);
  fixture.feed(8000);
  context.mock.method(globalThis, 'fetch', async () => { handle.stop(); throw new Error('cancelled request'); });
  assert.equal(handle.flushNow(), null);
  await settle();
  assert.deepEqual(fixture.batches, []); assert.deepEqual(fixture.errors, []);
});

test('Whisper drops busy windows, bounds oversized input, and only resumes after deadline settlement', async context => {
  const fixture = captureFixture(context), response = deferred<Response>();
  const requests: RequestInit[] = [];
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { requests.push(init); return response.promise; });
  const handle = await startModeratorLiveCapture(fixture.config, fixture.callbacks);
  fixture.feed(16000 * 12); fixture.feed(); fixture.feed(); handle.flushNow();
  assert.equal(requests.length, 1);
  const file = (requests[0]!.body as FormData).get('file') as Blob;
  assert.equal(file.size, 44 + 16000 * 6 * 2);
  const deadline = [...fixture.timeouts.values()][0]!;
  assert.equal(deadline.delay, 20_000); deadline.callback();
  assert.equal(requests[0]!.signal?.aborted, true);
  fixture.feed(); assert.equal(requests.length, 1);
  response.reject(new Error('deadline')); await settle();
  assert.equal(fixture.errors.length, 1);
  assert.equal(fixture.timeouts.size, 0);
  context.mock.method(globalThis, 'fetch', async () => { requests.push({}); return new Response(JSON.stringify({ text: 'resumed' })); });
  fixture.feed(); await settle();
  assert.equal(requests.length, 2); assert.equal(fixture.segments.length, 1);
  handle.stop();
});

test('WebSocket pressure drops packets and stopped socket handlers cannot emit', async context => {
  const fixture = captureFixture(context, { provider: 'deepgram-ws' });
  const handle = await startModeratorLiveCapture(fixture.config, fixture.callbacks), socket = fixture.sockets[0]!;
  socket.bufferedAmount = 256 * 1024; fixture.feed(4096);
  assert.equal(socket.sent.length, 0);
  socket.bufferedAmount = 256 * 1024 - 8192; fixture.feed(4096);
  assert.equal(socket.sent.length, 1);
  const lateMessage = socket.onmessage!, lateError = socket.onerror!;
  handle.stop();
  lateMessage({ data: JSON.stringify({ channel: { alternatives: [{ transcript: 'late' }] }, is_final: true }) }); lateError();
  assert.equal(socket.closed, true); assert.equal(socket.onmessage, null);
  assert.deepEqual(fixture.segments, []); assert.deepEqual(fixture.errors, []);
});

test('SpeechRecognition stop detaches callbacks and prevents late restart and manual flush', async context => {
  const fixture = captureFixture(context, { provider: 'web-speech' });
  const handle = await startModeratorLiveCapture(fixture.config, fixture.callbacks), recognition = fixture.recognitions[0]!;
  const lateResult = recognition.onresult!, lateEnd = recognition.onend!;
  const result = Object.assign([{ transcript: 'speech' }], { isFinal: true });
  lateResult({ resultIndex: 0, results: [result] });
  assert.equal(fixture.segments.length, 1);
  handle.stop(); lateResult({ resultIndex: 0, results: [result] }); lateEnd();
  assert.equal(handle.flushNow(), null); assert.equal(recognition.aborted, true);
  assert.equal(recognition.onresult, null); assert.equal(fixture.counts().restarts, 1);
  assert.equal(fixture.segments.length, 1); assert.deepEqual(fixture.batches, []);
});

test('startup failure after audio allocation cleans all acquired resources', async context => {
  const fixture = captureFixture(context, { provider: 'deepgram-ws' });
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: class { constructor() { throw new Error('socket setup failed'); } } });
  await assert.rejects(startModeratorLiveCapture(fixture.config, fixture.callbacks), /socket setup failed/);
  assert.equal(fixture.intervals.size, 0);
  assert.deepEqual(fixture.counts(), { trackStops: 1, audioCloses: 1, disconnects: 1, restarts: 0 });
});
