import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { drainNativeDiagnostics } from './native-diagnostics.js';

test('native stderr drains oversized unframed diagnostics without retaining or logging their text', context => {
  for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    context.mock.method(console, method, () => assert.fail('native diagnostics must not be logged'));
  }
  const input = new PassThrough(), diagnostics = drainNativeDiagnostics(input);
  input.write('Authorization: Bearer synthetic-private-diagnostic');
  assert.equal(diagnostics.exceeded(), false);
  for (let index = 0; index < 128; index++) input.write(Buffer.alloc(64 * 1024, 97));
  assert.equal(diagnostics.bytes(), 64 * 1024 + 1);
  assert.equal(diagnostics.exceeded(), true);
  assert.equal(input.readableLength, 0);
  assert.deepEqual(Object.keys(diagnostics).sort(), ['bytes', 'exceeded']);
  input.emit('error', new Error('synthetic-private-stream-error'));
  input.end();
});

test('native diagnostic budgets count UTF-8 bytes and saturate at one byte over the limit', () => {
  const input = new PassThrough(), diagnostics = drainNativeDiagnostics(input, 8);
  input.setEncoding('utf8');
  input.write('🙂🙂');
  assert.equal(diagnostics.bytes(), 8);
  assert.equal(diagnostics.exceeded(), false);
  input.write('🙂');
  input.write(Buffer.alloc(1024));
  assert.equal(diagnostics.bytes(), 9);
  assert.equal(diagnostics.exceeded(), true);
  input.end();
});
