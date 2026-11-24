import { Transform } from 'node:stream';

// Acceptance-only provider adapter, NOT a production transport repair. Some
// native clients stop reading at response.completed rather than HTTP EOF. Keep
// their terminal frame behind the ORIGINAL source EOF so strict pipeline and
// source-end evidence remain independently testable. Never synthesize frames,
// forgive a rejected pipeline, or release a terminal after an upstream failure.
export function jointCompletionEofFence() {
  const maximum = 65_536;
  let buffer = Buffer.alloc(maximum), offset = 0, lineStart = 0, frameStart = 0;
  const observation = { sourceEnded: false, completedFrames: 0,
    terminalReleased: false, peakBufferedBytes: 0 };
  const invalid = () => new Error('Acceptance EOF fence rejected stream; payload omitted');
  function frame(stream) {
    const text = buffer.subarray(frameStart, offset).toString('utf8');
    const lines = text.split(/\r?\n/);
    const events = lines.filter(line => line.startsWith('event:')).map(line => line.slice(6).trimStart());
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (events.length > 1) throw invalid();
    if (observation.completedFrames) {
      // Only a transport trailer or keepalive may follow the complete event.
      if (events.length || data && data !== '[DONE]') throw invalid();
      frameStart = offset;
      return;
    }
    if (data === '[DONE]') throw invalid();
    if (data) {
      let value;
      try { value = JSON.parse(data); } catch { throw invalid(); }
      const type = events[0] || value?.type;
      if (events.length && value?.type !== type) throw invalid();
      if (type === 'response.failed' || type === 'response.incomplete') throw invalid();
      if (type === 'response.completed') {
        if (value?.type !== type || value.response?.status !== 'completed') throw invalid();
        observation.completedFrames++;
        frameStart = offset;
        return;
      }
    } else if (events.some(type => type.startsWith('response.'))) throw invalid();
    stream.push(Buffer.from(buffer.subarray(0, offset)));
    offset = 0; lineStart = 0; frameStart = 0;
  }
  const stream = new Transform({
    transform(chunk, encoding, callback) {
      try {
        for (const byte of chunk) {
          if (offset >= maximum) throw invalid();
          buffer[offset++] = byte;
          observation.peakBufferedBytes = Math.max(observation.peakBufferedBytes, offset);
          if (byte === 10) {
            const blank = offset - lineStart === 1 || offset - lineStart === 2 && buffer[lineStart] === 13;
            if (blank) frame(this);
            lineStart = offset;
          }
        }
        callback();
      } catch (error) { callback(error); }
    },
    flush(callback) {
      try {
        // A truncated frame after an otherwise valid completion still fails.
        if (observation.completedFrames !== 1 || buffer.subarray(frameStart, offset).toString('utf8').trim()) throw invalid();
        observation.sourceEnded = true;
        this.push(Buffer.from(buffer.subarray(0, offset)));
        observation.terminalReleased = true;
        callback();
      } catch (error) { callback(error); }
    },
    destroy(error, callback) { buffer.fill(0); buffer = null; callback(error); },
  });
  return { stream, observation };
}
