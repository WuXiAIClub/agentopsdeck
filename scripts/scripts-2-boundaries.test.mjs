import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { runtimeOptions } from './start-workspace-browser.mjs';
import { parseSuccessfulSummary, recordStrictBatch } from './verify-full-source-batches.mjs';

test('isolated browser requires a proven positive integer UID before loading Chromium', () => {
  const environment = { AOD_BROWSER_EGRESS_ISOLATED: 'true' };
  for (const uid of [undefined, null, '1000', NaN, Infinity, 0, -1, 1.5]) {
    assert.throws(() => runtimeOptions(environment, uid), /non-root/);
  }
  assert.equal(runtimeOptions(environment, 1000).chromiumSandbox, true);
});

test('full-source TAP summaries reject malformed, fractional and overflowing counts', () => {
  const summary = '# tests 3\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n# duration_ms 1.5\n';
  assert.equal(parseSuccessfulSummary(summary).duration_ms, 1.5);
  for (const invalid of [
    summary.replace('duration_ms 1.5', 'duration_ms 1..5'),
    summary.replace('duration_ms 1.5', 'duration_ms ' + '9'.repeat(400)),
    summary.replace('suites 0', 'suites 0.5'),
    summary.replace('suites 0', 'suites 9007199254740992'),
    summary.replace('tests 3', 'tests 2.5').replace('pass 2', 'pass 1.5'),
  ]) {
    assert.throws(() => parseSuccessfulSummary(invalid));
    const result = { attempts: [], batches: [] };
    assert.equal(recordStrictBatch(result, { files: ['fixture.test.ts'], code: 0, signal: null }, invalid), false);
    assert.equal(result.batches.length, 0);
    assert.ok(result.attempts[0].validationError);
  }
});

test('layered-permissions failure evidence emits only bounded source coordinates', async () => {
  const source = await readFile(new URL('./verify-candidate-layered-permissions.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /result\.errors\.push\([^\n]*error\.(?:message|stack)/);
  const expression = source.match(/result\.failureLocation = ([\s\S]*?);\n/)[1];
  const privateText = 'synthetic-private-login-value';
  const stack = `Error: ${privateText}\n` +
    Array.from({ length: 20 }, () => `at ${privateText} (/synthetic/${privateText}/verify-candidate-layered-permissions.mjs:431:2)`).join('\n');
  const evidence = runInNewContext(expression, { error: { stack } });
  assert.equal(evidence.length, 8);
  assert.ok(evidence.every(location => location === 'verify-candidate-layered-permissions.mjs:431:2'));
  assert.doesNotMatch(JSON.stringify(evidence), /synthetic-private|\/synthetic/);
  assert.equal(runInNewContext(expression, { error: null }).length, 0);
});

test('stream failure evidence bounds content before traversal and admits only numeric indexes', async context => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-stream-shapes-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const compiled = join(root, 'compiled');
  await mkdir(join(compiled, 'claude'), { recursive: true });
  await writeFile(join(compiled, 'package.json'), '{"type":"module"}');
  await writeFile(join(compiled, 'claude/stream-delivery.js'),
    'export class ClaudeStreamDelivery { async send() { throw new Error("synthetic-failure"); } }');
  const preload = new URL('./lib/sdk-probe-stream-shapes.mjs', import.meta.url);
  preload.searchParams.set('root', root);
  preload.searchParams.set('compiled', compiled);
  await import(preload.href);
  const { ClaudeStreamDelivery } = await import(pathToFileURL(join(compiled, 'claude/stream-delivery.js')).href);
  const delivery = new ClaudeStreamDelivery();
  const content = Array.from({ length: 256 }, () => ({ type: 'text', text: 'synthetic-private-text' }));
  Object.defineProperty(content, 256, { get() { assert.fail('Out-of-budget block traversed'); } });
  for (const index of [{ private: 'synthetic-private-index' }, 'synthetic-private-index', -1, 256, 1.5, Infinity, 0, 255]) {
    await assert.rejects(delivery.send({ type: 'assistant', event: { type: 'content_block_start', index },
      message: { content } }), /synthetic-failure/);
  }
  const evidence = await readFile(join(root, `claude-stream-failure-${process.pid}.json`), 'utf8');
  assert.doesNotMatch(evidence, /synthetic-private|synthetic-failure/);
  const shapes = JSON.parse(evidence);
  assert.ok(shapes.slice(0, 6).every(shape => !Object.hasOwn(shape, 'index')));
  assert.deepEqual(shapes.slice(-2).map(shape => shape.index), [0, 255]);
  assert.ok(shapes.every(shape => shape.content.length === 256));
  for (let index = 0; index < 70; index++) await assert.rejects(delivery.send({ type: 'other' }), /synthetic-failure/);
  assert.equal(JSON.parse(await readFile(join(root, `claude-stream-failure-${process.pid}.json`), 'utf8')).length, 64);
});
