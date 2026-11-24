import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { ALLOWED_MEDIA_MIME_TYPES, MAX_MEDIA_ITEMS, MAX_MEDIA_BYTES, inboundMediaDirectory, inboundMediaReadDirectory, normalizeSendMessageRequest, persistMediaPayloads, persistUploadedMedia } from './send-message.js';
import { MAX_MESSAGE_CHARS, MAX_TEXT_MESSAGE_BODY_BYTES } from '@agentopsdeck/shared';
import { readJsonBody } from '../utils/http-body.js';

test('uploaded media revalidates authority before each physical file, not just before preparation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'media-revocation-'));
  const media = [1, 2].map(i => ({ type: 'file' as const, name: `${i}.txt`, mimeType: 'text/plain', size: 2, dataUrl: 'data:text/plain;base64,aGk=' }));
  let checks = 0;
  try {
    await assert.rejects(persistUploadedMedia(media, { inboundDir: directory, check: async () => {
      if (++checks === 3) throw Error('Original send authority revoked');
    } }), /revoked/);
    assert.equal(checks, 3); assert.equal((await readdir(directory)).length, 1);
    const denied = join(directory, 'never-created');
    await assert.rejects(persistUploadedMedia(media, { inboundDir: denied, check: async () => { throw Error('Revoked'); } }), /Revoked/);
    await assert.rejects(readdir(denied), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('100k text survives normalization and bounded JSON transport, including Unicode and escaped characters', async () => {
  for (const character of ['a', '文', '\u0001']) {
    const message = character.repeat(MAX_MESSAGE_CHARS);
    const body = await readJsonBody(new Request('http://localhost/messages', { method: 'POST', body: JSON.stringify({ message }) }), MAX_TEXT_MESSAGE_BODY_BYTES);
    assert.deepEqual(normalizeSendMessageRequest(body), { message, deliveryMode: 'web-only', media: [] });
    assert.ok('error' in normalizeSendMessageRequest({ message: message + character }));
  }
});

test('stop target validation preserves explicit identity and rejects metadata on ordinary sends', () => {
  assert.equal((normalizeSendMessageRequest({ message: '/stop', expectedRunId: 'turn:123' }) as any).expectedRunId, 'turn:123');
  for (const expectedRunId of ['', 12, null, 'x'.repeat(257), 'turn\n123']) {
    assert.ok('error' in normalizeSendMessageRequest({ message: '/stop', expectedRunId }));
  }
  assert.ok('error' in normalizeSendMessageRequest({ message: 'hello', expectedRunId: 'turn:123' }));
});

test('normalizeSendMessageRequest preserves credential-like user text exactly', () => {
  const message = 'Keep api_key=fake-key-123 password=fake-password-456 and token=fake-token-789 exactly.';

  const normalized = normalizeSendMessageRequest({ message });

  assert.deepEqual(normalized, {
    message,
    deliveryMode: 'web-only',
    media: [],
  });
});

test('Windows media persistence fails closed until native ACL verification exists', { skip: process.platform !== 'win32' }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'media-profile-'));
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  const previousCwd = process.cwd();
  delete process.env.HOME;
  process.env.USERPROFILE = home;
  process.chdir(home);
  try {
    const bytes = Buffer.from('synthetic-image');
    assert.equal(isAbsolute(inboundMediaDirectory()), true);
    await assert.rejects(persistUploadedMedia([{ type: 'image', name: 'image.png', mimeType: 'image/png', dataUrl: `data:image/png;base64,${bytes.toString('base64')}` }]), /verified POSIX/);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
    await rm(home, { recursive: true, force: true });
  }
});

test('common mobile file attachment MIME types are allowed', () => {
  assert.equal(ALLOWED_MEDIA_MIME_TYPES.has('video/mp4'), true);
  assert.equal(ALLOWED_MEDIA_MIME_TYPES.has('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), true);
});

test('default inbound writes and reads share the AOD data root, not the ambient or native home', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aod-inbound-root-'));
  const previous = { HOME: process.env.HOME, AOD_DATA_DIR: process.env.AOD_DATA_DIR, AOD_NATIVE_HOME: process.env.AOD_NATIVE_HOME };
  try {
    process.env.HOME = join(directory, 'ambient');
    process.env.AOD_DATA_DIR = join(directory, 'aod-data');
    process.env.AOD_NATIVE_HOME = join(directory, 'native-home');
    const [upload] = await persistMediaPayloads([{ name: 'fixture.txt', mimeType: 'text/plain', contentBase64: 'aGk=' }]);
    const root = join(directory, 'aod-data', 'media', 'inbound');
    assert.equal(inboundMediaDirectory(), root);
    assert.equal(inboundMediaReadDirectory('missing.txt'), root);
    assert.equal(inboundMediaReadDirectory(upload!.media.name!), root);
    assert.equal(upload!.filePath.startsWith(root + '/'), true);
    assert.deepEqual(await readFile(upload!.filePath), Buffer.from('hi'));
    await assert.rejects(readdir(process.env.HOME), { code: 'ENOENT' });
    await assert.rejects(readdir(process.env.AOD_NATIVE_HOME), { code: 'ENOENT' });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('private upload directories and files have explicit POSIX modes under umask 022', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aod-media-modes-'));
  const previous = process.umask(0o022);
  try {
    const inboundDir = join(directory, 'new', 'inbound');
    const [upload] = await persistMediaPayloads([{ mimeType: 'text/plain', contentBase64: 'aGk=' }], { inboundDir });
    for (const target of [join(directory, 'new'), inboundDir]) {
      const info = await lstat(target);
      assert.equal(info.mode & 0o777, 0o700); assert.equal(info.uid, process.getuid!());
    }
    const info = await lstat(upload!.filePath);
    assert.equal(info.mode & 0o777, 0o600); assert.equal(info.uid, process.getuid!()); assert.equal(info.nlink, 1);
  } finally { process.umask(previous); await rm(directory, { recursive: true, force: true }); }
});

test('uploads reject insecure existing roots and linked roots or parents without changing them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aod-media-links-'));
  const payload = [{ mimeType: 'text/plain', contentBase64: 'aGk=' }];
  try {
    const insecure = join(directory, 'insecure'); await mkdir(insecure); await chmod(insecure, 0o755);
    await assert.rejects(persistMediaPayloads(payload, { inboundDir: insecure }), /0700/);
    assert.equal((await lstat(insecure)).mode & 0o777, 0o755);
    const linked = join(directory, 'linked'); await symlink(insecure, linked);
    await assert.rejects(persistMediaPayloads(payload, { inboundDir: linked }), /links/);
    await assert.rejects(persistMediaPayloads(payload, { inboundDir: join(linked, 'child') }), /links/);
    assert.deepEqual(await readdir(insecure), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('all definitive batch validation finishes before any directory or file effect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aod-media-validation-'));
  const valid = { mimeType: 'text/plain', contentBase64: 'aGk=' };
  const large = { mimeType: 'text/plain', contentBase64: Buffer.alloc(MAX_MEDIA_BYTES).toString('base64') };
  const batches = [
    [valid, { ...valid, name: 'a'.repeat(256) }],
    [valid, { ...valid, mimeType: 'not/allowed' }],
    [valid, { ...valid, contentBase64: 'a!!!' }],
    [valid, { ...valid, contentBase64: '' }],
    [valid, { ...valid, contentBase64: Buffer.alloc(MAX_MEDIA_BYTES + 1).toString('base64') }],
    [valid, large, large],
    Array.from({ length: MAX_MEDIA_ITEMS + 1 }, () => valid),
  ];
  try {
    for (const [index, batch] of batches.entries()) {
      const inboundDir = join(directory, `batch-${index}`); let checks = 0;
      await assert.rejects(persistMediaPayloads(batch, { inboundDir, check: async () => { checks++; } }));
      assert.equal(checks, 0); await assert.rejects(readdir(inboundDir), { code: 'ENOENT' });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('upload names accept the 200-byte boundary and reject longer names before authority checks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aod-media-name-'));
  const valid = { mimeType: 'text/plain', contentBase64: 'aGk=' };
  try {
    const name = 'a'.repeat(200);
    const [upload] = await persistMediaPayloads([{ ...valid, name }], { inboundDir: directory });
    assert.equal(upload!.media.name, name);
    let checks = 0;
    await assert.rejects(persistMediaPayloads([{ ...valid, name: 'a'.repeat(201) }], {
      inboundDir: directory, check: async () => { checks++; },
    }), /media name is too long/);
    assert.equal(checks, 0);
    assert.equal((await readdir(directory)).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
