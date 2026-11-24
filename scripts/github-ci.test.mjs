import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { selectSourceShard } from './github-source-tests.mjs';
import { discoverTests } from './run-source-tests.mjs';
import { fileURLToPath } from 'node:url';

test('GitHub source shards cover every backend test exactly once', async () => {
  const files = await discoverTests(fileURLToPath(new URL('../apps/server/src', import.meta.url)));
  const selected = Array.from({ length: 12 }, (_, index) => selectSourceShard(files, index + 1, 12));
  assert.deepEqual(selected.flat().sort(), [...files].sort());
  assert.equal(new Set(selected.flat()).size, files.length);
  assert.throws(() => selectSourceShard(files, 0, 12));
  assert.throws(() => selectSourceShard(files, 13, 12));
  assert.throws(() => selectSourceShard(['same', 'same'], 1, 1));
});

test('GitHub CI is hosted, pinned, read-only and runs security/i18n/API/full-source tests', () => {
  const text = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(text, /contents: read/);
  assert.match(text, /persist-credentials: false/);
  assert.equal((text.match(/uses: actions\/[\w-]+@[a-f0-9]{40}\b/g) ?? []).length, 4);
  assert.doesNotMatch(text, /self-hosted|secrets\.|git push|systemctl|wrangler|deploy|upload-artifact/);
  for (const command of ['pnpm check:security', 'pnpm check:i18n', 'pnpm check:api', 'pnpm check:review', 'node scripts/run-script-tests.mjs', 'node scripts/run-source-tests.mjs web', 'node scripts/github-source-tests.mjs']) assert.ok(text.includes(command), command);
  assert.match(text, /shard: \[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12\]/);
  assert.match(text, /fail-fast: false/);
  assert.ok(text.indexOf('pnpm audit --prod --audit-level=high') > text.indexOf('node scripts/run-source-tests.mjs web'));
  assert.match(text, /NODE_ENV: development/);
  assert.ok(text.includes('pnpm audit --audit-level=high'));
  const mirror = readFileSync(new URL('../.gitlab-ci.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(mirror, /tags:|environment:|secrets\.|systemctl|git push|HTTP_PROXY/);
  assert.ok(mirror.includes('pnpm audit --prod --audit-level=high'));
  assert.ok(mirror.includes('pnpm audit --audit-level=high'));
  assert.match(mirror, /NODE_ENV: development/);
  assert.ok(mirror.includes('pnpm --workspace-concurrency=1 -r typecheck'));
  assert.ok(mirror.includes('pnpm check:review'));
});
