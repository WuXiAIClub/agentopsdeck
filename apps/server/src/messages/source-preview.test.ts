import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSourceReference, type ChatMessage } from '@agentopsdeck/shared';
import { loadConfig } from '../config.js';
import { readSourcePreview, sourceReferenceMedia } from './source-preview.js';
import { projectMessageMedia } from '../hub/message-projection.js';

test('source roots are opt-in, portable JSON configuration, never default HOME or filesystem root', () => {
  assert.deepEqual(loadConfig({}).sourcePreview, { allowedDirs: [] });
  assert.deepEqual(loadConfig({ AOD_SOURCE_PREVIEW_ROOTS: '["/work/my project","/work/second"]' }).sourcePreview?.allowedDirs, ['/work/my project', '/work/second']);
  for (const value of ['/', '{}', '["/"]', '["/work/.."]', '["relative"]', 'not json']) assert.throws(() => loadConfig({ AOD_SOURCE_PREVIEW_ROOTS: value }), /SOURCE_PREVIEW_ROOTS/);
});

test('source preview waits for asynchronous authority before file access and rejects awaited revocation at every boundary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'source-preview-async-')), file = join(root, 'original.ts');
  const reference = { path: file, href: `${file}:1`, line: 1 };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    let checks = 0, finished = false;
    const pending = readSourcePreview(reference, { allowedDirs: [root] }, async () => { if (++checks === 1) await held; });
    void pending.then(() => { finished = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(checks, 1); assert.equal(finished, false);
    writeFileSync(file, 'const afterAuthorization = true;'); release();
    assert.equal((await pending)?.text, 'const afterAuthorization = true;');
    const totalChecks = checks; assert.ok(totalChecks >= 8);
    for (let boundary = 1; boundary <= totalChecks; boundary++) {
      let current = 0;
      await assert.rejects(readSourcePreview(reference, { allowedDirs: [root] }, async () => {
        await Promise.resolve(); if (++current === boundary) throw new Error('async revoked');
      }), /async revoked/);
      assert.equal(current, boundary);
    }
  } finally { release(); rmSync(root, { recursive: true, force: true }); }
});

test('source projection is explicit assistant message membership, including old history; Hub never reads the file', () => {
  const message: ChatMessage = { id: 'm', sessionKey: 's', role: 'assistant', text: '[code](/project/connector-token.ts:118)', createdAt: 1 };
  assert.equal(sourceReferenceMedia(message)[0]?.sourceReference?.line, 118);
  assert.deepEqual(sourceReferenceMedia({ ...message, role: 'user' }), []);
  assert.deepEqual(sourceReferenceMedia({ ...message, role: 'tool' }), []);
  const media = projectMessageMedia(message, 's', '/api/hub/v1/sessions/hub-session');
  assert.match(media![0]!.url, /^\/api\/hub\/v1\/sessions\/hub-session\/messages\/m\/media\/[a-f0-9]{64}$/);
  assert.equal(media![0]!.sourceReference?.path, '/project/connector-token.ts');
});

test('Markdown previews contain the whole document within budget and label larger excerpts by line range', async () => {
  const root = mkdtempSync(join(tmpdir(), 'markdown-preview-'));
  const file = join(root, 'guide.md');
  try {
    const text = Array.from({ length: 100 }, (_, index) => `## Section ${index}`).join('\n');
    writeFileSync(file, text);
    const preview = await readSourcePreview({ href: `${file}:50`, path: file, line: 50 }, { allowedDirs: [root] }, () => {});
    assert.equal(preview?.text, text); assert.equal(preview?.startLine, 1);
    writeFileSync(file, Array.from({ length: 4000 }, (_, index) => `### Section ${index} with more markdown content`).join('\n'));
    const excerpt = await readSourcePreview({ href: `${file}:100`, path: file, line: 100 }, { allowedDirs: [root] }, () => {});
    assert.ok(excerpt && excerpt.startLine > 1 && excerpt.text.split('\n').length < excerpt.totalLines);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('preview reads bounded current lines, rejects roots, traversal, hidden/config/binary/large files and symlink/hardlink escapes', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'source-preview-')), root = join(temp, 'project'); mkdirSync(root);
  const config = { allowedDirs: [root] }, guard = () => {};
  const read = (file: string, line = 1, roots = config) => readSourcePreview({ href: `${file}:${line}`, path: file, line }, roots, guard);
  try {
    const file = join(root, 'connector-token.ts');
    writeFileSync(file, Array.from({ length: 200 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n'));
    const preview = await read(file, 118);
    assert.equal(preview?.startLine, 106); assert.equal(preview?.line, 118); assert.equal(preview?.totalLines, 200);
    assert.ok(preview?.text.includes('const line118 = 118;')); assert.equal(preview?.text.split('\n').length, 45);
    assert.equal(await read(file, 201), undefined); assert.equal(await read(file, 1, { allowedDirs: [] }), undefined);
    assert.equal(await read(file, 1, { allowedDirs: ['/'] }), undefined);
    for (const [name, content] of [['.env', 'secret'], ['config.json', '{"secret":1}'], ['binary.ts', 'a\0b'], ['large.ts', 'a'.repeat(1024 * 1024 + 1)], ['long.ts', 'x'.repeat(100_000)]] as const) {
      const target = join(root, name); writeFileSync(target, content);
      assert.equal(await read(target), undefined, name);
    }
    writeFileSync(join(temp, 'outside.ts'), 'outside'); symlinkSync(join(temp, 'outside.ts'), join(root, 'escape.ts'));
    symlinkSync(join(root, 'config.json'), join(root, 'config-link.ts'));
    linkSync(join(temp, 'outside.ts'), join(root, 'hardlink.ts'));
    for (const file of ['escape.ts', 'config-link.ts', 'hardlink.ts']) assert.equal(await read(join(root, file)), undefined, file);
    assert.equal(parseSourceReference(`${root}/../outside.ts:1`), undefined);
    let checks = 0;
    await assert.rejects(readSourcePreview({ href: file, path: file, line: 1 }, config, () => { if (++checks >= 3) throw new Error('revoked'); }), /revoked/);
    assert.equal(checks, 3);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
