import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOpenClawAgentNames } from '../openclaw/cli.js';

function fixture(context: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'aod-agent-registry-'));
  const home = join(root, 'native-home'), agents = join(home, 'agents');
  mkdirSync(agents, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, home, agents };
}

test('configured registry reads only its explicit home and ignores files and linked agents', async context => {
  const setup = fixture(context);
  mkdirSync(join(setup.agents, 'synthetic-agent'));
  writeFileSync(join(setup.agents, 'not-an-agent'), '');
  const ambient = join(setup.root, 'other-home');
  mkdirSync(join(ambient, 'agents', 'foreign-agent'), { recursive: true });
  symlinkSync(join(ambient, 'agents', 'foreign-agent'), join(setup.agents, 'linked-agent'), 'dir');
  assert.deepEqual(await readOpenClawAgentNames(setup.home), ['synthetic-agent']);
});

test('configured registry rejects home and agents directory aliases without leaking paths', async context => {
  const setup = fixture(context), alias = join(setup.root, 'alias');
  symlinkSync(setup.home, alias, 'dir');
  await assert.rejects(readOpenClawAgentNames(alias), { message: 'Configured OpenClaw agent registry unavailable' });
  rmSync(setup.agents, { recursive: true });
  const foreign = join(setup.root, 'foreign-agents');
  mkdirSync(foreign);
  symlinkSync(foreign, setup.agents, 'dir');
  await assert.rejects(readOpenClawAgentNames(setup.home), { message: 'Configured OpenClaw agent registry unavailable' });
});

test('configured registry rejects a nonprivate home', { skip: process.platform === 'win32' }, async context => {
  const setup = fixture(context);
  chmodSync(setup.home, 0o755);
  await assert.rejects(readOpenClawAgentNames(setup.home), { message: 'Configured OpenClaw agent registry unavailable' });
});

test('configured registry bounds visited entries, discards partial results and drains the iterator', async context => {
  const setup = fixture(context);
  let visited = 0, closed = false;
  context.mock.method(fsPromises, 'opendir', async () => (async function* () {
    try {
      for (let index = 0; index < 4097; index++) {
        visited++;
        yield { name: `synthetic-${index}`, isDirectory: () => true };
      }
    } finally { closed = true; }
  })());
  syncBuiltinESMExports();
  context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(readOpenClawAgentNames(setup.home), { message: 'Configured OpenClaw agent registry unavailable' });
  assert.equal(visited, 4097); assert.equal(closed, true);
});
