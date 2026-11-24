import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserDiagnostics } from './browser-diagnostics.js';

test('default errors, explicit debug and off never retain a previous detail level', () => {
  const d = createBrowserDiagnostics();
  d.record('request-ok'); d.record('request-cancelled'); d.record('stream-connected');
  assert.deepEqual(d.read(), []);
  d.record('request-http', { status: 503 }); assert.equal(d.read().length, 1);
  d.setLevel('debug'); assert.deepEqual(d.read(), []);
  d.record('request-ok'); assert.equal(d.read().length, 1);
  d.setLevel('off'); d.record('request-failed'); assert.deepEqual(d.read(), []);
  d.setLevel('private-secret' as 'debug'); assert.equal(d.level(), 'off');
});

test('event and field allowlists reject arbitrary text and nonfinite numbers at runtime', () => {
  const d = createBrowserDiagnostics(); d.setLevel('debug');
  d.record('private-path-and-cookie' as 'request-ok', { status: 200 });
  d.record('request-ok', { status: 200, elapsedMs: Infinity, retryMs: NaN, attempts: -1, mutation: true,
    url: 'https://private/path', error: 'cookie-secret', body: 'private-message' } as never);
  d.record('request-failed', { status: 'secret' as never, mutation: 'secret' as never, elapsedMs: 1e10 });
  assert.deepEqual(d.read().map(e => e.facts), [{ status: 200, attempts: 0, mutation: true }, { elapsedMs: 3_600_000 }]);
  assert.doesNotMatch(JSON.stringify(d.read()), /private|cookie|secret|Infinity|NaN/);
});

test('retention and exports are bounded, copied and clearable; preferences only notify on change', () => {
  const d = createBrowserDiagnostics(); let changes = 0;
  const unsubscribe = d.subscribe(() => changes++);
  d.setLevel('debug');
  for (let i = 0; i < 1000; i++) d.record('stream-retry', { attempts: i });
  assert.equal(changes, 1, 'recording traffic must not rerender settings');
  d.setLevel('debug'); assert.equal(changes, 1, 'unchanged level must preserve records and avoid rerenders');
  const rows = d.read(); assert.equal(rows.length, 160); assert.equal(rows[0]!.sequence, 841);
  rows[0]!.facts.attempts = 12345; rows.pop(); assert.equal(d.read()[0]!.facts.attempts, 840);
  d.clear(); assert.deepEqual(d.read(), []);
  d.record('request-ok'); assert.equal(d.read()[0]!.sequence, 1);
  unsubscribe(); d.setLevel('off'); assert.equal(changes, 1);
});
