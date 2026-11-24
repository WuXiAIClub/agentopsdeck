import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('src/components/messages.tsx', `file://${process.cwd()}/`), 'utf8');

test('message bubbles render a timestamp from each message createdAt field', () => {
  assert.match(source, /<MessageTimestamp createdAt=\{message\.createdAt\}[^>]+variant="mobile"/);
  assert.match(source, /<MessageTimestamp createdAt=\{message\.createdAt\}[^>]+variant="legacy"/);
  assert.match(source, /<MessageTimestamp createdAt=\{message\.createdAt\}[^>]+variant="desktop"/);
});

test('timestamp component is subtle and right-aligned', () => {
  assert.match(source, /text-right/);
  assert.match(source, /text-\[0\.62rem\]/);
  assert.match(source, /message-timestamp/);
});

test('all three bubbles place compact reading actions directly left of their timestamp', () => {
  const footers = source.match(/<footer className="message-footer">[\s\S]*?<\/footer>/g) ?? [];
  assert.equal(footers.length, 3);
  for (const footer of footers) assert.match(footer, /<MessageReadingActions[^>]*\/>\s*<MessageTimestamp/);
});
