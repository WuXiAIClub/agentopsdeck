import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile, link, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import { registerFileRoutes } from './files.js';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

for (const operation of ['upload', 'rename']) {
  test(`${operation} cancellation retains reader capacity and physical shutdown drain`, async () => {
    const app = new Hono();
    const files = registerFileRoutes(app);
    const releases: (() => void)[] = [];
    const request = () => new Request(`http://localhost/api/files/gateway/${operation}`, {
      method: operation === 'upload' ? 'POST' : 'PATCH',
      headers: { 'content-type': 'multipart/form-data; boundary=synthetic' },
      body: new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(operation === 'upload' ? 25 * 1024 * 1024 : 17 * 1024)); },
        cancel() { return new Promise<void>(resolve => releases.push(resolve)); },
      }, { highWaterMark: 0 }), duplex: 'half',
    } as RequestInit);
    try {
      for (let index = 0; index < 4; index++) assert.equal((await app.request(request())).status, 413);
      assert.equal((await app.request(request())).status, 429);
      let drained = false;
      const closing = files.close().then(() => { drained = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(drained, false);
      assert.equal((await app.request(request())).status, 503);
      for (const release of releases) release();
      await closing;
      assert.equal(drained, true);
    } finally {
      for (const release of releases) release();
      await files.close();
    }
  });
}

test('upload rejects actual oversized multipart bytes early even with a lying content length', async () => {
  await withFilesApp(async (app, root) => {
    let pulls = 0, cancelled = false;
    const request = new Request('http://localhost/api/files/gateway/upload', { method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=synthetic', 'content-length': '1' },
      body: new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024 * 1024)); },
        cancel() { cancelled = true; } }, { highWaterMark: 0 }), duplex: 'half' } as RequestInit);
    const response = await app.request(request);
    assert.equal(response.status, 413); assert.deepEqual(await response.json(), { error: 'file_size_limit' });
    assert.equal(pulls, 25); assert.equal(cancelled, true);
    assert.equal((await app.request('/api/files/gateway/preview?path=synthetic.bin')).status, 404);
    assert.ok(root);
  });
});

test('upload and rename share four body slots, abort cancels streams and restores admission', async context => {
  await withFilesApp(async app => {
    let entered = 0, ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    context.after(() => controllers.forEach(controller => controller.abort()));
    const pending = controllers.map((controller, index) => {
      const rename = index % 2 === 1;
      return app.request(new Request('http://localhost/api/files/gateway/' + (rename ? 'rename' : 'upload'),
        { method: rename ? 'PATCH' : 'POST', signal: controller.signal,
          headers: { 'content-type': rename ? 'application/json' : 'multipart/form-data; boundary=synthetic' },
          body: new ReadableStream({ pull() { if (++entered === 4) ready(); } }, { highWaterMark: 0 }), duplex: 'half' } as RequestInit));
    });
    await started;
    assert.equal((await app.request('/api/files/gateway/rename', { method: 'PATCH', body: '{}' })).status, 429);
    controllers.forEach(controller => controller.abort());
    for (const response of await Promise.all(pending)) assert.equal(response.status, 408);
    assert.equal((await app.request('/api/files/gateway/rename', { method: 'PATCH', body: '{}' })).status, 400);
  });
});

test('rename bounds real JSON bytes and rejects malformed or nonstring payloads before mutation', async () => {
  await withFilesApp(async (app, root) => {
    for (const body of [' '.repeat(16 * 1024 + 1), '{broken', 'null', '{"path":{},"name":"new.txt"}']) {
      const response = await app.request('/api/files/gateway/rename', { method: 'PATCH', body, headers: { 'content-length': '1' } });
      assert.equal(response.status, body.length > 16 * 1024 ? 413 : 400);
    }
    assert.equal(await readFile(path.join(root, 'workspace-agentopsdeck-dev', 'README.md'), 'utf8'), '# hello\n');
  });
});

test('download refuses oversized files and hardlink aliases without unrestricted readFile', async context => {
  await withFilesApp(async (app, root) => {
    const file = await open(path.join(root, 'large.bin'), 'wx');
    try { await file.truncate(24 * 1024 * 1024 + 1); } finally { await file.close(); }
    const unbounded = context.mock.method(fsPromises, 'readFile', () => { throw new Error('unbounded download read'); });
    syncBuiltinESMExports();
    try {
      assert.equal((await app.request('/api/files/gateway/download?path=large.bin')).status, 413);
      await writeFile(path.join(root, 'small.bin'), 'synthetic');
      await link(path.join(root, 'small.bin'), path.join(root, 'alias.bin'));
      const response = await app.request('/api/files/gateway/download?path=alias.bin');
      assert.ok([403, 409].includes(response.status));
      assert.equal(unbounded.mock.callCount(), 0);
    } finally { unbounded.mock.restore(); syncBuiltinESMExports(); }
  });
});

test('native file roots select central AOD data and ignore ambient native config', async () => {
  await withFilesApp(async app => {
    const previousData = process.env.AOD_DATA_DIR, previousNative = process.env.AOD_OPENCLAW_HOME;
    const previousConfig = process.env.AOD_OPENCLAW_CONFIG_FILE, previousInherited = process.env.OPENCLAW_CONFIG_FILE;
    const directory = await mkdtemp(path.join(tmpdir(), 'aod-file-central-root-'));
    try {
      const native = path.join(directory, 'openclaw-home');
      await mkdir(native); await writeFile(path.join(native, 'note.txt'), 'isolated-instance');
      const inherited = path.join(directory, 'ambient.json');
      await writeFile(inherited, '{broken-synthetic-other-instance');
      process.env.AOD_DATA_DIR = directory; delete process.env.AOD_OPENCLAW_HOME;
      delete process.env.AOD_OPENCLAW_CONFIG_FILE; process.env.OPENCLAW_CONFIG_FILE = inherited;
      const isolated = new Hono();
      registerFileRoutes(isolated);
      const response = await isolated.request('/api/files/gateway/preview?path=note.txt');
      assert.equal(response.status, 200); assert.equal((await response.json() as any).text, 'isolated-instance');
      const roots = await isolated.request('/api/files/roots');
      assert.equal(roots.status, 200); assert.equal((await roots.json() as any).roots[0].path, native);
      assert.equal((await app.request('/api/files/gateway/preview?path=note.txt')).status, 404);
    } finally {
      for (const [name, value] of Object.entries({ AOD_DATA_DIR: previousData, AOD_OPENCLAW_HOME: previousNative,
        AOD_OPENCLAW_CONFIG_FILE: previousConfig, OPENCLAW_CONFIG_FILE: previousInherited })) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test('file errors and mutation logs redact downstream content and private absolute paths', async context => {
  await withFilesApp(async (_app, root) => {
    const logs: unknown[][] = [];
    context.mock.method(console, 'info', (...args: unknown[]) => logs.push(args));
    const app = new Hono();
    let fail = true;
    registerFileRoutes(app, { mutate: async (_request, _mutation, work) => {
      if (fail) throw Object.assign(new Error(`${root} synthetic-private-downstream`), { status: 201 });
      return work(async () => {});
    } });
    const upload = () => {
      const body = new FormData(); body.set('file', new File(['hello'], 'safe-note.txt'));
      return app.request('/api/files/gateway/upload', { method: 'POST', body });
    };
    const denied = await upload(); assert.equal(denied.status, 500);
    assert.deepEqual(await denied.json(), { error: 'file_operation_failed' });
    fail = false; assert.equal((await upload()).status, 200);
    assert.equal(logs.length, 1); assert.equal(JSON.stringify(logs).includes(root), false);
    assert.equal(JSON.stringify(logs).includes('safe-note.txt'), false);
  });
});

test('directory metadata inspections overlap but stay bounded at eight; sensitive entries stay hidden', async (t) => {
  await withFilesApp(async (app, root) => {
    await Promise.all(Array.from({ length: 40 }, (_, i) => writeFile(path.join(root, 'workspace-agentopsdeck-dev', `file-${i}.txt`), 'test')));
    const original = fsPromises.stat;
    let active = 0, peak = 0;
    const mocked = t.mock.method(fsPromises, 'stat', async (...args: Parameters<typeof fsPromises.stat>) => {
      active++; peak = Math.max(peak, active);
      try { await new Promise(resolve => setTimeout(resolve, 5)); return await original(...args); }
      finally { active--; }
    });
    syncBuiltinESMExports();
    try {
      const result = await app.request('/api/files/agents/agentopsdeck-dev');
      assert.equal(result.status, 200);
      const body = await result.json() as any;
      assert.equal(body.entries.length, 42); assert.equal(body.hiddenCount, 2);
      assert.ok(peak > 1, 'not serial'); assert.ok(peak <= 8, 'bounded FS operations');
      assert.equal(body.entries[0].kind, 'directory');
      assert.equal(new Set(body.entries.map((entry: any) => entry.path)).size, 42);
    } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  });
});

async function withFilesApp(fn: (app: Hono, root: string) => Promise<void>) {
  const previous = process.env.AOD_OPENCLAW_HOME;
  const previousConfig = process.env.AOD_OPENCLAW_CONFIG_FILE;
  const root = await mkdtemp(path.join(tmpdir(), 'cod115-files-'));
  process.env.AOD_OPENCLAW_HOME = root;
  process.env.AOD_OPENCLAW_CONFIG_FILE = path.join(root, 'openclaw.json');
  try {
    await mkdir(path.join(root, 'workspace-agentopsdeck-dev', 'docs'), { recursive: true });
    await writeFile(path.join(root, 'workspace-agentopsdeck-dev', 'README.md'), '# hello\n');
    await writeFile(path.join(root, 'workspace-agentopsdeck-dev', '.env'), 'TOKEN=hidden\n');
    await writeFile(path.join(root, 'workspace-agentopsdeck-dev', 'secret-token.txt'), 'hidden\n');
    await writeFile(path.join(root, 'openclaw.json'), '{"ownerToken":"hidden"}\n');
    const app = new Hono();
    registerFileRoutes(app);
    await fn(app, root);
  } finally {
    if (previous === undefined) delete process.env.AOD_OPENCLAW_HOME;
    else process.env.AOD_OPENCLAW_HOME = previous;
    if (previousConfig === undefined) delete process.env.AOD_OPENCLAW_CONFIG_FILE;
    else process.env.AOD_OPENCLAW_CONFIG_FILE = previousConfig;
    await rm(root, { recursive: true, force: true });
  }
}

test('file browser lists only inside agent workspace and hides sensitive names', async () => {
  await withFilesApp(async (app) => {
    const response = await app.request('/api/files/agents/agentopsdeck-dev');
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.scope.type, 'agent');
    assert.equal(body.scope.agentId, 'agentopsdeck-dev');
    assert.deepEqual(body.entries.map((entry: any) => entry.name).sort(), ['README.md', 'docs']);
    assert.equal(body.hiddenCount, 2);

    const escape = await app.request('/api/files/agents/agentopsdeck-dev?path=..%2Fopenclaw.json');
    assert.equal(escape.status, 403);
  });
});

test('file browser uses portable relative paths and refuses Windows aliases on every host', async () => {
  await withFilesApp(async (app, root) => {
    await writeFile(path.join(root, 'workspace-agentopsdeck-dev', 'docs', '你好.md'), 'portable');
    await mkdir(path.join(root, 'workspace-agentopsdeck-dev', '..notes'));
    const prefix = '/api/files/agents/agentopsdeck-dev';
    for (const input of ['docs/你好.md', 'docs\\你好.md']) {
      const response = await app.request(`${prefix}/preview?path=${encodeURIComponent(input)}`);
      assert.equal(response.status, 200, input);
      assert.equal((await response.json() as any).text, 'portable');
    }
    assert.equal((await app.request(`${prefix}?path=..notes`)).status, 200);
    const download = await app.request(`${prefix}/download?path=${encodeURIComponent('docs/你好.md')}`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition') ?? '', /filename\*=UTF-8''%E4%BD%A0%E5%A5%BD.md/);
    assert.equal(await download.text(), 'portable');
    for (const input of ['C:\\Windows\\a.md', 'C:relative.md', '\\\\server\\share\\a.md', 'README.md:secret', 'NUL.txt', 'docs./a.md', 'docs /a.md']) {
      assert.equal((await app.request(`${prefix}/preview?path=${encodeURIComponent(input)}`)).status, 400, input);
    }
    for (const input of ['..\\openclaw.json', 'docs/../../secret.txt', 'docs\\..\\..\\secret.txt']) {
      assert.equal((await app.request(`${prefix}/preview?path=${encodeURIComponent(input)}`)).status, 403, input);
    }
  });
});

test('file browser resolves configured workspaces without falling back to the legacy directory', async () => {
  await withFilesApp(async (app, root) => {
    const external = await mkdtemp(path.join(tmpdir(), 'agentopsdeck-external-workspace-'));
    try {
      await mkdir(path.join(external, 'docs'));
      await writeFile(path.join(external, 'docs', 'note.md'), 'configured workspace');
      await writeFile(path.join(root, 'openclaw.json'), JSON.stringify({ agents: {
        defaults: { workspace: external }, list: [{ id: 'agentopsdeck-dev', workspace: external }, { id: 'missing', workspace: path.join(root, 'absent') }],
      } }));
      await mkdir(path.join(root, 'workspace-missing'));
      const roots = await (await app.request('/api/files/roots')).json() as any;
      assert.equal(roots.roots.filter((entry: any) => entry.agentId === 'agentopsdeck-dev').length, 1);
      for (const id of ['main', 'agentopsdeck-dev']) {
        const preview = await app.request(`/api/files/agents/${id}/preview?path=docs%2Fnote.md`);
        assert.equal(preview.status, 200);
        assert.equal((await preview.json() as any).text, 'configured workspace');
      }
      assert.equal((await app.request('/api/files/agents/missing')).status, 404);
      assert.equal((await app.request('/api/files/agents/agentopsdeck-dev/preview?path=README.md')).status, 404);
      const download = await app.request('/api/files/agents/agentopsdeck-dev/download?path=docs%2Fnote.md');
      assert.equal(await download.text(), 'configured workspace');
      await writeFile(path.join(external, 'docs', '.env'), 'synthetic-private-value');
      assert.equal((await app.request('/api/files/agents/agentopsdeck-dev/preview?path=docs%2F.env')).status, 403);
      await symlink(path.join(root, 'workspace-agentopsdeck-dev', 'README.md'), path.join(external, 'escape.md'));
      assert.equal((await app.request('/api/files/agents/agentopsdeck-dev/preview?path=escape.md')).status, 403);
      assert.equal((await app.request('/api/files/agents/agentopsdeck-dev/download?path=escape.md')).status, 403);
    } finally { await rm(external, { recursive: true, force: true }); }
  });
});

test('main workspace supports default folder and legacy fallback; explicit config wins', async () => {
  await withFilesApp(async (app, root) => {
    await mkdir(path.join(root, 'workspace-main'));
    await writeFile(path.join(root, 'workspace-main', 'legacy.md'), 'legacy');
    assert.equal((await app.request('/api/files/agents/main/preview?path=legacy.md')).status, 200);
    await mkdir(path.join(root, 'workspace'));
    await writeFile(path.join(root, 'workspace', 'default.md'), 'default');
    assert.equal((await app.request('/api/files/agents/main/preview?path=default.md')).status, 200);
    await writeFile(path.join(root, 'openclaw.json'), JSON.stringify({ agents: { list: [{ id: 'main', workspace: 'workspace-main' }] } }));
    assert.equal((await app.request('/api/files/agents/main/preview?path=legacy.md')).status, 200);
    assert.equal((await app.request('/api/files/agents/main/preview?path=default.md')).status, 404);
  });
});

test('configured workspaces resolve relative to the selected config, not the service cwd', async () => {
  await withFilesApp(async (app, root) => {
    await mkdir(path.join(root, 'config', 'project'), { recursive: true });
    await writeFile(path.join(root, 'config', 'project', 'note.md'), 'relative');
    process.env.AOD_OPENCLAW_CONFIG_FILE = path.join(root, 'config', 'alternate.json');
    await writeFile(process.env.AOD_OPENCLAW_CONFIG_FILE, JSON.stringify({ agents: { list: [{ id: 'example', workspace: './project' }] } }));
    const selected = new Hono();
    registerFileRoutes(selected);
    assert.equal((await selected.request('/api/files/agents/example/preview?path=note.md')).status, 200);
    assert.equal((await app.request('/api/files/agents/example/preview?path=note.md')).status, 404);
  });
});

test('invalid workspace configuration fails closed with a generic error', async () => {
  await withFilesApp(async (app, root) => {
    for (const config of ['{broken', 'null', '{"agents":{"list":{}}}', '{"agents":{"defaults":{"workspace":42}}}', '{"agents":{"list":[null]}}']) {
      await writeFile(path.join(root, 'openclaw.json'), config);
      for (const route of ['/api/files/roots', '/api/files/agents/agentopsdeck-dev']) {
        const response = await app.request(route);
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { error: 'file_operation_unavailable' });
      }
    }
    process.env.AOD_OPENCLAW_CONFIG_FILE = path.join(root, 'missing-explicit-config.json');
    const required = new Hono();
    registerFileRoutes(required);
    assert.equal((await required.request('/api/files/agents/agentopsdeck-dev')).status, 503);
    delete process.env.AOD_OPENCLAW_CONFIG_FILE;
    await rm(path.join(root, 'openclaw.json'));
    assert.equal((await app.request('/api/files/agents/agentopsdeck-dev')).status, 503);
    const optional = new Hono();
    registerFileRoutes(optional);
    assert.equal((await optional.request('/api/files/agents/agentopsdeck-dev')).status, 200, 'Missing optional default config preserves legacy access');
  });
});

test('nested file operation responses use portable forward-slash relative paths', async () => {
  await withFilesApp(async (app) => {
    const form = new FormData();
    form.set('file', new File(['nested'], 'nested.txt', { type: 'text/plain' }));
    assert.equal((await app.request('/api/files/agents/agentopsdeck-dev/upload?path=docs', { method: 'POST', body: form })).status, 200);
    const list = await (await app.request('/api/files/agents/agentopsdeck-dev?path=docs')).json() as any;
    assert.equal(list.entries[0].path, 'docs/nested.txt');
    const preview = await (await app.request('/api/files/agents/agentopsdeck-dev/preview?path=docs%2Fnested.txt')).json() as any;
    assert.equal(preview.path, 'docs/nested.txt');
    assert.equal((await app.request('/api/files/agents/agentopsdeck-dev?path=..%2F..')).status, 403);
  });
});

test('file browser blocks symlink escape for preview and download', async () => {
  await withFilesApp(async (app, root) => {
    await symlink('/etc/passwd', path.join(root, 'workspace-agentopsdeck-dev', 'passwd-link'));

    const list = await app.request('/api/files/agents/agentopsdeck-dev');
    assert.equal(list.status, 200);
    const body = await list.json() as any;
    assert.equal(body.entries.some((entry: any) => entry.name === 'passwd-link'), false);
    assert.ok(body.hiddenCount >= 1);

    const preview = await app.request('/api/files/agents/agentopsdeck-dev/preview?path=passwd-link');
    assert.equal(preview.status, 403);

    const download = await app.request('/api/files/agents/agentopsdeck-dev/download?path=passwd-link');
    assert.equal(download.status, 403);
  });
});

test('gateway browser exposes openclaw root but protects openclaw.json', async () => {
  await withFilesApp(async (app) => {
    const response = await app.request('/api/files/gateway');
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    const config = body.entries.find((entry: any) => entry.name === 'openclaw.json');
    assert.ok(config);
    assert.equal(config.protected, true);
    assert.equal(config.canDownload, false);
    assert.equal(config.canRename, false);

    const download = await app.request('/api/files/gateway/download?path=openclaw.json');
    assert.equal(download.status, 403);
  });
});

test('file browser supports preview, upload, rename, download, and non-recursive delete', async () => {
  await withFilesApp(async (app, root) => {
    const preview = await app.request('/api/files/agents/agentopsdeck-dev/preview?path=README.md');
    assert.equal(preview.status, 200);
    assert.match((await preview.json() as any).text, /hello/);

    const form = new FormData();
    form.set('file', new File(['draft'], 'draft.txt', { type: 'text/plain' }));
    const upload = await app.request('/api/files/agents/agentopsdeck-dev/upload?path=docs', { method: 'POST', body: form });
    assert.equal(upload.status, 200);
    assert.equal(await readFile(path.join(root, 'workspace-agentopsdeck-dev', 'docs', 'draft.txt'), 'utf8'), 'draft');

    const rename = await app.request('/api/files/agents/agentopsdeck-dev/rename', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'docs/draft.txt', name: 'renamed.txt' }),
    });
    assert.equal(rename.status, 200);

    const download = await app.request('/api/files/agents/agentopsdeck-dev/download?path=docs%2Frenamed.txt');
    assert.equal(download.status, 200);
    assert.equal(await download.text(), 'draft');

    const deleteNonEmpty = await app.request('/api/files/agents/agentopsdeck-dev?path=docs', { method: 'DELETE' });
    assert.equal(deleteNonEmpty.status, 400);

    const deleteFile = await app.request('/api/files/agents/agentopsdeck-dev?path=docs%2Frenamed.txt', { method: 'DELETE' });
    assert.equal(deleteFile.status, 200);

    const deleteEmptyDir = await app.request('/api/files/agents/agentopsdeck-dev?path=docs', { method: 'DELETE' });
    assert.equal(deleteEmptyDir.status, 200);
  });
});

test('file mutations bind parent directory identity across authorization wait and prevent concurrent target overwrite', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aod-files-toctou-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'aod-files-outside-'));
  try {
    const workspace = path.join(root, 'workspace-agentopsdeck-dev');
    await mkdir(path.join(workspace, 'docs'), { recursive: true });
    await writeFile(path.join(root, 'openclaw.json'), '{}');
    await writeFile(path.join(outside, 'victim.txt'), 'outside-original');

    let onCheck: (() => Promise<void>) | null = null;
    const app = new Hono();
    const files = registerFileRoutes(app, {
      roots: { home: root, configFile: path.join(root, 'openclaw.json'), configRequired: false },
      mutate: async (_request, _mutation, work) => work(async () => {
        if (onCheck) await onCheck();
      }),
    });
    try {
      // 1. Upload parent directory swapped with symlink outside root during check()
      onCheck = async () => {
        await rename(path.join(workspace, 'docs'), path.join(workspace, 'docs-moved'));
        await symlink(outside, path.join(workspace, 'docs'));
      };
      const uploadSwapForm = new FormData();
      uploadSwapForm.set('file', new File(['escaped'], 'escaped.txt', { type: 'text/plain' }));
      const uploadSwapRes = await app.request('/api/files/agents/agentopsdeck-dev/upload?path=docs', {
        method: 'POST',
        body: uploadSwapForm,
      });
      assert.equal(uploadSwapRes.status, 409);
      await assert.rejects(readFile(path.join(outside, 'escaped.txt'), 'utf8'));
      await rm(path.join(workspace, 'docs'), { force: true });
      await rename(path.join(workspace, 'docs-moved'), path.join(workspace, 'docs'));

      // 2. Upload target created concurrently during check() must not overwrite
      onCheck = async () => {
        await writeFile(path.join(workspace, 'docs', 'concurrent.txt'), 'winner');
      };
      const uploadRaceForm = new FormData();
      uploadRaceForm.set('file', new File(['loser'], 'concurrent.txt', { type: 'text/plain' }));
      const uploadRaceRes = await app.request('/api/files/agents/agentopsdeck-dev/upload?path=docs', {
        method: 'POST',
        body: uploadRaceForm,
      });
      assert.equal(uploadRaceRes.status, 409);
      assert.equal(await readFile(path.join(workspace, 'docs', 'concurrent.txt'), 'utf8'), 'winner');

      // 3. Rename target created concurrently during check() must return 409 without overwriting
      await writeFile(path.join(workspace, 'docs', 'source.txt'), 'draft-source');
      onCheck = async () => {
        await writeFile(path.join(workspace, 'docs', 'dest.txt'), 'existing-dest');
      };
      const renameRaceRes = await app.request('/api/files/agents/agentopsdeck-dev/rename', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'docs/source.txt', name: 'dest.txt' }),
      });
      assert.equal(renameRaceRes.status, 409);
      assert.equal(await readFile(path.join(workspace, 'docs', 'dest.txt'), 'utf8'), 'existing-dest');
      assert.equal(await readFile(path.join(workspace, 'docs', 'source.txt'), 'utf8'), 'draft-source');

      // 4. Rename parent swapped with symlink outside root during check() must fail without touching outside
      onCheck = async () => {
        await rename(path.join(workspace, 'docs'), path.join(workspace, 'docs-moved'));
        await symlink(outside, path.join(workspace, 'docs'));
      };
      const renameSwapRes = await app.request('/api/files/agents/agentopsdeck-dev/rename', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'docs/source.txt', name: 'victim.txt' }),
      });
      assert.equal(renameSwapRes.status, 409);
      assert.equal(await readFile(path.join(outside, 'victim.txt'), 'utf8'), 'outside-original');
      await rm(path.join(workspace, 'docs'), { force: true });
      await rename(path.join(workspace, 'docs-moved'), path.join(workspace, 'docs'));

      // 5. Delete parent swapped with symlink outside root during check() must fail without deleting outside victim
      await writeFile(path.join(workspace, 'docs', 'victim.txt'), 'inside-victim');
      onCheck = async () => {
        await rename(path.join(workspace, 'docs'), path.join(workspace, 'docs-moved'));
        await symlink(outside, path.join(workspace, 'docs'));
      };
      const deleteSwapRes = await app.request('/api/files/agents/agentopsdeck-dev?path=docs%2Fvictim.txt', {
        method: 'DELETE',
      });
      assert.equal(deleteSwapRes.status, 409);
      assert.equal(await readFile(path.join(outside, 'victim.txt'), 'utf8'), 'outside-original');
      await rm(path.join(workspace, 'docs'), { force: true });
      await rename(path.join(workspace, 'docs-moved'), path.join(workspace, 'docs'));
      assert.equal(await readFile(path.join(workspace, 'docs', 'victim.txt'), 'utf8'), 'inside-victim');
    } finally {
      await files.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
