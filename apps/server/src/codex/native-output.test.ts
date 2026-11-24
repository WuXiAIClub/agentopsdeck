import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough, Readable } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { CodexNativeObservations } from './native-observations.js';
import { consumeCodexOutput, codexOutputFrameLimit } from './native-output.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('Codex output backpressures mixed notification bursts without losing FIFO or latching unavailable', async () => {
  const observations = new CodexNativeObservations({ unavailable: () => assert.fail('unexpected veto'),
    diagnostics: new PerformanceDiagnostics(() => {}) });
  const input = new PassThrough({ highWaterMark: 1024 }), hold = deferred();
  const seen: number[] = [];
  let received = 0, peak = 0;
  const stream = consumeCodexOutput(input, {
    receive(line) {
      const event = JSON.parse(line);
      received++;
      assert.equal(observations.accept(async () => {
        if (event.index === 0) await hold.promise;
        seen.push(event.index);
      }, Buffer.byteLength(line), 1), true);
      peak = Math.max(peak, observations.status().pending);
    },
    holdIngress: () => observations.holdIngress(),
    pressure: () => observations.pressure(),
  });
  const events = Array.from({ length: 4096 }, (_, index) => JSON.stringify({ index,
    method: index % 2 ? 'item/started' : 'item/completed', threadId: 'original' }));
  input.end(events.join('\n') + '\n');
  await tick();
  assert.equal(received, 64);
  assert.equal(observations.status().failed, false);
  assert.throws(() => observations.assertEffectAllowed(), /pending/);
  hold.resolve();
  await stream;
  await observations.drain();
  assert.deepEqual(seen, events.map((_, index) => index));
  assert.ok(peak <= 64);
  observations.assertEffectAllowed();
  await observations.close();
});

test('Codex output preserves split UTF-8, CRLF, empty lines and unterminated final replies', async () => {
  const text = Buffer.from('你好\r\n\n{"id":1,"result":"回复"}');
  const seen: string[] = [];
  await consumeCodexOutput(Readable.from([...text].map(value => Buffer.from([value]))), {
    receive: line => { seen.push(line); }, holdIngress: () => () => {}, pressure: () => undefined,
  });
  assert.deepEqual(seen, ['你好', '', '{"id":1,"result":"回复"}']);
});

test('Codex output retains the ingress fence across a capacity wait and releases it on error', async () => {
  const observations = new CodexNativeObservations({ unavailable: () => assert.fail('unexpected veto') });
  const hold = deferred();
  let waiting = true;
  const stream = consumeCodexOutput(Readable.from(['first\nsecond\n']), {
    receive() { throw new Error('synthetic receiver failure'); },
    holdIngress: () => observations.holdIngress(),
    pressure: () => waiting ? hold.promise : undefined,
  });
  const rejected = assert.rejects(stream, /synthetic receiver failure/);
  await tick();
  await assert.rejects(observations.beforeEffect(), /pending/);
  waiting = false; hold.resolve();
  await rejected;
  observations.assertEffectAllowed();
  await observations.close();
});

test('Codex output pressure rejection keeps the original failure and releases the ingress fence', async () => {
  const observations = new CodexNativeObservations({ unavailable: () => assert.fail('unexpected veto') });
  await assert.rejects(consumeCodexOutput(Readable.from(['unread\n']), {
    receive() { assert.fail('must not consume after pressure failure'); },
    holdIngress: () => observations.holdIngress(),
    pressure: () => Promise.reject(new Error('synthetic pressure failure')),
  }), /synthetic pressure failure/);
  observations.assertEffectAllowed();
  await observations.close();
});

test('Codex output destruction waits for the physical pressure owner without consuming buffered successors', async () => {
  const observations = new CodexNativeObservations({ unavailable: () => assert.fail('unexpected veto') });
  const input = new PassThrough(), hold = deferred();
  let finished = false;
  const stream = consumeCodexOutput(input, {
    receive() { assert.fail('destroyed transport must not receive buffered successors'); },
    holdIngress: () => observations.holdIngress(),
    pressure: () => hold.promise,
  });
  const rejected = assert.rejects(stream, /synthetic input failure/).then(() => { finished = true; });
  input.write('unread\n');
  await tick();
  input.destroy(new Error('synthetic input failure'));
  await tick();
  assert.equal(finished, false);
  assert.throws(() => observations.assertEffectAllowed(), /pending/);
  hold.resolve();
  await rejected;
  observations.assertEffectAllowed();
  await observations.close();
});

for (const framing of ['complete', 'unterminated', 'fragmented'] as const) {
  test(`Codex rejects ${framing} oversized frames without decoding or receiving partial output`, async () => {
    const input = new PassThrough();
    let held = 0;
    const seen: string[] = [];
    const stream = consumeCodexOutput(input, {
      receive: line => { seen.push(line); },
      holdIngress: () => { held++; return () => { held--; }; }, pressure: () => undefined,
    });
    const rejected = assert.rejects(stream, { message: 'Codex output frame exceeded its byte budget' });
    if (framing === 'fragmented') {
      const fragment = Buffer.alloc(1024, 97);
      for (let index = 0; index < codexOutputFrameLimit / fragment.length; index++) input.write(fragment);
      assert.equal(held, 0);
      assert.equal(input.destroyed, false);
      input.write(Buffer.from('x\nignored-successor\n'));
    } else if (framing === 'complete') {
      input.end(Buffer.concat([Buffer.alloc(codexOutputFrameLimit + 1, 97), Buffer.from('\nignored-successor\n')]));
    } else input.write(Buffer.alloc(codexOutputFrameLimit + 1, 97));
    await rejected;
    assert.equal(input.destroyed, true);
    assert.equal(held, 0);
    assert.deepEqual(seen, []);
  });
}

test('Codex frame budget counts original UTF-8 bytes and resets only at frame boundaries', async () => {
  const reply = '🙂'.repeat(codexOutputFrameLimit / 4);
  const encoded = Buffer.from(reply);
  const seen: string[] = [];
  await consumeCodexOutput(Readable.from([encoded.subarray(0, 1), encoded.subarray(1, 3), encoded.subarray(3),
    Buffer.from('\nnext\r\n'), encoded]), {
    receive: line => { seen.push(line); }, holdIngress: () => () => {}, pressure: () => undefined,
  });
  assert.deepEqual(seen, [reply, 'next', reply]);
  await assert.rejects(consumeCodexOutput(Readable.from([encoded, Buffer.from('a')]), {
    receive: () => assert.fail('over-budget UTF-8 frame must not be received'),
    holdIngress: () => () => {}, pressure: () => undefined,
  }), /byte budget/);
});

test('Codex oversized frame fails before requesting downstream capacity', async () => {
  let releases = 0;
  await assert.rejects(consumeCodexOutput(Readable.from([Buffer.alloc(codexOutputFrameLimit + 1)]), {
    receive: () => assert.fail('must not receive oversized frame'),
    holdIngress: () => () => { releases++; }, pressure: () => { assert.fail('must reject before pressure wait'); },
  }), /byte budget/);
  assert.equal(releases, 1);
});
