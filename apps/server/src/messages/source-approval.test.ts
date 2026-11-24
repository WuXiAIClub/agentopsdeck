import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync, renameSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SourceApprovals } from './source-approval.js';
import { readSourcePreview } from './source-preview.js';

test('temporary grants wait for async authority and never audit or persist a rejected approval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'source-approval-async-')), file = join(root, 'original.ts');
  const reference = { path: file, href: `${file}:1`, line: 1 }, audit: unknown[] = [];
  const grants = new SourceApprovals(event => audit.push(event));
  try {
    writeFileSync(file, 'original'); let checks = 0;
    assert.equal(await grants.approve('reader', 'session', reference, [root], async () => { await Promise.resolve(); checks++; }), true);
    const totalChecks = checks; assert.ok(totalChecks >= 4);
    grants.revoke('reader', 'session', reference); audit.length = 0;
    for (let boundary = 1; boundary <= totalChecks; boundary++) {
      let current = 0;
      await assert.rejects(grants.approve('reader', 'session', reference, [root], async () => {
        await Promise.resolve(); if (++current === boundary) throw new Error('async revoked');
      }), /async revoked/);
      assert.equal(audit.length, 0);
      assert.equal(await grants.resolve('reader', 'session', reference, [root], async () => {}), undefined);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('approval binds exact file, token and inode; expires, revokes and restarts closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'source-approval-')), file = join(dir, 'source.ts');
  const reference = { path: file, line: 1, href: file + ':1' };
  const audit: unknown[] = []; let clock = 1, authorized = true;
  const guard = () => { if (!authorized) throw new Error('revoked'); };
  const grants = new SourceApprovals(event => audit.push(event), () => clock);
  try {
    writeFileSync(file, 'hello');
    assert.equal(await grants.approve('owner', 'session', reference, [], guard), false);
    assert.equal(await grants.approve('owner', 'session', reference, ['/'], guard), false);
    assert.equal(await grants.approve('owner', 'session', reference, [dir], guard), true);
    const entry = await grants.resolve('owner', 'session', reference, [dir], guard); assert.ok(entry);
    assert.equal(grants.active('owner', 'session', reference, entry), true);
    assert.equal(await grants.resolve('other', 'session', reference, [dir], guard), undefined);
    assert.equal(await grants.resolve('owner', 'other-session', reference, [dir], guard), undefined);
    assert.equal(grants.active('owner', 'other-session', reference, entry), false);
    assert.equal(await grants.resolve('owner', 'session', { ...reference, path: join(dir, 'other.ts') }, [dir], guard), undefined);
    assert.equal(await new SourceApprovals(() => {}).resolve('owner', 'session', reference, [dir], guard), undefined);
    clock += 3_600_001; assert.equal(grants.active('owner', 'session', reference, entry), false);
    assert.equal(await grants.resolve('owner', 'session', reference, [dir], guard), undefined);
    await grants.approve('owner', 'session', reference, [dir], guard);
    assert.equal(grants.active('owner', 'session', reference, entry), false, 'renewal never revives an in-flight old grant');
    grants.revoke('owner', 'session', reference); assert.equal(await grants.resolve('owner', 'session', reference, [dir], guard), undefined);
    await grants.approve('owner', 'session', reference, [dir], guard);
    renameSync(file, file + '.old'); writeFileSync(file, 'replacement');
    assert.equal(await grants.resolve('owner', 'session', reference, [dir], guard), undefined);
    assert.equal(await readSourcePreview(reference, { allowedDirs: [dir], approvedFile: entry }, guard), undefined, 'replacement after grant validation remains denied at open');
    await grants.approve('owner', 'session', reference, [dir], guard);
    authorized = false; await assert.rejects(grants.resolve('owner', 'session', reference, [dir], guard), /revoked/);
    assert.equal(audit.length, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('approval rejects hidden files, symlink escapes and absent project roots', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'source-boundary-')), root = join(dir, 'project'); mkdirSync(root);
  const grants = new SourceApprovals(() => {});
  try {
    writeFileSync(join(dir, 'outside.ts'), 'outside');
    writeFileSync(join(root, '.secret.ts'), 'secret');
    symlinkSync(join(dir, 'outside.ts'), join(root, 'linked.ts'));
    for (const name of ['.secret.ts', 'linked.ts', 'missing.ts']) {
      const file = join(root, name);
      assert.equal(await grants.approve('owner', 'session', { path: file, href: file + ':1', line: 1 }, [root], () => {}), false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
