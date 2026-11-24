import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorFileBoards, ConnectorWorkspaceFiles } from './workspace-board-files.js';
import { registerConnectorWorkspaceFiles } from './workspace-board-files-http.js';
import { cardFileCodec } from './workspace-file-card-format.js';
import { fileBoardRuntimes, type FileBoardPolicy } from './workspace-board-file-policy.js';

test('board/card discovery is authenticated, owner-scoped, live and content-free without touching sessions or files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-file-capabilities-'));
  const db = new DatabaseSync(':memory:'), tokens = new ConnectorTokenStore(join(root, 'tokens'));
  const owner = tokens.createTransient(['boards:files'], 'owner');
  const other = tokens.createTransient(['boards:files'], 'other');
  const legacy = tokens.createTransient(['files:read'], 'legacy');
  const config = { boardFiles: { root, policies: [
    { owner: 'owner', runtime: 'codex' }, { owner: 'owner', runtime: 'claude-code' },
    { owner: 'owner', runtime: 'ghcp' }, { owner: 'other', runtime: 'ghcp' },
  ] } as FileBoardPolicy, claude: { toolPolicy: 'workspace-read' }, copilot: { toolPolicy: 'workspace-edit' } };
  const app = new Hono();
  const boards = new ConnectorFileBoards(db, root, () => false);
  const cards = new ConnectorWorkspaceFiles(db, root, () => false, cardFileCodec());
  const deps = { tokens, runtimes: (id: string) => fileBoardRuntimes(id, config),
    session: () => { assert.fail('Discovery must not hydrate or start a session'); } };
  const services = [registerConnectorWorkspaceFiles(app, { ...deps, boards }),
    registerConnectorWorkspaceFiles(app, { ...deps, boards: cards })];
  try {
    await Promise.all(services.map(service => service.ready));
    const before = await readdir(root);
    for (const kind of ['board', 'card']) {
      const url = `/api/connector/v1/workspace/${kind}-files`;
      const read = (token: string) => app.request(url, { headers: { authorization: `Bearer ${token}` } });
      assert.equal((await app.request(url)).status, 401);
      assert.equal((await read(legacy.token)).status, 403);
      const response = await read(owner.token);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const capability = await response.json();
      assert.deepEqual(capability, { protocol: 1, writeProtocol: 1, maxBindings: 64,
        ...(kind === 'card' ? { notebookArchiveProtocol: 1 } : {}),
        mode: kind === 'board' ? 'whole-board-file' : 'workspace-card-file', runtimeProtocol: 1, runtimes: ['codex', 'ghcp'] });
      assert.deepEqual((await (await read(other.token)).json()).runtimes, ['ghcp']);
      config.claude.toolPolicy = 'trusted-exec';
      config.copilot.toolPolicy = 'workspace-read';
      assert.deepEqual((await (await read(owner.token)).json()).runtimes, ['codex', 'claude-code']);
      assert.deepEqual((await (await read(other.token)).json()).runtimes, []);
      config.claude.toolPolicy = 'workspace-read'; config.copilot.toolPolicy = 'workspace-edit';
    }
    owner.dispose();
    for (const kind of ['board', 'card']) assert.equal((await app.request(`/api/connector/v1/workspace/${kind}-files`,
      { headers: { authorization: `Bearer ${owner.token}` } })).status, 401);
    assert.deepEqual(await readdir(root), before);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM connector_workspace_board_files').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM connector_workspace_card_files').get() as { n: number }).n, 0);
  } finally {
    await Promise.all(services.map(service => service.close())); db.close(); await rm(root, { recursive: true, force: true });
  }
});
