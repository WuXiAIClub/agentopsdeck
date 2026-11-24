import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('./verify-file-board-schema-compatibility.mjs', import.meta.url), 'utf8');
const executable = source.replace(/^import .*;\n/gm, '').replaceAll('await import(', 'await loadModule(');

async function verify(context, { asynchronous = true, mutate, rejectClose = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-schema-regression-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], rounds = new Map();
  let owners = 0, receipt;
  class CheckedDatabase extends DatabaseSync {
    constructor(...args) {
      assert.equal(owners, 0, 'A snapshot or writer opened before original close settled');
      super(...args);
    }
  }
  function storeClass(kind, release) {
    return class {
      constructor(file) {
        assert.equal(owners, 0, 'Replacement writer opened before original close settled');
        this.db = new DatabaseSync(file);
        owners++;
        const roundKey = kind + ':' + release;
        this.round = (rounds.get(roundKey) ?? 0) + 1;
        rounds.set(roundKey, this.round);
        calls.push(`open:${roundKey}:${this.round}`);
        if (release === '/previous' && this.round === 1) {
          this.db.exec('CREATE TABLE users (label TEXT); CREATE INDEX users_label ON users(label); ' +
            'CREATE VIEW users_view AS SELECT label FROM users; ' +
            'CREATE TRIGGER users_guard BEFORE INSERT ON users BEGIN SELECT 1; END;');
        }
        if (release === '/candidate' && this.round === 1) {
          const table = kind === 'hub' ? 'hub_workspace_board_file_bindings' : 'connector_workspace_board_files';
          this.db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY); CREATE INDEX ${table}_id ON ${table}(id);`);
        }
      }
      createUser(label) { this.db.prepare('INSERT INTO users VALUES (?)').run(label); }
      close() {
        const finish = () => {
          if (kind === 'hub') mutate?.(this.db, release, this.round);
          this.db.close(); owners--;
          calls.push(`closed:${kind}:${release}:${this.round}`);
          if (rejectClose) throw new Error('synthetic-close-rejection');
        };
        if (!asynchronous) return finish();
        return new Promise(resolve => setImmediate(resolve)).then(finish);
      }
    };
  }
  const sandbox = {
    assert, mkdtemp, join, DatabaseSync: CheckedDatabase, tmpdir: () => root,
    process: { argv: ['node', 'script', '/previous', '/candidate'] },
    console: { log() {} }, verifyCandidateRelease: async release => ({ release }),
    writeFile: async (file, value, options) => { receipt = JSON.parse(value); await writeFile(file, value, options); },
    loadModule: async path => {
      const release = path.startsWith('/previous/') ? '/previous' : '/candidate';
      if (path.endsWith('/hub/hub-store.js')) return { HubStore: storeClass('hub', release) };
      if (path.endsWith('/connector/connector-user-store.js')) return { ConnectorUserStore: storeClass('connector', release) };
      if (path.endsWith('/connector/workspace-board-files.js')) return { ConnectorFileBoards: class {}, ConnectorWorkspaceFiles: class {} };
      if (path.endsWith('/connector/workspace-file-card-format.js')) return { cardFileCodec: () => ({}) };
      assert.fail('Unexpected synthetic module request');
    },
  };
  await runInNewContext(`(async () => { ${executable} })()`, sandbox);
  assert.equal(owners, 0);
  return { receipt, calls, exitCode: sandbox.process.exitCode };
}

for (const asynchronous of [false, true]) {
  test(`schema proof serializes every original writer close (async=${asynchronous})`, async context => {
    const { receipt, calls, exitCode } = await verify(context, { asynchronous });
    assert.equal(receipt.passed, true);
    assert.equal(exitCode, undefined);
    assert.equal(calls.length, 16);
    for (let index = 0; index < calls.length; index += 2) {
      assert.match(calls[index], /^open:/);
      assert.match(calls[index + 1], /^closed:/);
    }
    assert.ok(receipt.checks.every(check => check.existingSchemaObjectsUnchanged));
    assert.ok(receipt.checks.every(check => check.addedSchemaObjects.some(object => object.sql === null)));
  });
}

const changes = {
  index: 'DROP INDEX users_label; CREATE INDEX users_label ON users(label DESC);',
  trigger: 'DROP TRIGGER users_guard; CREATE TRIGGER users_guard BEFORE INSERT ON users BEGIN SELECT 2; END;',
  view: 'DROP VIEW users_view; CREATE VIEW users_view AS SELECT label FROM users WHERE 0;',
};
for (const [type, sql] of Object.entries(changes)) {
  for (const release of ['/candidate', '/previous']) {
    test(`schema proof detects ${type} replacement by ${release} without table/row changes`, async context => {
      const { receipt, exitCode } = await verify(context, { mutate(db, current, round) {
        if (current === release && round === (release === '/candidate' ? 1 : 2)) db.exec(sql);
      } });
      assert.equal(receipt.passed, false);
      assert.equal(exitCode, 1);
      assert.match(receipt.error.kind, /AssertionError/);
    });
  }
  test(`schema proof detects dropped ${type} during candidate reopen`, async context => {
    const { receipt } = await verify(context, { mutate(db, release, round) {
      if (release === '/candidate' && round === 2) db.exec(`DROP ${type.toUpperCase()} users_${type === 'index' ? 'label' : type === 'trigger' ? 'guard' : 'view'}`);
    } });
    assert.equal(receipt.passed, false);
    assert.match(receipt.error.message, /Candidate reopen changed persisted state/);
  });
}

for (const sql of ['CREATE VIEW extra_view AS SELECT label FROM users;',
  'CREATE TRIGGER extra_trigger BEFORE INSERT ON users BEGIN SELECT 1; END;',
  'CREATE INDEX extra_index ON users(label);']) {
  test(`schema proof rejects unaudited non-table additions: ${sql.split(' ')[1]}`, async context => {
    const { receipt } = await verify(context, { mutate(db, release, round) {
      if (release === '/candidate' && round === 1) db.exec(sql);
    } });
    assert.equal(receipt.passed, false);
    assert.match(receipt.error.message, /Unaudited additive schema objects/);
  });
}

test('rejected original close publishes failure without snapshotting or opening a replacement', async context => {
  const { receipt, calls, exitCode } = await verify(context, { rejectClose: true });
  assert.equal(receipt.passed, false);
  assert.equal(exitCode, 1);
  assert.equal(receipt.error.message, 'synthetic-close-rejection');
  assert.equal(calls.length, 2);
});
