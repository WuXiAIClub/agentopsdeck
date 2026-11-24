import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatMessageTimestamp } from './message-time.js';

test('formats same-day message timestamps as HH:mm', () => {
  const sentAt = new Date(2026, 6, 11, 9, 5).getTime();
  const now = new Date(2026, 6, 11, 22, 27).getTime();

  assert.equal(formatMessageTimestamp(sentAt, now), '09:05');
});

test('formats cross-day message timestamps with month, day, and time', () => {
  const sentAt = new Date(2026, 6, 10, 23, 59).getTime();
  const now = new Date(2026, 6, 11, 0, 1).getTime();

  assert.match(formatMessageTimestamp(sentAt, now), /07[/-]10\s+23:59/);
});

test('does not invent a timestamp for invalid message data', () => {
  assert.equal(formatMessageTimestamp(Number.NaN, new Date(2026, 6, 11).getTime()), '');
});
