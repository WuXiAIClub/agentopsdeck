import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeUpstreamPatch, prepareUpstreamPatch } from './prepare-upstream-patch.mjs';

function sourceFixture(context) {
  const root = mkdtempSync(join(tmpdir(), 'aod-upstream-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git(['init', '--initial-branch=main']);
  git(['config', 'user.name', 'SyntheticFixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  for (const directory of ['apps/server/src', 'packages/shared/src']) mkdirSync(join(root, directory), {recursive: true});
  writeFileSync(join(root, 'apps/server/src/fixture.ts'), "export const enabled = false;\n");
  writeFileSync(join(root, 'packages/shared/src/protocol.ts'), "export const AGENTOPSDECK_VERSION = '2.5.0';\n");
  git(['add', '.']);
  git(['commit', '-m', 'Synthetic base']);
  return {root, git};
}

test('upstream normalization maps legacy packages, protocol and credentials into AOD', () => {
  const brand = ['claw', 'pool'].join('');
  const patch = normalizeUpstreamPatch(`import {} from '@${brand}/shared';\nconst header = 'x-${brand}-protocol';\n${brand.toUpperCase()}_ACCESS_KEY ${brand[0].toUpperCase()}${brand.slice(1)} .${brand}-queue.json ${brand}_session\n`);
  assert.match(patch, /@agentopsdeck\/shared/);
  assert.match(patch, /x-agentopsdeck-protocol/);
  assert.match(patch, /AOD_ACCESS_KEY AgentOpsDeck \.agentopsdeck-queue\.json agentopsdeck_session/);
});

test('upstream normalization preserves reserved product symbols and is idempotent', () => {
  const brand = ['claw', 'pool'].join('').toUpperCase();
  const source = `${brand}_VERSION ${brand}_BUILD ${brand}_ACCESS_KEY AGENTOPSDECK_VERSION AGENTOPSDECK_BUILD AGENTOPSDECK_PORT AOD_PORT`;
  const expected = 'AGENTOPSDECK_VERSION AGENTOPSDECK_BUILD AOD_ACCESS_KEY AGENTOPSDECK_VERSION AGENTOPSDECK_BUILD AOD_PORT AOD_PORT';
  assert.equal(normalizeUpstreamPatch(source), expected);
  assert.equal(normalizeUpstreamPatch(expected), expected);
});

test('one reviewed source patch applies without importing history or changing AOD version', context => {
  const {root, git} = sourceFixture(context);
  writeFileSync(join(root, 'apps/server/src/fixture.ts'), 'export const enabled = true;\n');
  writeFileSync(join(root, 'packages/shared/src/protocol.ts'), "export const AGENTOPSDECK_VERSION = '2.6.0';\n");
  git(['add', '.']);
  git(['commit', '-m', 'Synthetic delta']);
  const commit = git(['rev-parse', 'HEAD']);
  const patch = prepareUpstreamPatch(root, commit);
  assert.match(patch, /enabled = true/);
  assert.doesNotMatch(patch, /2\.6\.0|protocol\.ts/);
  const target = join(root, 'target');
  mkdirSync(join(target, 'apps/server/src'), {recursive: true});
  writeFileSync(join(target, 'apps/server/src/fixture.ts'), 'export const enabled = false;\n');
  execFileSync('git', ['init', '--initial-branch=main', target], {stdio: 'ignore'});
  execFileSync('git', ['apply', '--check', '-'], {cwd: target, input: patch, stdio: ['pipe', 'pipe', 'pipe']});
  execFileSync('git', ['apply', '-'], {cwd: target, input: patch, stdio: ['pipe', 'pipe', 'pipe']});
  assert.equal(execFileSync('git', ['rev-list', '--all'], {cwd: target, encoding: 'utf8'}), '');
});

test('invalid identity, root commits and unsafe source changes are refused', context => {
  const {root, git} = sourceFixture(context);
  assert.throws(() => prepareUpstreamPatch(root, 'HEAD'), /FULL_COMMIT_REQUIRED/);
  assert.throws(() => prepareUpstreamPatch(root, git(['rev-parse', 'HEAD'])), /SINGLE_PARENT_COMMIT_REQUIRED/);
  writeFileSync(join(root, 'apps/server/src/fixture.ts'), 'export const rejected = "ghp_' + 'a'.repeat(40) + '";\n');
  git(['add', '.']);
  git(['commit', '-m', 'Synthetic unsafe fixture']);
  assert.throws(() => prepareUpstreamPatch(root, git(['rev-parse', 'HEAD'])), /UNSAFE_SOURCE_PATCH/);
});
