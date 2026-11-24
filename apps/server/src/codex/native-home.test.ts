import assert from 'node:assert/strict';
import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { agentOpsDeckDataDirectory, loadConfig } from '../config.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';

const simulator = `
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    if (request.method === 'initialized') return;
    if (!['initialize', 'thread/list'].includes(request.method)) throw new Error('Unexpected native request');
    const result = request.method === 'thread/list' ? { data: [], nextCursor: null } : {};
    process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
  });
`;

test('Codex home has an independent AOD default and accepts an explicit absolute override', () => {
  const directory = join(tmpdir(), 'synthetic-codex-home');
  const configured = loadConfig({ AOD_CODEX_HOME: `  ${directory}  `,
    AOD_CODEX_COMMAND: 'existing-codex', AOD_CODEX_DEFAULT_CWD: '/synthetic-work' });
  assert.equal(configured.codex.homeDirectory, directory);
  assert.equal(configured.codex.command, 'existing-codex');
  assert.equal(configured.codex.defaultCwd, '/synthetic-work');
  const defaultHome = join(agentOpsDeckDataDirectory({}), 'codex-home');
  assert.equal(loadConfig({}).codex.homeDirectory, defaultHome);
  assert.equal(loadConfig({ AOD_CODEX_HOME: '  ' }).codex.homeDirectory, defaultHome);
});

for (const invalid of ['relative/home', '~/native', join(tmpdir(), 'invalid\0home')]) {
  test(`Codex home rejects ${JSON.stringify(invalid)} before runtime construction`, () => {
    assert.throws(() => loadConfig({ AOD_CODEX_HOME: invalid }), /AOD_CODEX_HOME must be an absolute path/);
  });
}

for (const configured of [false, true]) {
  test(`native children use separate ${configured ? 'explicit' : 'default AOD'} homes across restart`,
    async context => {
      const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-native-home-'));
      const workspace = join(directory, 'workspace');
      mkdirSync(workspace, { mode: 0o700 });
      const inheritedHome = process.env.CODEX_HOME;
      const ambientHome = join(directory, 'ambient-native');
      process.env.CODEX_HOME = ambientHome;
      const nativeSpawn = childProcess.spawn;
      const children: Array<{ child: ChildProcessWithoutNullStreams; closed: Promise<unknown> }> = [];
      const observed: Array<{ command: string; cwd: string; home: string | undefined }> = [];
      const runtimes: Array<{ codex: CodexAppServer; users: ConnectorUserStore }> = [];
      context.after(async () => {
        try {
          for (const runtime of runtimes) { await runtime.codex.close(); runtime.users.close(); }
        } finally {
          for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          await Promise.all(children.map(child => child.closed));
          context.mock.restoreAll(); syncBuiltinESMExports();
          if (inheritedHome === undefined) delete process.env.CODEX_HOME;
          else process.env.CODEX_HOME = inheritedHome;
          rmSync(directory, { recursive: true, force: true });
        }
      });
      context.mock.method(childProcess, 'spawn', (command: string, _arguments: string[], options: { cwd: string; env: NodeJS.ProcessEnv; detached?: boolean }) => {
        assert.equal(command, 'existing-codex-sentinel');
        observed.push({ command, cwd: options.cwd, home: options.env.CODEX_HOME });
        const child = nativeSpawn(process.execPath, ['-e', simulator], { cwd: directory, detached: options.detached ?? false,
          stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: directory, CODEX_HOME: options.env.CODEX_HOME } });
        children.push({ child, closed: once(child, 'close') });
        return child;
      });
      syncBuiltinESMExports();
      const states = ['alice', 'bob'].map(label => join(directory, label));
      const homes = states.map(state => join(state, 'codex-home'));
      for (const home of homes) mkdirSync(home, { recursive: true, mode: 0o700 });
      for (let restart = 0; restart < 2; restart++) {
        for (const [index, home] of homes.entries()) {
          const config = loadConfig({ AOD_CODEX_COMMAND: 'existing-codex-sentinel',
            AOD_CODEX_ENABLED: 'true', AOD_DATA_DIR: states[index], AOD_CODEX_DEFAULT_CWD: workspace,
            ...(configured ? { AOD_CODEX_HOME: home } : {}) });
          const users = new ConnectorUserStore(':memory:');
          const codex = new CodexAppServer({ ...config.codex, store: new DeckStore(),
            turnQueue: users.turns, executions: users.codexExecutions, authorizeTurn: () => true });
          runtimes.push({ codex, users });
          await codex.refreshSessions();
          assert.equal(codex.isSessionListReady(), true);
        }
        for (const runtime of runtimes.slice(-2)) await runtime.codex.close();
      }
      assert.deepEqual(observed.map(child => child.home), [...homes, ...homes]);
      assert.ok(observed.every(child => child.cwd === workspace && child.command === 'existing-codex-sentinel'));
      assert.equal(process.env.CODEX_HOME, ambientHome);
      assert.ok(children.every(({ child }) => child.exitCode !== null || child.signalCode !== null));
    });
}
