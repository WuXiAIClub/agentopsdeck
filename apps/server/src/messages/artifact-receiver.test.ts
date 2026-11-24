import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ArtifactRegistry, artifactCapabilityPreamble, artifactResponse, bridgeArtifactReferences, openArtifactDownload, type ArtifactReceiverConfig } from './artifact-receiver.js';

test('bridges assistant plain local artifact paths into streaming download cards', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cod-artifact-'));
  try {
    const file = path.join(dir, 'report.zip');
    await writeFile(file, Buffer.alloc(128, 7));
    const registry = new ArtifactRegistry(path.join(dir, 'index.json'));
    const bridged = await bridgeArtifactReferences(
      { content: `Done. File ready: ${file}` },
      'assistant',
      { enabled: true, allowedDirs: [dir], maxBytes: 1024 * 1024, indexFile: path.join(dir, 'index.json'), injectCapability: true, allowGatewayClient: true },
      registry,
    );

    assert.equal(bridged.media.length, 1);
    assert.equal(bridged.media[0]?.type, 'file');
    assert.equal(bridged.media[0]?.name, 'report.zip');
    assert.match(bridged.media[0]?.url ?? '', /^\/api\/artifacts\/[a-f0-9]{32}$/);

    const id = bridged.media[0]!.url.split('/').pop()!;
    const opened = await openArtifactDownload(id, { enabled: true, allowedDirs: [dir], maxBytes: 1024 * 1024, indexFile: path.join(dir, 'index.json'), injectCapability: true, allowGatewayClient: true }, registry);
    assert.equal(opened?.record.name, 'report.zip');
    assert.equal(opened?.record.size, 128);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('delivers a generated Markdown report from a standalone path as a downloadable file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cod-artifact-report-'));
  try {
    const file = path.join(dir, 'branch-review.md');
    const content = '# 分支审查\n\n保留 v2，仅吸收必要改动。\n';
    await writeFile(file, content);
    const config: ArtifactReceiverConfig = { enabled: true, allowedDirs: [dir], maxBytes: 1024 * 1024,
      indexFile: path.join(dir, 'index.json'), injectCapability: true, allowGatewayClient: true };
    const registry = new ArtifactRegistry(config.indexFile);
    const bridged = await bridgeArtifactReferences({ content: `完整审查报告：\n\n${file}` }, 'assistant', config, registry);
    assert.equal(bridged.media.length, 1);
    const media = bridged.media[0]!;
    assert.equal(media.type, 'file');
    assert.equal(media.name, 'branch-review.md');
    assert.equal(media.mimeType, 'text/markdown');
    assert.match(media.url, /^\/api\/artifacts\/[a-f0-9]{32}$/);
    const opened = await openArtifactDownload(media.url.split('/').pop()!, config, registry);
    assert.ok(opened);
    const response = artifactResponse({ filePath: opened.path, name: opened.record.name,
      mimeType: opened.record.mimeType, size: opened.record.size,
      request: new Request('http://localhost/api/artifacts/report') });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition') ?? '', /attachment/);
    assert.equal(await response.text(), content);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bridges a native video path containing spaces and parentheses', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cod artifact video '));
  try {
    const file = path.join(dir, 'Big Buck Bunny (2008) - CC BY 3.0.m4v');
    await writeFile(file, Buffer.alloc(128, 7));
    const registry = new ArtifactRegistry(path.join(dir, 'index.json'));
    const bridged = await bridgeArtifactReferences(
      { content: `Test video:\n${file}` },
      'assistant',
      { enabled: true, allowedDirs: [dir], maxBytes: 1024 * 1024, indexFile: path.join(dir, 'index.json'), injectCapability: true, allowGatewayClient: true },
      registry,
    );
    assert.equal(bridged.media.length, 1);
    assert.equal(bridged.media[0]?.name, 'Big Buck Bunny (2008) - CC BY 3.0.m4v');
    assert.equal(bridged.media[0]?.mimeType, 'video/mp4');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bridges assistant sandbox local artifact references', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'artifact-sandbox-'));
  try {
    const artifactPath = path.join(home, 'report.xlsx');
    await writeFile(artifactPath, Buffer.from('PK\x03\x04sandbox'));
    const config: ArtifactReceiverConfig = { enabled: true, allowedDirs: [home], maxBytes: 1024 * 1024, indexFile: path.join(home, 'index.json'), injectCapability: true, allowGatewayClient: true };
    const bridged = await bridgeArtifactReferences(
      { role: 'assistant', text: `Download [report](sandbox:${artifactPath})` },
      'assistant',
      config,
      new ArtifactRegistry(config.indexFile),
    );

    assert.equal(bridged.media.length, 1);
    assert.equal(bridged.media[0]?.name, 'report.xlsx');
    assert.equal(bridged.bridgedReferences.has(`sandbox:${artifactPath}`), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('bridges same-origin URL-wrapped local artifact paths into download cards', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cod-artifact-url-wrapped-'));
  try {
    const file = path.join(dir, 'target_dataset_datasource_parameters_20260813.xlsx');
    await writeFile(file, Buffer.from('PK\x03\x04url-wrapped-xlsx'));
    const registry = new ArtifactRegistry(path.join(dir, 'index.json'));
    const bridged = await bridgeArtifactReferences(
      { content: `下载链接：https://deck.example.invalid${pathToFileURL(file).pathname}` },
      'assistant',
      { enabled: true, allowedDirs: [dir], maxBytes: 1024 * 1024, indexFile: path.join(dir, 'index.json'), injectCapability: true, allowGatewayClient: true, urlWrappedOrigins: ['https://deck.example.invalid'] },
      registry,
    );

    assert.equal(bridged.media.length, 1);
    assert.equal(bridged.media[0]?.type, 'file');
    assert.equal(bridged.media[0]?.name, 'target_dataset_datasource_parameters_20260813.xlsx');
    assert.match(bridged.media[0]?.url ?? '', /^\/api\/artifacts\/[a-f0-9]{32}$/);

    const id = bridged.media[0]!.url.split('/').pop()!;
    const opened = await openArtifactDownload(id, { enabled: true, allowedDirs: [dir], maxBytes: 1024 * 1024, indexFile: path.join(dir, 'index.json'), injectCapability: true, allowGatewayClient: true, urlWrappedOrigins: ['https://deck.example.invalid'] }, registry);
    assert.equal(opened?.record.name, 'target_dataset_datasource_parameters_20260813.xlsx');
    assert.equal(opened?.record.size, 20);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bridges same-origin Markdown URL-wrapped local artifact paths', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cod-artifact-markdown-url-wrapped-'));
  try {
    const file = path.join(dir, 'report.xlsx');
    await writeFile(file, Buffer.alloc(32, 8));
    const registry = new ArtifactRegistry(path.join(dir, 'index.json'));
    const bridged = await bridgeArtifactReferences(
      { content: `Done: [download](https://deck.example.invalid${pathToFileURL(file).pathname})` },
      'assistant',
      { enabled: true, allowedDirs: [dir], maxBytes: 1024 * 1024, indexFile: path.join(dir, 'index.json'), injectCapability: true, allowGatewayClient: true, urlWrappedOrigins: ['https://deck.example.invalid'] },
      registry,
    );

    assert.equal(bridged.media.length, 1);
    assert.equal(bridged.media[0]?.name, 'report.xlsx');
    assert.match(bridged.media[0]?.url ?? '', /^\/api\/artifacts\/[a-f0-9]{32}$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('bridges same-origin direct-child artifacts in openclaw root without allowing nested secrets', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cod-artifact-openclaw-root-'));
  try {
    const openclawRoot = path.join(home, '.openclaw');
    await mkdir(openclawRoot, { recursive: true });
    const file = path.join(openclawRoot, 'fixture-report.xlsx');
    const fileBytes = Buffer.from('PK\x03\x04root-level-xlsx');
    await writeFile(file, fileBytes);
    const indexFile = path.join(home, 'index.json');
    const config = rootDirectChildConfig(openclawRoot, indexFile);
    const registry = new ArtifactRegistry(indexFile);

    const bridged = await bridgeArtifactReferences(
      { content: `下载链接：https://deck.example.invalid${pathToFileURL(file).pathname}` },
      'assistant',
      config,
      registry,
    );

    assert.equal(bridged.media.length, 1);
    assert.equal(bridged.media[0]?.type, 'file');
    assert.equal(bridged.media[0]?.name, 'fixture-report.xlsx');
    assert.match(bridged.media[0]?.url ?? '', /^\/api\/artifacts\/[a-f0-9]{32}$/);

    const id = bridged.media[0]!.url.split('/').pop()!;
    const opened = await openArtifactDownload(id, config, registry);
    assert.equal(opened?.record.name, 'fixture-report.xlsx');
    assert.equal(opened?.record.size, fileBytes.length);

    const ranged = artifactResponse({
      filePath: opened!.path,
      name: opened!.record.name,
      mimeType: opened!.record.mimeType,
      size: opened!.record.size,
      request: new Request('http://localhost/api/artifacts/test', { headers: { range: 'bytes=0-1' } }),
    });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), `bytes 0-1/${fileBytes.length}`);
    assert.equal((await ranged.arrayBuffer()).byteLength, 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('blocks openclaw root config, nested artifacts, and symlinks under direct-child policy', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cod-artifact-openclaw-blocked-'));
  try {
    const openclawRoot = path.join(home, '.openclaw');
    const agentsDir = path.join(openclawRoot, 'agents', 'main');
    const outside = await mkdtemp(path.join(os.tmpdir(), 'cod-artifact-openclaw-outside-'));
    await mkdir(agentsDir, { recursive: true });

    const configFile = path.join(openclawRoot, 'openclaw.json');
    const nestedFile = path.join(agentsDir, 'secret.xlsx');
    const outsideFile = path.join(outside, 'outside.xlsx');
    const nestedSymlink = path.join(openclawRoot, 'nested-link.xlsx');
    const outsideSymlink = path.join(openclawRoot, 'outside-link.xlsx');
    await writeFile(configFile, '{"token":"redacted fixture"}');
    await writeFile(nestedFile, Buffer.alloc(16, 1));
    await writeFile(outsideFile, Buffer.alloc(16, 2));
    await symlink(nestedFile, nestedSymlink);
    await symlink(outsideFile, outsideSymlink);

    const indexFile = path.join(home, 'index.json');
    const config = rootDirectChildConfig(openclawRoot, indexFile);

    for (const [candidate, label] of [
      [configFile, 'root config'],
      [nestedFile, 'nested agents file'],
      [nestedSymlink, 'symlink to nested file'],
      [outsideSymlink, 'symlink to outside file'],
    ] as const) {
      const registry = new ArtifactRegistry(path.join(home, `${label.replace(/\s+/g, '-')}.json`));
      const bridged = await bridgeArtifactReferences(
        { content: `Bad link: https://deck.example.invalid${pathToFileURL(candidate).pathname}` },
        'assistant',
        config,
        registry,
      );
      assert.equal(bridged.media.length, 0, label);

      const info = await stat(candidate);
      const id = `bad${String(label.length).padStart(21, '0')}`.replace(/[^a-f0-9]/g, '0').padEnd(24, '0');
      registry.upsert({
        id,
        path: candidate,
        name: path.basename(candidate),
        mimeType: 'application/octet-stream',
        size: info.size,
        mtimeMs: info.mtimeMs,
        createdAt: Date.now(),
      });
      assert.equal(await openArtifactDownload(id, config, registry), undefined, label);
    }

    await rm(outside, { recursive: true, force: true });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('does not bridge ordinary external URL-wrapped local-looking artifact paths', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cod-artifact-external-url-'));
  try {
    const file = path.join(dir, 'external.xlsx');
    await writeFile(file, Buffer.alloc(32, 5));
    const registry = new ArtifactRegistry(path.join(dir, 'index.json'));
    const bridged = await bridgeArtifactReferences(
      { content: `Remote link: https://example.com${pathToFileURL(file).pathname}` },
      'assistant',
      { enabled: true, allowedDirs: [dir], maxBytes: 1024 * 1024, indexFile: path.join(dir, 'index.json'), injectCapability: true, allowGatewayClient: true, urlWrappedOrigins: ['https://deck.example.invalid'] },
      registry,
    );
    assert.equal(bridged.media.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('does not rescan a rejected URL after parentheses as a local artifact', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'artifact-url-boundary-'));
  try {
    const file = path.join(dir, 'private.mp4');
    await writeFile(file, 'private fixture');
    const config: ArtifactReceiverConfig = { enabled: true, allowedDirs: [dir], maxBytes: 1024, indexFile: path.join(dir, 'index.json'), injectCapability: true, allowGatewayClient: true };
    const result = await bridgeArtifactReferences({ text: `https://example.com/a)${pathToFileURL(file).pathname}` }, 'assistant', config, new ArtifactRegistry(config.indexFile));
    assert.equal(result.media.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('does not bridge same-origin URL-wrapped paths outside allowlist', async () => {
  const allowed = await mkdtemp(path.join(os.tmpdir(), 'cod-artifact-url-allowed-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'cod-artifact-url-outside-'));
  try {
    const file = path.join(outside, 'secret.xlsx');
    await writeFile(file, Buffer.alloc(32, 6));
    const registry = new ArtifactRegistry(path.join(allowed, 'index.json'));
    const bridged = await bridgeArtifactReferences(
      { content: `Bad link: https://deck.example.invalid${pathToFileURL(file).pathname}` },
      'assistant',
      { enabled: true, allowedDirs: [allowed], maxBytes: 1024 * 1024, indexFile: path.join(allowed, 'index.json'), injectCapability: true, allowGatewayClient: true, urlWrappedOrigins: ['https://deck.example.invalid'] },
      registry,
    );
    assert.equal(bridged.media.length, 0);
  } finally {
    await rm(allowed, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('opens artifacts added to the index after registry construction', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cod-artifact-reload-'));
  try {
    const file = path.join(dir, 'late.xlsx');
    await writeFile(file, Buffer.alloc(256, 4));
    const indexFile = path.join(dir, 'index.json');
    const registry = new ArtifactRegistry(indexFile);
    const bridged = await bridgeArtifactReferences(
      { content: `Done. File ready: ${file}` },
      'assistant',
      { enabled: true, allowedDirs: [dir], maxBytes: 1024 * 1024, indexFile, injectCapability: true, allowGatewayClient: true },
      new ArtifactRegistry(indexFile),
    );
    const id = bridged.media[0]!.url.split('/').pop()!;

    const opened = await openArtifactDownload(id, { enabled: true, allowedDirs: [dir], maxBytes: 1024 * 1024, indexFile, injectCapability: true, allowGatewayClient: true }, registry);
    assert.equal(opened?.record.name, 'late.xlsx');
    assert.equal(opened?.record.size, 256);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('does not bridge artifact paths outside allowlist', async () => {
  const allowed = await mkdtemp(path.join(os.tmpdir(), 'cod-artifact-allowed-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'cod-artifact-outside-'));
  try {
    const file = path.join(outside, 'secret.zip');
    await writeFile(file, 'secret');
    const registry = new ArtifactRegistry(path.join(allowed, 'index.json'));
    const bridged = await bridgeArtifactReferences(
      { content: `File ready: ${file}` },
      'assistant',
      { enabled: true, allowedDirs: [allowed], maxBytes: 1024 * 1024, indexFile: path.join(allowed, 'index.json'), injectCapability: true, allowGatewayClient: true },
      registry,
    );
    assert.equal(bridged.media.length, 0);
  } finally {
    await rm(allowed, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('bridges gateway-client local artifact paths when explicitly enabled', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cod-artifact-gateway-client-'));
  try {
    const file = path.join(dir, 'datasources.xlsx');
    await writeFile(file, Buffer.alloc(64, 3));
    const registry = new ArtifactRegistry(path.join(dir, 'index.json'));
    const bridged = await bridgeArtifactReferences(
      { sender: { id: 'gateway-client', label: 'gateway-client' }, content: `路径：${file}` },
      'user',
      { enabled: true, allowedDirs: [dir], maxBytes: 1024 * 1024, indexFile: path.join(dir, 'index.json'), injectCapability: true, allowGatewayClient: true },
      registry,
    );
    assert.equal(bridged.media.length, 1);
    assert.equal(bridged.media[0]?.name, 'datasources.xlsx');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('does not bridge gateway-client local artifact paths when disabled', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cod-artifact-gateway-client-disabled-'));
  try {
    const file = path.join(dir, 'datasources.xlsx');
    await writeFile(file, Buffer.alloc(64, 3));
    const registry = new ArtifactRegistry(path.join(dir, 'index.json'));
    const bridged = await bridgeArtifactReferences(
      { sender: { id: 'gateway-client', label: 'gateway-client' }, content: `路径：${file}` },
      'user',
      { enabled: true, allowedDirs: [dir], maxBytes: 1024 * 1024, indexFile: path.join(dir, 'index.json'), injectCapability: true, allowGatewayClient: false },
      registry,
    );
    assert.equal(bridged.media.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('capability preamble tells agents to avoid MEDIA for large files', () => {
  const preamble = artifactCapabilityPreamble(512 * 1024 * 1024);
  assert.match(preamble, /AgentOpsDeck supports local artifact download cards/);
  assert.match(preamble, /do not use MEDIA:/);
  assert.match(preamble, /absolute local file path/);
});


test('artifactResponse encodes non-ASCII filenames without invalid response headers', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentopsdeck-artifact-response-'));
  const filePath = path.join(dir, 'artifact.txt');
  try {
    await writeFile(filePath, 'hello');
    const response = artifactResponse({
      filePath,
      name: '前端优化报告.txt',
      mimeType: 'text/plain',
      size: 5,
      request: new Request('http://localhost/api/artifacts/test'),
    });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'hello');
    const disposition = response.headers.get('content-disposition') ?? '';
    assert.match(disposition, /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
    assert.match(disposition, /%E5%89%8D%E7%AB%AF%E4%BC%98%E5%8C%96%E6%8A%A5%E5%91%8A\.txt/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('artifactResponse serves video inline with range support for embedded chat playback', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentopsdeck-video-response-'));
  const filePath = path.join(dir, 'clip.mp4');
  try {
    await writeFile(filePath, '0123456789');
    const response = artifactResponse({
      filePath,
      name: 'clip.mp4',
      mimeType: 'video/mp4',
      size: 10,
      request: new Request('http://localhost/api/artifacts/video', { headers: { range: 'bytes=2-5' } }),
    });

    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
    assert.match(response.headers.get('content-disposition') ?? '', /^inline;/);
    assert.equal(await response.text(), '2345');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function rootDirectChildConfig(openclawRoot: string, indexFile: string): ArtifactReceiverConfig {
  return {
    enabled: true,
    allowedDirs: [],
    allowedDirectChildDirs: [openclawRoot],
    directChildAllowedExtensions: ['.xlsx'],
    maxBytes: 1024 * 1024,
    indexFile,
    injectCapability: true,
    allowGatewayClient: true,
    urlWrappedOrigins: ['https://deck.example.invalid'],
  };
}
