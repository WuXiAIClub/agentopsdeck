import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import { MediaLibrary } from './media-library.js';

async function withLibrary(run: (app: Hono, library: MediaLibrary, root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'clawops-media-library-'));
  await mkdir(path.join(root, 'Movies'));
  await writeFile(path.join(root, 'Movies', 'sample.mp4'), Buffer.from('0123456789abcdef'));
  await writeFile(path.join(root, 'Movies', 'needs-transcode.mkv'), Buffer.from('mkv'));
  await writeFile(path.join(root, 'ignore.txt'), Buffer.from('ignore'));
  const library = new MediaLibrary({ enabled: true, allowedDirs: [root], signingSecret: 'test-secret', linkTtlSeconds: 3600 });
  const app = new Hono();
  library.register(app);
  try {
    await run(app, library, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('media library browses configured roots without exposing absolute paths', async () => {
  await withLibrary(async (app, _library, root) => {
    const rootsResponse = await app.request('/api/media-library');
    assert.equal(rootsResponse.status, 200);
    const roots = await rootsResponse.json() as any;
    assert.equal(roots.enabled, true);
    assert.equal(roots.roots.length, 1);
    assert.equal(roots.roots[0].label, path.basename(root));
    assert.doesNotMatch(JSON.stringify(roots), new RegExp(root.replace(/\\/g, '\\\\')));

    const listResponse = await app.request('/api/media-library?root=0&path=Movies');
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json() as any;
    assert.deepEqual(list.entries.map((entry: any) => [entry.name, entry.kind, entry.playable]), [
      ['needs-transcode.mkv', 'video', false],
      ['sample.mp4', 'video', true],
    ]);
    assert.match(list.entries[1].playbackUrl, /^\/api\/media-library\/stream\?/);
    assert.doesNotMatch(JSON.stringify(list), new RegExp(root.replace(/\\/g, '\\\\')));
  });
});

test('signed stream supports byte ranges, suffix ranges, HEAD, and rejects bad ranges', async () => {
  await withLibrary(async (app, library) => {
    const list = await (await app.request('/api/media-library?root=0&path=Movies')).json() as any;
    const url = list.entries.find((entry: any) => entry.name === 'sample.mp4').playbackUrl;
    assert.equal(library.isSignedStreamRequest(new Request(`http://localhost${url}`)), true);

    const partial = await app.request(url, { headers: { range: 'bytes=2-5' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('accept-ranges'), 'bytes');
    assert.equal(partial.headers.get('content-range'), 'bytes 2-5/16');
    assert.equal(partial.headers.get('content-length'), '4');
    assert.equal(partial.headers.get('content-type'), 'video/mp4');
    assert.equal(await partial.text(), '2345');

    const suffix = await app.request(url, { headers: { range: 'bytes=-4' } });
    assert.equal(suffix.status, 206);
    assert.equal(await suffix.text(), 'cdef');

    const head = await app.request(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), '16');
    assert.equal(await head.text(), '');

    const invalid = await app.request(url, { headers: { range: 'bytes=99-100' } });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get('content-range'), 'bytes */16');
  });
});

test('media library rejects traversal, unsigned playback, and direct MKV playback', async () => {
  await withLibrary(async (app, library) => {
    assert.equal((await app.request('/api/media-library?root=0&path=..%2F')).status, 400);
    assert.equal((await app.request('/api/media-library/stream?root=0&path=Movies%2Fsample.mp4')).status, 401);
    assert.equal(library.isSignedStreamRequest(new Request('http://localhost/api/media-library/stream?root=0&path=Movies%2Fsample.mp4&expires=1&signature=nope')), false);

    const list = await (await app.request('/api/media-library?root=0&path=Movies')).json() as any;
    const mkv = list.entries.find((entry: any) => entry.name === 'needs-transcode.mkv');
    assert.equal(mkv.playable, false);
    assert.equal(mkv.playbackUrl, undefined);
  });
});

test('media library stays disabled until at least one directory is configured', async () => {
  const app = new Hono();
  const library = new MediaLibrary({ enabled: false, allowedDirs: [], signingSecret: 'test', linkTtlSeconds: 3600 });
  library.register(app);
  const body = await (await app.request('/api/media-library')).json() as any;
  assert.equal(body.enabled, false);
  assert.deepEqual(body.roots, []);
});

test('explicitly disabling configured roots prevents browsing and signed playback', async () => {
  await withLibrary(async (app, _library, root) => {
    const list = await (await app.request('/api/media-library?root=0&path=Movies')).json() as any;
    const url = list.entries.find((entry: any) => entry.name === 'sample.mp4').playbackUrl;
    const disabled = new MediaLibrary({ enabled: false, allowedDirs: [root], signingSecret: 'test-secret', linkTtlSeconds: 3600 });
    const disabledApp = new Hono();
    disabled.register(disabledApp);
    const body = await (await disabledApp.request('/api/media-library?root=0&path=Movies')).json() as any;
    assert.equal(body.enabled, false);
    assert.deepEqual(body.entries, []);
    assert.equal(disabled.isSignedStreamRequest(new Request(`http://localhost${url}`)), false);
    assert.equal((await disabledApp.request(url)).status, 401);
  });
});

test('signed playback rejects tampering and expired links', async () => {
  await withLibrary(async (app, _library, root) => {
    const list = await (await app.request('/api/media-library?root=0&path=Movies')).json() as any;
    const original = list.entries.find((entry: any) => entry.name === 'sample.mp4').playbackUrl;
    for (const [field, value] of [['root', '1'], ['path', 'Movies/other.mp4'], ['expires', '9999999999'], ['signature', 'invalid']]) {
      const url = new URL(original, 'http://localhost');
      url.searchParams.set(field!, value!);
      assert.equal((await app.request(url)).status, 401, `${field} must be signed`);
    }
    const expiredApp = new Hono();
    new MediaLibrary({ enabled: true, allowedDirs: [root], signingSecret: 'test-secret', linkTtlSeconds: -60 }).register(expiredApp);
    const expired = await (await expiredApp.request('/api/media-library?root=0&path=Movies')).json() as any;
    const url = expired.entries.find((entry: any) => entry.name === 'sample.mp4').playbackUrl;
    assert.equal((await app.request(url)).status, 401, 'correctly signed but expired link must fail');
  });
});

test('symlink escape is hidden and previously signed paths are revalidated at playback', async () => {
  await withLibrary(async (app, _library, root) => {
    const outside = await mkdtemp(path.join(tmpdir(), 'agentopsdeck-media-outside-'));
    try {
      const target = path.join(outside, 'private.mp4');
      await writeFile(target, 'must not escape');
      await symlink(target, path.join(root, 'escape.mp4'), 'file');
      await symlink(outside, path.join(root, 'escape-dir'), process.platform === 'win32' ? 'junction' : 'dir');
      const body = await (await app.request('/api/media-library?root=0')).json() as any;
      assert.equal(body.entries.some((entry: any) => entry.name.startsWith('escape')), false);
      assert.equal((await app.request('/api/media-library?root=0&path=escape-dir')).status, 403);
      const movies = await (await app.request('/api/media-library?root=0&path=Movies')).json() as any;
      const url = movies.entries.find((entry: any) => entry.name === 'sample.mp4').playbackUrl;
      await unlink(path.join(root, 'Movies', 'sample.mp4'));
      await symlink(target, path.join(root, 'Movies', 'sample.mp4'), 'file');
      const response = await app.request(url);
      assert.equal(response.status, 403);
      assert.doesNotMatch(await response.text(), /must not escape/);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
});

test('missing paths report an error rather than a successful empty directory', async () => {
  await withLibrary(async (app) => {
    const response = await app.request('/api/media-library?root=0&path=missing');
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'media path not found' });
    assert.equal((await app.request('/api/media-library?root=unknown')).status, 404);
  });
});
