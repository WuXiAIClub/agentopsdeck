import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAntigravityUsageReader, parseAntigravityUsage } from './usage.js';

const weekly = { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.975, reset_time: '2026-12-01T12:36:49Z' };
const fiveHours = { id: 'gemini-5h', window: '5h', remaining_fraction: 0, reset_time: null };
const payload = (...buckets: unknown[]) => JSON.stringify({ status: 'SUCCESS', response: 'do not project this text',
  command: { name: 'usage', data: { groups: [{ name: 'Gemini Models', description: 'do not project this text', buckets }] } } });

test('projects only structured quota fields and preserves exhausted and unknown values', () => {
  assert.deepEqual(parseAntigravityUsage(payload(weekly, fiveHours), 123), { sampledAt: 123, groups: [{ name: 'Gemini Models', windows: [
    { id: weekly.id, window: 'weekly', remainingFraction: 0.975, resetAt: Date.parse(weekly.reset_time) },
    { id: fiveHours.id, window: '5h', remainingFraction: 0, resetAt: null },
  ] }] });
  for (const invalid of ['not JSON', '{}', payload(weekly, weekly), payload({ ...weekly, remaining_fraction: 1.1 }),
    payload({ ...weekly, reset_time: 'tomorrow' }), payload({ ...weekly, window: '\u202e5h' })]) {
    assert.throws(() => parseAntigravityUsage(invalid, 123), { message: 'antigravity_usage_unavailable' });
  }
});

test('quota queries run in the verified private home and share one bounded cached result', { skip: process.platform !== 'linux' }, async context => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'aod-agy-usage-'));
  context.after(() => rm(homeDirectory, { recursive: true, force: true }));
  const command = join(homeDirectory, 'agy-fixture'), workspace = join(homeDirectory, 'workspace');
  for (const name of ['config', 'cache', 'data', 'tmp', 'workspace']) await mkdir(join(homeDirectory, name), { mode: 0o700 });
  await writeFile(command, `#!${process.execPath}\nconst assert = require('node:assert/strict');\n`
    + `assert.deepEqual(process.argv.slice(2), ['--output-format', 'json', '-p', '/usage']);\n`
    + `assert.equal(process.cwd(), process.env.HOME);\nassert.equal(process.env.XDG_CONFIG_HOME, process.env.HOME + '/config');\n`
    + `require('node:fs').appendFileSync('fixture-count', 'call\\n');\nconsole.log(${JSON.stringify(payload(weekly))});\n`, { mode: 0o700 });
  const reader = createAntigravityUsageReader({ homeDirectory, command, workspace, startupTimeoutMs: 15_000 });
  const [first, second] = await Promise.all([reader(), reader()]);
  assert.deepEqual(first, second);
  assert.deepEqual(await reader(), first);
  assert.equal(await readFile(join(homeDirectory, 'fixture-count'), 'utf8'), 'call\n');
  await assert.rejects(createAntigravityUsageReader({ homeDirectory, command: `${command}-missing`, workspace, startupTimeoutMs: 15_000 })(),
    { message: 'antigravity_usage_unavailable' });
});
