import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compactToolHistoryContent, OMITTED_TOOL_IMAGE } from './tool-history-content.js';
import { CodexRolloutReader } from './rollout-reader.js';

test('tool image bytes are omitted without losing mixed text, errors or paths', () => {
  const input = [{ type: 'text', text: 'Screenshot at /tmp/a.png' },
    { type: 'image', data: 'A'.repeat(2_000_000), mimeType: 'image/png' },
    { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
    { type: 'image', source: { type: 'base64', data: 'AAAA' } },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
    { error: 'read failed', path: '/tmp/a.png' }];
  const compact = compactToolHistoryContent(input) as unknown[];
  assert.deepEqual(compact[0], input[0]); assert.deepEqual(compact[5], input[5]);
  assert.ok(JSON.stringify(compact).length < 1000);
  assert.equal((compact[1] as any).text, OMITTED_TOOL_IMAGE);
  assert.equal((input[1] as any).data.length, 2_000_000, 'native input stays untouched');
  assert.deepEqual(JSON.parse(compactToolHistoryContent(JSON.stringify(input)) as string), compact);
});

test('plain tool text, external image references and code remain intact', () => {
  for (const value of ['plain output', '{ not json', 'const value = 123;', 'A'.repeat(2000),
    { type: 'image_url', image_url: { url: 'https://example.invalid/image.png' } }, { path: '/tmp/a.png' }]) {
    assert.deepEqual(compactToolHistoryContent(value), value);
  }
  assert.equal(compactToolHistoryContent('prefix data:image/png;base64,AAAA suffix'), `prefix ${OMITTED_TOOL_IMAGE} suffix`);
});

test('rollout projection excludes image payloads before cache/storage, keeping call identity and native file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-tool-image-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'rollout.jsonl');
  const original = JSON.stringify({ type: 'response_item', timestamp: '2026-09-21T00:00:00Z',
    payload: { type: 'function_call_output', call_id: 'image-call', output: [{ type: 'input_image', image_url: `data:image/png;base64,${'A'.repeat(2_000_000)}` }] } }) + '\n';
  await writeFile(file, original);
  const reader = new CodexRolloutReader();
  const first = await reader.read(file);
  assert.ok(Buffer.byteLength(first) < 500);
  assert.equal(JSON.parse(first).payload.call_id, 'image-call');
  assert.match(first, /Image payload omitted/);
  assert.equal(await reader.read(file), first);
  assert.equal(await readFile(file, 'utf8'), original);
});
