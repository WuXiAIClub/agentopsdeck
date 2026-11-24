import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizeMessageText } from './normalize.js';
import { bridgeRawMediaDirectives } from './media-bridge.js';

test('bridges assistant local MEDIA from allowed dirs and suppresses unavailable text', async () => {
  const previousHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), 'cod059-home-'));
  const allowed = await mkdtemp(join(tmpdir(), 'cod059-allowed-'));
  try {
    process.env.HOME = home;
    const filePath = join(allowed, 'report.txt');
    await writeFile(filePath, 'hello bridge');
    const row = { role: 'assistant', text: `done\nMEDIA:${filePath}` };

    const bridged = await bridgeRawMediaDirectives(row, 'assistant', { enabled: true, allowedDirs: [allowed], maxBytes: 12 * 1024 * 1024 });

    assert.equal(bridged.media.length, 1);
    assert.equal(bridged.media[0]?.name, 'report.txt');
    assert.equal(bridged.media[0]?.mimeType, 'text/plain');
    assert.match(bridged.media[0]?.url ?? '', /^\/api\/media\/inbound\/agentopsdeck-.*-report\.txt$/);
    assert.equal(normalizeMessageText(row, { bridgedRawMediaReferences: bridged.bridgedReferences }), 'done');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
    await rm(allowed, { recursive: true, force: true });
  }
});

test('does not bridge user-authored local MEDIA directives', async () => {
  const allowed = await mkdtemp(join(tmpdir(), 'cod059-user-'));
  try {
    const filePath = join(allowed, 'report.txt');
    await writeFile(filePath, 'do not publish');
    const row = { role: 'user', text: `MEDIA:${filePath}` };

    const bridged = await bridgeRawMediaDirectives(row, 'user', { enabled: true, allowedDirs: [allowed], maxBytes: 12 * 1024 * 1024 });

    assert.equal(bridged.media.length, 0);
    assert.equal(bridged.bridgedReferences.size, 0);
    assert.match(normalizeMessageText(row), /media unavailable: local file “report\.txt”/);
  } finally {
    await rm(allowed, { recursive: true, force: true });
  }
});

test('does not bridge assistant MEDIA outside allowed dirs', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'cod059-outside-'));
  const allowed = await mkdtemp(join(tmpdir(), 'cod059-allowed-'));
  try {
    const filePath = join(outside, 'secret.txt');
    await writeFile(filePath, 'secret');
    const row = { role: 'assistant', text: `MEDIA:${filePath}` };

    const bridged = await bridgeRawMediaDirectives(row, 'assistant', { enabled: true, allowedDirs: [allowed], maxBytes: 12 * 1024 * 1024 });

    assert.equal(bridged.media.length, 0);
    assert.match(normalizeMessageText(row), /media unavailable: local file “secret\.txt”/);
  } finally {
    await rm(outside, { recursive: true, force: true });
    await rm(allowed, { recursive: true, force: true });
  }
});

test('bridges assistant file URL MEDIA from allowed dirs and suppresses unavailable text', async () => {
  const previousHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), 'cod087-home-'));
  const allowed = await mkdtemp(join(tmpdir(), 'cod087-allowed-'));
  try {
    process.env.HOME = home;
    const filePath = join(allowed, 'agent output.zip');
    await writeFile(filePath, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const row = { role: 'assistant', text: `done\nMEDIA:file://${filePath}` };

    const bridged = await bridgeRawMediaDirectives(row, 'assistant', { enabled: true, allowedDirs: [allowed], maxBytes: 12 * 1024 * 1024 });

    assert.equal(bridged.media.length, 1);
    assert.equal(bridged.media[0]?.name, 'agent-output.zip');
    assert.equal(bridged.media[0]?.mimeType, 'application/zip');
    assert.match(bridged.media[0]?.url ?? '', /^\/api\/media\/inbound\/agentopsdeck-.*-agent-output\.zip$/);
    assert.equal(normalizeMessageText(row, { bridgedRawMediaReferences: bridged.bridgedReferences }), 'done');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
    await rm(allowed, { recursive: true, force: true });
  }
});

test('bridges assistant structured MediaPath attachment from allowed dirs', async () => {
  const previousHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), 'cod087-home-'));
  const allowed = await mkdtemp(join(tmpdir(), 'cod087-allowed-'));
  try {
    process.env.HOME = home;
    const filePath = join(allowed, 'generated report.zip');
    await writeFile(filePath, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const row = { role: 'assistant', text: 'attached', MediaPath: filePath, MediaType: 'application/zip' };

    const bridged = await bridgeRawMediaDirectives(row, 'assistant', { enabled: true, allowedDirs: [allowed], maxBytes: 12 * 1024 * 1024 });

    assert.equal(bridged.media.length, 1);
    assert.equal(bridged.media[0]?.name, 'generated-report.zip');
    assert.equal(bridged.media[0]?.mimeType, 'application/zip');
    assert.match(bridged.media[0]?.url ?? '', /^\/api\/media\/inbound\/agentopsdeck-.*-generated-report\.zip$/);
    assert.equal(normalizeMessageText(row, { bridgedRawMediaReferences: bridged.bridgedReferences }), 'attached');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
    await rm(allowed, { recursive: true, force: true });
  }
});
