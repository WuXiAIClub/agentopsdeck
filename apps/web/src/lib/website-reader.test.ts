import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { WebsiteSnapshot } from '@agentopsdeck/shared';
import { READER_LINE_LENGTH, READER_PAGE_LINES, websiteCitation, websiteReadingLines, websiteReadingMatches, websiteSnapshotDigest } from './website-reader.js';

const snapshot: WebsiteSnapshot = { serviceId: 'site', label: 'Development site', format: 'text', content: 'hello\n世界', fetchedAt: 1_800_000_000_000 };
test('reading projection preserves newlines and Unicode with bounded lines and DOM pages', () => {
  assert.deepEqual(websiteReadingLines('one\r\ntwo\rthree\n'), ['one', 'two', 'three', '']);
  const text = 'a'.repeat(READER_LINE_LENGTH - 1) + '😀' + 'z'.repeat(500_000);
  const lines = websiteReadingLines(text);
  assert.equal(lines.join(''), text);
  assert.ok(lines.every(line => line.length <= READER_LINE_LENGTH && !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(line)));
  assert.equal(lines.slice(0, READER_PAGE_LINES).length, 40);
  assert.throws(() => websiteReadingLines('x'.repeat(600_000)));
});

test('search is literal, bounded and case insensitive; no regex execution', () => {
  const lines = ['Hello world', '[.*] #id', '世界 hello', 'last'];
  assert.deepEqual(websiteReadingMatches(lines, ' HELLO '), [0, 2]);
  assert.deepEqual(websiteReadingMatches(lines, '.*'), [1]);
  assert.deepEqual(websiteReadingMatches(lines, '世界'), [2]);
  assert.deepEqual(websiteReadingMatches(lines, '  '), []);
  assert.deepEqual(websiteReadingMatches(['x'.repeat(160)], 'x'.repeat(100_000)), [0]);
});

test('citation records exact connection/service/time/projection and excerpt, not a capability URL', () => {
  const citation = websiteCitation(snapshot, 'node-1', ['hello', '世界'], 0, 1, 'a'.repeat(64));
  assert.deepEqual(citation, { kind: 'agentopsdeck-website-excerpt', version: 1,
    source: { connectionId: 'node-1', serviceId: 'site', label: 'Development site', fetchedAt: new Date(snapshot.fetchedAt).toISOString(), sha256: 'a'.repeat(64) },
    projection: 'semantic-lines-v1', firstLine: 1, lastLine: 2, excerpt: 'hello\n世界' });
  assert.equal(websiteCitation(snapshot, 'node-1', ['hello'], 0, 0).source.sha256, null);
  assert.ok(!JSON.stringify(citation).includes('http'));
});

test('invalid excerpt ranges, identifiers and fingerprints fail closed', () => {
  for (const [first, last] of [[-1, 0], [1, 0], [0, 2], [0.5, 1], [NaN, 1], [0, Infinity]]) {
    assert.throws(() => websiteCitation(snapshot, 'node-1', ['a', 'b'], first!, last!));
  }
  assert.throws(() => websiteCitation(snapshot, 'https://private/?token=secret', ['a'], 0, 0));
  assert.throws(() => websiteCitation(snapshot, 'node-1', ['a'], 0, 0, 'not-a-fingerprint'));
});

test('oversize excerpts reject without silently truncating; full page remains separately readable', () => {
  const lines = Array.from({ length: 40 }, () => 'x'.repeat(1000));
  assert.throws(() => websiteCitation(snapshot, 'node-1', lines, 0, 8), /shorter/);
  assert.equal(websiteCitation(snapshot, 'node-1', lines, 0, 6).excerpt.length, 7006);
});

test('snapshot fingerprint is SHA-256 of versioned input format and exact source content', async () => {
  const digest = await websiteSnapshotDigest(snapshot);
  assert.equal(digest, createHash('sha256').update(JSON.stringify([snapshot.format, snapshot.content])).digest('hex'));
  assert.notEqual(digest, await websiteSnapshotDigest({ ...snapshot, content: snapshot.content + '!' }));
  assert.notEqual(digest, await websiteSnapshotDigest({ ...snapshot, format: 'html' }));
  assert.equal(digest, await websiteSnapshotDigest({ ...snapshot, fetchedAt: snapshot.fetchedAt + 1000 }));
});

test('unavailable fingerprint does not block reading or a clearly unhashed excerpt', async context => {
  context.mock.method(globalThis.crypto.subtle, 'digest', async () => { throw Error('Digest unavailable'); });
  const digest = await websiteSnapshotDigest(snapshot);
  assert.equal(digest, undefined);
  const lines = websiteReadingLines(snapshot.content);
  assert.equal(websiteCitation(snapshot, 'node-1', lines, 0, 1, digest).source.sha256, null);
  assert.deepEqual(websiteReadingMatches(lines, '世界'), [1]);
});
