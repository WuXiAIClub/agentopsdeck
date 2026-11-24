import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

// Endpoint event order helps distinguish a client close from upstream failure.
// Pipeline destroys both endpoints after either failure, so final destroyed
// flags alone cannot identify the initiating side. These are observations, not
// root-cause or completion authority; keep the original rejected pipeline.
export function jointForwardingLifecycle(destination) {
  const observation = { sourceAttached: false, upstreamEnded: false,
    upstreamClosed: false, upstreamErrored: false, downstreamFinished: false,
    downstreamClosed: false, downstreamErrored: false, firstAbnormal: null };
  const listeners = [];
  let disposed = false;
  const abnormal = label => { observation.firstAbnormal ??= label; };
  const listen = (stream, event, callback) => {
    stream.once(event, callback);
    listeners.push([stream, event, callback]);
  };
  listen(destination, 'finish', () => { observation.downstreamFinished = true; });
  listen(destination, 'error', () => { observation.downstreamErrored = true; abnormal('downstream-error'); });
  listen(destination, 'close', () => {
    observation.downstreamClosed = true;
    if (!observation.downstreamFinished) abnormal('downstream-close-before-finish');
  });
  return {
    observation,
    attachSource(source) {
      if (disposed || observation.sourceAttached) throw new Error('Forwarding source observation already bound or disposed');
      observation.sourceAttached = true;
      listen(source, 'end', () => { observation.upstreamEnded = true; });
      listen(source, 'error', () => { observation.upstreamErrored = true; abnormal('upstream-error'); });
      listen(source, 'close', () => {
        observation.upstreamClosed = true;
        if (!observation.upstreamEnded) abnormal('upstream-close-before-end');
      });
      return source;
    },
    dispose() {
      disposed = true;
      for (const [stream, event, callback] of listeners) stream.removeListener(event, callback);
      listeners.length = 0;
    },
  };
}

// Transparent, bounded SSE observation. Retain structural counters only, never
// model text, error messages, credentials, response ids or full frames. This is
// diagnostic evidence, NOT permission to forgive a failed transport pipeline.
export function jointForwardingObserver() {
  const observation = { bytes: 0, chunks: 0, sourceEnded: false,
    completedFrames: 0, failedFrames: 0, incompleteFrames: 0, oversizedFrames: 0 };
  const decoder = new StringDecoder('utf8');
  const maximum = 65_536;
  let line = '', event = '', data = '', oversized = false;
  function consumeLine() {
    if (!line) {
      if (oversized) observation.oversizedFrames++;
      else if (data) {
        try {
          const value = JSON.parse(data);
          // Responses streams can carry the event type only in their data.
          // An explicit, conflicting SSE event must not be reinterpreted, and
          // these counters never turn a rejected pipeline into a successful one.
          const type = event || value?.type;
          if (['response.completed', 'response.failed', 'response.incomplete'].includes(type)
            && value?.type === type && value.response?.status === type.slice('response.'.length)) {
            observation[type === 'response.completed' ? 'completedFrames'
              : type === 'response.failed' ? 'failedFrames' : 'incompleteFrames']++;
          }
        } catch { /* Invalid/partial frames are never completion evidence. */ }
      }
      event = ''; data = ''; oversized = false;
    } else if (!oversized) {
      if (line.startsWith('event:')) event = line.slice(6).trimStart();
      if (line.startsWith('data:')) {
        if (data.length + line.length > maximum) { data = ''; oversized = true; }
        else data += (data ? '\n' : '') + line.slice(5).replace(/^ /, '');
      }
    }
    line = '';
  }
  function consume(text) {
    for (const char of text) {
      if (char === '\n') { if (line.endsWith('\r')) line = line.slice(0, -1); consumeLine(); }
      else if (line.length < maximum) line += char;
      else { oversized = true; data = ''; }
    }
  }
  const stream = new Transform({
    transform(chunk, encoding, callback) {
      observation.bytes += chunk.length; observation.chunks++;
      consume(decoder.write(chunk)); callback(null, chunk);
    },
    flush(callback) {
      consume(decoder.end()); observation.sourceEnded = true;
      line = ''; event = ''; data = ''; callback();
    },
    destroy(error, callback) { line = ''; event = ''; data = ''; callback(error); },
  });
  return { stream, observation };
}

// Never stringify a provider error, its message, body, request or cause. Even
// error names/codes are untrusted; record only explicitly recognized constants.
export function jointForwardingDiagnostic(error, observation = {}) {
  const names = ['Error', 'TypeError', 'AbortError', 'TimeoutError', 'AssertionError'];
  const codes = ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET',
    'UND_ERR_ABORTED', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ERR_STREAM_PREMATURE_CLOSE'];
  const bounded = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : null;
  return {
    ordinal: bounded(observation.ordinal), elapsedMs: bounded(observation.elapsedMs),
    status: Number.isInteger(observation.status) && observation.status >= 100 && observation.status <= 599 ? observation.status : null,
    phase: ['connecting', 'streaming', 'complete'].includes(observation.phase) ? observation.phase : 'unknown',
    responseDestroyed: observation.responseDestroyed === true,
    responseFinished: observation.responseFinished === true,
    name: names.includes(error?.name) ? error.name : 'Other',
    code: codes.includes(error?.code) ? error.code : null,
    causeCode: codes.includes(error?.cause?.code) ? error.cause.code : null,
  };
}
