import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import { registerMediaRoutes } from './media.js';

async function withMediaApp(fn: (app: Hono) => Promise<void>, options: Parameters<typeof registerMediaRoutes>[1] = {}) {
  const previousHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), 'cod058-media-'));
  process.env.HOME = home;
  try {
    const app = new Hono();
    registerMediaRoutes(app, options);
    await fn(app);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
}

test('media publish stores txt bytes and returns a downloadable URL', async () => {
  await withMediaApp(async (app) => {
    const text = 'hello deck media';
    const publish = await app.request('/api/media/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'report.txt', mimeType: 'text/plain', contentBase64: Buffer.from(text).toString('base64') }),
    });

    assert.equal(publish.status, 200);
    const body = await publish.json() as any;
    assert.equal(body.media.name, 'report.txt');
    assert.equal(body.media.mimeType, 'text/plain');
    assert.equal(body.downloadUrl, `http://localhost${body.media.url}`);
    assert.equal(body.markdownUrl, `[report.txt](${body.downloadUrl})`);
    assert.doesNotMatch(body.downloadUrl, /key|token|secret/i);

    const download = await app.request(body.media.url);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'text/plain');
    assert.match(download.headers.get('content-disposition') ?? '', /^attachment; filename="agentopsdeck-.*-report\.txt"$/);
    assert.equal(await download.text(), text);
  });
});

test('media publish stores zip bytes as an attachment', async () => {
  await withMediaApp(async (app) => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 3]);
    const publish = await app.request('/api/media/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'bundle.zip', mimeType: 'application/zip', contentBase64: zip.toString('base64') }),
    });

    assert.equal(publish.status, 200);
    const body = await publish.json() as any;
    assert.equal(body.downloadUrl, `http://localhost${body.media.url}`);
    const download = await app.request(body.media.url);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/zip');
    assert.match(download.headers.get('content-disposition') ?? '', /^attachment; filename="agentopsdeck-.*-bundle\.zip"$/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), zip);
  });
});

test('media publish returns forwarded public origin for tunnel links', async () => {
  await withMediaApp(async (app) => {
    const publish = await app.request('http://localhost:8790/api/media/publish', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'deck.example.com',
      },
      body: JSON.stringify({ name: 'bundle.zip', mimeType: 'application/zip', contentBase64: Buffer.from('zip-ish').toString('base64') }),
    });

    assert.equal(publish.status, 200);
    const body = await publish.json() as any;
    assert.match(body.downloadUrl, /^https:\/\/deck\.example\.com\/api\/media\/inbound\/agentopsdeck-.*-bundle\.zip$/);
    assert.equal(body.markdownUrl, `[bundle.zip](${body.downloadUrl})`);
  });
});

test('media publish can use configured public base URL when tunnel host headers are local', async () => {
  await withMediaApp(async (app) => {
    const publish = await app.request('http://localhost:8790/api/media/publish', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
        'host': 'localhost:8790',
      },
      body: JSON.stringify({ name: 'bundle.zip', mimeType: 'application/zip', contentBase64: Buffer.from('zip-ish').toString('base64') }),
    });

    assert.equal(publish.status, 200);
    const body = await publish.json() as any;
    assert.match(body.downloadUrl, /^https:\/\/user-deck\.example\/api\/media\/inbound\/agentopsdeck-.*-bundle\.zip$/);
  }, { publicBaseUrl: 'https://user-deck.example/custom/' });
});

test('media publish rejects unsupported MIME and local path-only requests', async () => {
  await withMediaApp(async (app) => {
    const unsupported = await app.request('/api/media/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'run.sh', mimeType: 'application/x-sh', contentBase64: Buffer.from('echo nope').toString('base64') }),
    });
    assert.equal(unsupported.status, 400);
    assert.match(await unsupported.text(), /unsupported media type/);

    const pathOnly = await app.request('/api/media/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/etc/passwd', name: 'passwd.txt', mimeType: 'text/plain' }),
    });
    assert.equal(pathOnly.status, 400);
    assert.match(await pathOnly.text(), /contentBase64 is required/);
  });
});

test('media publish sanitizes traversal filenames before persistence', async () => {
  await withMediaApp(async (app) => {
    const publish = await app.request('/api/media/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '../../evil.zip', mimeType: 'application/zip', contentBase64: Buffer.from('zip-ish').toString('base64') }),
    });

    assert.equal(publish.status, 200);
    const body = await publish.json() as any;
    assert.equal(body.media.name, 'evil.zip');
    assert.doesNotMatch(body.downloadUrl, /\.\.|%2e/i);
    assert.match(body.downloadUrl, /evil\.zip$/);
  });
});

test('media publish rejects malformed base64', async () => {
  await withMediaApp(async (app) => {
    const publish = await app.request('/api/media/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'report.txt', mimeType: 'text/plain', contentBase64: 'not-valid!!!' }),
    });

    assert.equal(publish.status, 400);
    assert.match(await publish.text(), /invalid media base64/);
  });
});

test('media publish rejects oversize base64 without overflowing the validator stack', async () => {
  await withMediaApp(async (app) => {
    const publish = await app.request('/api/media/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'too-big.txt', mimeType: 'text/plain', contentBase64: Buffer.alloc(12 * 1024 * 1024 + 1).toString('base64') }),
    });

    assert.equal(publish.status, 400);
    assert.match(await publish.text(), /media too large/);
  });
});

test('Windows media reads user-profile uploads and legacy cwd files without HOME', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'windows-media-'));
  const profile = join(directory, 'profile');
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  const previousCwd = process.cwd();
  await mkdir(profile);
  delete process.env.HOME;
  process.env.USERPROFILE = profile;
  process.chdir(directory);
  try {
    const app = new Hono();
    registerMediaRoutes(app);
    const publish = await app.request('/api/media/publish', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'new.txt', mimeType: 'text/plain', contentBase64: Buffer.from('new bytes').toString('base64') }) });
    assert.equal(publish.status, 200);
    const body = await publish.json() as any;
    const download = await app.request(body.media.url);
    assert.equal(download.status, 200);
    assert.equal(await download.text(), 'new bytes');
    const legacy = join(directory, '.openclaw', 'media', 'inbound');
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'old.txt'), 'old bytes');
    const old = await app.request('/api/media/inbound/old.txt');
    assert.equal(old.status, 200);
    assert.equal(await old.text(), 'old bytes');
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
    await rm(directory, { recursive: true, force: true });
  }
});
