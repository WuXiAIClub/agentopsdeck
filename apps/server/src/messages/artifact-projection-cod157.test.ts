import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArtifactRegistry, bridgeArtifactReferences, type ArtifactReceiverConfig } from './artifact-receiver.js';
import { normalizeMessageText } from './normalize.js';

test('COD-157 projects a synthetic assistant URL row as an artifact card, not a dead URL-only message', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cod157-live-row-'));
  try {
    const openclawRoot = path.join(home, '.openclaw');
    await mkdir(openclawRoot, { recursive: true });
    const artifactPath = path.join(openclawRoot, 'fixture-report.xlsx');
    await writeFile(artifactPath, Buffer.from('PK\x03\x04cod157'));

    const fixturePath = new URL('./fixtures/cod157-live-assistant-url-row.json', import.meta.url);
    const row = JSON.parse((await readFile(fixturePath, 'utf8')).replaceAll('__ARTIFACT_PATH__', artifactPath));
    const config: ArtifactReceiverConfig = {
      enabled: true,
      allowedDirs: [],
      allowedDirectChildDirs: [openclawRoot],
      directChildAllowedExtensions: ['.xlsx'],
      maxBytes: 1024 * 1024,
      indexFile: path.join(home, 'artifacts.json'),
      injectCapability: true,
      allowGatewayClient: true,
      urlWrappedOrigins: ['https://deck.example.invalid'],
    };

    const bridged = await bridgeArtifactReferences(row, 'assistant', config, new ArtifactRegistry(config.indexFile));
    const text = normalizeMessageText(row, { bridgedRawMediaReferences: bridged.bridgedReferences });

    assert.equal(bridged.media.length, 1);
    assert.match(bridged.media[0]?.url ?? '', /^\/api\/artifacts\/[a-f0-9]{32}$/);
    assert.equal(bridged.media[0]?.name, 'fixture-report.xlsx');
    assert.equal(text.includes('https://deck.example.invalid'), false);
    assert.equal(text.includes(artifactPath), false);
    assert.match(text, /测试文件/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('COD-157 leaves unbridged external URLs visible as ordinary links', () => {
  const row = { role: 'assistant', content: [{ type: 'text', text: 'See https://example.com/report.xlsx' }] };
  assert.equal(normalizeMessageText(row), 'See https://example.com/report.xlsx');
});
