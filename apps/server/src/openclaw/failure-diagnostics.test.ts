import assert from 'node:assert/strict';
import test from 'node:test';
import { enrichGatewayHistoryFailuresFromRawTranscript, sanitizeFailureReason } from './failure-diagnostics.js';

test('enriches sanitized gateway assistant failure from matching local raw transcript row', () => {
  const rows = enrichGatewayHistoryFailuresFromRawTranscript([
    { id: 'u1', role: 'user', text: 'please run' },
    { id: 'a1', role: 'assistant', status: 'failed', text: 'Assistant turn failed before producing content.' },
  ], [
    { id: 'a1', role: 'assistant', status: 'failed', errorMessage: 'OpenAI API error (400): encrypted content could not be verified' },
  ]);

  assert.equal(rows[0].role, 'user');
  assert.equal(rows[1].failureReason, 'OpenAI API error (400): encrypted content could not be verified');
  assert.equal(rows[1].errorMessage, 'OpenAI API error (400): encrypted content could not be verified');
});

test('keeps generic fallback when local raw transcript has no usable failure details', () => {
  const gateway = [{ id: 'a1', role: 'assistant', status: 'failed', text: 'Assistant turn failed before producing content.' }];
  const rows = enrichGatewayHistoryFailuresFromRawTranscript(gateway, [
    { id: 'a1', role: 'assistant', status: 'failed' },
  ]);

  assert.equal(rows[0].failureReason, undefined);
  assert.equal(rows[0].errorMessage, undefined);
});

test('does not replace normal assistant messages or existing structured gateway reasons', () => {
  const rows = enrichGatewayHistoryFailuresFromRawTranscript([
    { id: 'ok', role: 'assistant', status: 'sent', text: 'done' },
    { id: 'failed', role: 'assistant', status: 'failed', text: 'Assistant turn failed before producing content.', errorMessage: 'gateway reason' },
  ], [
    { id: 'ok', role: 'assistant', status: 'failed', errorMessage: 'should not overwrite normal text' },
    { id: 'failed', role: 'assistant', status: 'failed', errorMessage: 'raw reason' },
  ]);

  assert.equal(rows[0].text, 'done');
  assert.equal(rows[0].failureReason, undefined);
  assert.equal(rows[1].errorMessage, 'gateway reason');
  assert.equal(rows[1].failureReason, undefined);
});

test('assigns duplicate retry failures by exact row key then stable ordinal fallback', () => {
  const rows = enrichGatewayHistoryFailuresFromRawTranscript([
    { id: 'retry-1', role: 'assistant', status: 'failed', text: 'Assistant turn failed before producing content.' },
    { id: 'retry-2', role: 'assistant', status: 'failed', text: 'Assistant turn failed before producing content.' },
    { role: 'assistant', status: 'failed', text: 'Assistant turn failed before producing content.' },
  ], [
    { id: 'retry-1', role: 'assistant', status: 'failed', errorMessage: 'first failure' },
    { id: 'retry-2', role: 'assistant', status: 'failed', errorMessage: 'second failure' },
    { role: 'assistant', status: 'failed', errorMessage: 'third failure' },
  ]);

  assert.deepEqual(rows.map((row) => row.failureReason), ['first failure', 'second failure', 'third failure']);
});

test('sanitizes and bounds sensitive diagnostic details before display', () => {
  const secretBlob = 'A'.repeat(140);
  const reason = sanitizeFailureReason(`OpenAI API error (400): token=sk-super-secret Authorization: Bearer abc.def.ghi encrypted content ${secretBlob} request={"body":"secret"} ` + 'x'.repeat(700));

  assert.ok(reason);
  assert.ok(reason.length <= 500, reason);
  assert.match(reason, /OpenAI API error \(400\)/);
  assert.match(reason, /token: \[redacted\]/);
  assert.match(reason, /Authorization: \[redacted\]/i);
  assert.match(reason, /encrypted content \[redacted\]/);
  assert.doesNotMatch(reason, /sk-super-secret|abc\.def\.ghi|AAAAAAAAAAAAAAAA/);
});
