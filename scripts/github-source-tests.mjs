import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverTests, runSourceTests } from './run-source-tests.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function selectSourceShard(files, index, total) {
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || total < 1 || index > total || total > files.length) throw new Error('Invalid or empty source shard');
  if (new Set(files).size !== files.length) throw new Error('Duplicate source test path');
  return [...files].sort().filter((file, position) => position % total === index - 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/github-source-tests.mjs SHARD_INDEX SHARD_TOTAL');
  const files = await discoverTests(join(repository, 'apps/server/src'));
  const selected = selectSourceShard(files, Number(process.argv[2]), Number(process.argv[3]));
  console.log(`Server source shard ${process.argv[2]}/${process.argv[3]}: ${selected.length}/${files.length} files`);
  await runSourceTests('server', selected);
}
