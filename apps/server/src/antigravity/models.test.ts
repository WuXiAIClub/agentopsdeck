import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAntigravityModelsReader, mergeAntigravityModels, parseAntigravityModels } from './models.js';

test('parseAntigravityModels parses TSV and ID-only lines, deduplicates, and rejects invalid output', () => {
  const parsed = parseAntigravityModels([
    'gemini-4-neon-high\tGemini 4 Neon (High)',
    'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
    'claude-opus-5-5-high\tDuplicate Ignored',
    'gpt-oss-120b-medium',
    '',
  ].join('\n'));
  assert.deepEqual(parsed, [
    { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
    { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
    { id: 'gpt-oss-120b-medium', label: 'gpt-oss-120b-medium' },
  ]);

  assert.throws(() => parseAntigravityModels(''), /antigravity_models_unavailable/);
  assert.throws(() => parseAntigravityModels('bad model id\tLabel\n'), /antigravity_models_unavailable/);
  assert.throws(() => parseAntigravityModels('ok-id\tBad\x07Label\n'), /antigravity_models_unavailable/);
  const tooMany = Array.from({ length: 101 }, (_, i) => `model-${i}\tModel ${i}`).join('\n');
  assert.throws(() => parseAntigravityModels(tooMany), /antigravity_models_unavailable/);
});

test('mergeAntigravityModels prioritizes configured default model while preserving discovered labels', () => {
  const discovered = [
    { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
    { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
  ];
  assert.deepEqual(mergeAntigravityModels(discovered, 'claude-opus-5-5-high'), [
    { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
    { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
  ]);
  assert.deepEqual(mergeAntigravityModels(discovered, 'custom-default'), [
    { id: 'custom-default', label: 'custom-default' },
    { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
    { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
  ]);
});

test('createAntigravityModelsReader executes isolated CLI models, caches snapshots, and falls back to last known on transient errors', { skip: process.platform !== 'linux' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'aod-agy-models-'));
  const homeDirectory = join(root, 'home'), workspace = join(root, 'workspace'), command = join(root, 'agy');
  const countFile = join(root, 'count.txt'), modeFile = join(root, 'mode.txt');
  mkdirSync(homeDirectory, { mode: 0o700 });
  for (const name of ['config', 'cache', 'data', 'tmp']) mkdirSync(join(homeDirectory, name), { mode: 0o700 });
  mkdirSync(workspace, { mode: 0o700 });
  writeFileSync(modeFile, 'ok');
  writeFileSync(command, `#!/bin/sh
if [ "$1" != "models" ]; then exit 2; fi
echo x >> "${countFile}"
if [ "$(cat "${modeFile}")" = "fail" ]; then
  echo "temporary failure" >&2
  exit 1
fi
printf 'gemini-4-neon-high\\tGemini 4 Neon (High)\\nclaude-opus-5-5-high\\tClaude Opus 5.5 (High)\\n'
`);
  chmodSync(command, 0o700);
  try {
    let now = 1_000;
    const reader = createAntigravityModelsReader(
      { homeDirectory, command, workspace, startupTimeoutMs: 15_000, model: 'claude-opus-5-5-high' },
      { cacheTtlMs: 60_000, errorTtlMs: 5_000, now: () => now },
    );
    const [first, second] = await Promise.all([reader(), reader()]);
    assert.deepEqual(first, [
      { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
      { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
    ]);
    assert.deepEqual(second, first);
    assert.equal(readFileSync(countFile, 'utf8').trim().split('\n').length, 1);

    // Expired cache with transient CLI failure retains the last known catalog.
    now += 61_000;
    writeFileSync(modeFile, 'fail');
    const retained = await reader();
    assert.deepEqual(retained, first);
    assert.equal(readFileSync(countFile, 'utf8').trim().split('\n').length, 2);

    // Cold failure without any prior snapshot throws antigravity_models_unavailable.
    await assert.rejects(
      createAntigravityModelsReader({ homeDirectory, command: `${command}-missing`, workspace, startupTimeoutMs: 15_000 })(),
      /antigravity_models_unavailable/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
