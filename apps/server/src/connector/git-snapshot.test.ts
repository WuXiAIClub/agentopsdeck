import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, open, writeFile, readFile, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitSnapshot, boundedTextDiff } from './git-snapshot.js';
import { GitTreeReader } from './git-tree-reader.js';

test('real linked worktree and packed objects expose branch, staged and working-byte changes without repository config', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'git-linked-packed-'));
  const main = join(temp, 'main'), linked = join(temp, 'linked');
  const git = (...args: string[]) => promisify(execFile)('/usr/bin/git', args, { cwd: main,
    env: { PATH: '/usr/bin:/bin', HOME: temp, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  try {
    await mkdir(main); await git('init', '-b', 'main');
    await writeFile(join(main, 'a.txt'), 'initial\n');
    await git('add', 'a.txt'); await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
    await git('worktree', 'add', '-b', 'feature', linked);
    await git('repack', '-ad'); await git('prune-packed'); await git('pack-refs', '--all');
    await writeFile(join(linked, 'a.txt'), 'working edit\n');
    await writeFile(join(linked, 'b.txt'), 'staged addition\n'); await git('-C', linked, 'add', 'b.txt');
    // A malicious repository config must never reach the isolated object reader.
    await writeFile(join(main, '.git', 'config'), '[include]\npath = /unreadable-config\n[core]\nfsmonitor = false\n[filter "trap"]\nclean = false\nrequired = true\n');
    await writeFile(join(linked, '.gitattributes'), '* filter=trap\n');
    const reader = new GitTreeReader(() => '1'); await reader.register('owner', 'repo', '1', linked);
    const page = await reader.list('owner', 'repo');
    assert.equal(page.gitStatus, 'raw-bytes'); assert.equal(page.branch, 'feature');
    const entry = page.entries.find(e => e.name === 'a.txt')!;
    assert.equal(entry.indexStatus, 'unchanged'); assert.equal(entry.worktreeStatus, 'differs-from-index');
    const staged = page.entries.find(e => e.name === 'b.txt')!;
    assert.equal(staged.indexStatus, 'added'); assert.equal(staged.worktreeStatus, 'matches-index');
    const preview = await reader.preview('owner', 'repo', entry.pathToken);
    assert.match(preview.comparison!.diff!, /-initial\n\+working edit/);
    await reader.register('owner', 'main', '1', main);
    const mainPage = await reader.list('owner', 'main');
    assert.equal(mainPage.branch, 'main'); assert.equal(mainPage.gitStatus, 'raw-bytes');
    assert.equal(mainPage.entries.find(e => e.name === 'a.txt')!.worktreeStatus, 'matches-index');
    // Backlink mismatch cannot authorize another working directory's metadata.
    const gitdir = (await readFile(join(linked, '.git'), 'utf8')).trim().slice(8);
    await writeFile(join(gitdir, 'gitdir'), join(temp, 'other', '.git'));
    assert.equal((await reader.list('owner', 'repo')).gitStatus, 'unsupported');
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('pack symlinks are rejected and alternates never supply missing objects', async () => {
  await fixture(async f => {
    const head = (await readFile(join(f.root, '.git', 'refs', 'heads', 'main'), 'utf8')).trim();
    await rm(join(f.root, '.git', 'objects', head.slice(0,2)), { recursive: true });
    await mkdir(join(f.root, '.git', 'objects', 'info'));
    await writeFile(join(f.root, '.git', 'objects', 'info', 'alternates'), '/not-authorized\n');
    await symlink('/not-authorized', join(f.root, '.git', 'objects', 'pack'));
    const snapshot = await f.snapshot(); assert.equal(snapshot.supported, false);
  });
});

test('pack entry scan rejects non-regular children and stops at the entry limit', async () => {
  for (const mode of ['symlink', 'limit']) await fixture(async f => {
    const head = (await readFile(join(f.root, '.git', 'refs', 'heads', 'main'), 'utf8')).trim();
    await rm(join(f.root, '.git', 'objects', head.slice(0, 2)), { recursive: true });
    const pack = join(f.root, '.git', 'objects', 'pack'); await mkdir(pack);
    if (mode === 'symlink') await symlink('/not-authorized', join(pack, 'pack-invalid.idx'));
    else await Promise.all(Array.from({ length: 257 }, (_, i) => writeFile(join(pack, `entry-${i}`), '')));
    assert.equal((await f.snapshot()).supported, false);
  });
});

const hash = (b: Buffer) => createHash('sha1').update(b).digest();
async function fixture(run: (f: { root: string; snapshot: () => Promise<GitSnapshot>; object: (type: string, body: Buffer) => Promise<string>; revoke: () => void }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-git-snapshot-')); let allowed = true;
  await mkdir(join(root, '.git', 'objects'), { recursive: true });
  await mkdir(join(root, '.git', 'refs', 'heads'), { recursive: true });
  const object = async (type: string, body: Buffer) => {
    const raw = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]), id = hash(raw).toString('hex');
    await mkdir(join(root, '.git', 'objects', id.slice(0, 2)), { recursive: true });
    await writeFile(join(root, '.git', 'objects', id.slice(0, 2), id.slice(2)), deflateSync(raw)); return id;
  };
  const blob = await object('blob', Buffer.from('old\n'));
  const tree = await object('tree', Buffer.concat([Buffer.from('100644 a.txt\0'), Buffer.from(blob, 'hex')]));
  const commit = await object('commit', Buffer.from(`tree ${tree}\n\nfixture\n`));
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(join(root, '.git', 'refs', 'heads', 'main'), commit + '\n');
  const header = Buffer.alloc(12); header.write('DIRC'); header.writeUInt32BE(2, 4); header.writeUInt32BE(1, 8);
  const entry = Buffer.alloc(72); entry.writeUInt32BE(0o100644, 24); Buffer.from(blob, 'hex').copy(entry, 40); entry.writeUInt16BE(5, 60); entry.write('a.txt', 62);
  const index = Buffer.concat([header, entry]); await writeFile(join(root, '.git', 'index'), Buffer.concat([index, hash(index)]));
  await writeFile(join(root, 'a.txt'), 'old\n');
  const handle = await open(root, 'r'), snapshots: GitSnapshot[] = [];
  try { await run({ root, object, revoke: () => { allowed = false; }, snapshot: async () => { const s = await GitSnapshot.read(handle, () => allowed); snapshots.push(s); return s; } }); }
  finally { await Promise.all(snapshots.map(s => s.close())); await handle.close(); await rm(root, { recursive: true, force: true }); }
}
test('loose SHA1 index-v2 fixture compares HEAD/index/worktree and previews exact raw differences', async () => fixture(async f => {
  const s = await f.snapshot(); assert.equal(s.supported, true);
  assert.deepEqual(await s.state(['a.txt']), { indexStatus: 'unchanged', worktreeStatus: 'matches-index' });
  assert.equal((await s.comparison(['a.txt'], 'new\n')).diff, '@@ -1,1 +1,1 @@\n-old\n+new\n');
  assert.equal(await s.valid(), true);
}));
test('real reader list and preview expose raw status without executable git', async () => fixture(async f => {
  await writeFile(join(f.root, 'a.txt'), 'changed\n'); const reader = new GitTreeReader(() => 'epoch');
  await reader.register('owner', 'repo', 'epoch', f.root);
  const page = await reader.list('owner', 'repo'), entry = page.entries.find(e => e.name === 'a.txt')!;
  assert.equal(page.gitStatus, 'raw-bytes'); assert.equal(entry.worktreeStatus, 'differs-from-index');
  const preview = await reader.preview('owner', 'repo', entry.pathToken); assert.match(preview.comparison!.diff!, /\+changed/);
  assert.ok(!JSON.stringify(preview).includes(f.root));
}));
test('missing index, corrupt checksum and unsupported versions are unknown', async () => {
  for (const mode of ['missing','checksum','version']) await fixture(async f => {
    const p = join(f.root, '.git', 'index'), b = await readFile(p);
    if (mode === 'missing') await rm(p); else { b.writeUInt32BE(mode === 'version' ? 4 : 3, 4); if (mode === 'version') hash(b.subarray(0,-20)).copy(b,b.length-20); await writeFile(p,b); }
    const s = await f.snapshot(); assert.equal(s.supported, false); assert.equal((await s.state(['a.txt'])).worktreeStatus, 'unknown');
  });
});
test('symbolic index and FIFO index fail closed without blocking', async () => {
  for (const mode of ['symlink','fifo']) await fixture(async f => {
    const p = join(f.root,'.git','index'); await rename(p,join(f.root,'saved'));
    if(mode==='symlink')await symlink(join(f.root,'saved'),p);else await promisify(execFile)('mkfifo',[p]);
    assert.equal((await f.snapshot()).supported,false);
  });
});
test('gitdir files and symlinked git directories are unsupported', async () => {
  for(const mode of ['file','symlink']) await fixture(async f=>{
    await rename(join(f.root,'.git'),join(f.root,'saved'));
    if(mode==='file')await writeFile(join(f.root,'.git'),'gitdir: saved');else await symlink(join(f.root,'saved'),join(f.root,'.git'));
    assert.equal((await f.snapshot()).supported,false);
  });
});
test('packed refs are resolved; absent loose objects never imply clean', async () => fixture(async f => {
  const p=join(f.root,'.git','refs','heads','main'),commit=(await readFile(p,'utf8')).trim(); await rm(p);
  await writeFile(join(f.root,'.git','packed-refs'),`# pack-refs with: peeled\n${commit} refs/heads/main\n`);
  assert.equal((await f.snapshot()).supported,true);
  await rm(join(f.root,'.git','objects',commit.slice(0,2),commit.slice(2)));
  assert.equal((await f.snapshot()).supported,false);
}));
test('atomic index/ref replacement invalidates directory guards', async () => {
  for(const target of ['index','refs/heads/main']) await fixture(async f=>{
    const s=await f.snapshot(),p=join(f.root,'.git',target); await writeFile(p+'.new',await readFile(p));await rename(p+'.new',p);
    assert.equal(await s.valid(),false);
  });
});
test('authority revocation makes reads unknown and snapshot invalid', async () => fixture(async f=>{
  const s=await f.snapshot();f.revoke();assert.equal(await s.valid(),false);assert.equal((await s.state(['a.txt'])).indexStatus,'unknown');
}));
test('descriptor budget is bounded and unsupported reads do not mean matches', async () => fixture(async f=>{
  const s=await f.snapshot();let last;
  for(let i=0;i<300;i++)last=await s.state(['a.txt']);
  assert.equal(last!.worktreeStatus,'unknown');
}));
test('unborn branches report staged addition, no index entry does not assert untracked', async () => fixture(async f=>{
  await rm(join(f.root,'.git','refs','heads','main'));const s=await f.snapshot();
  assert.equal((await s.state(['a.txt'])).indexStatus,'added');
  assert.deepEqual(await s.state(['unlisted']),{indexStatus:'unknown',worktreeStatus:'not-in-index'});
}));
test('worktree symlink and oversized object fail safely',async()=>fixture(async f=>{
  await rm(join(f.root,'a.txt'));await symlink('/etc/passwd',join(f.root,'a.txt'));
  assert.equal((await(await f.snapshot()).state(['a.txt'])).worktreeStatus,'unknown');
  const p=join(f.root,'.git','refs','heads','main'); const commit=(await readFile(p,'utf8')).trim();
  await writeFile(join(f.root,'.git','objects',commit.slice(0,2),commit.slice(2)),deflateSync(Buffer.alloc(3*1024*1024,65)));
  assert.equal((await f.snapshot()).supported,false);
}));
test('text diff handles insert/delete, trailing newline and output limits',()=>{
  assert.equal(boundedTextDiff('','x\n'),'@@ -0,0 +1,1 @@\n+x\n');
  assert.equal(boundedTextDiff('x\n',''),'@@ -1,1 +0,0 @@\n-x\n');
  assert.match(boundedTextDiff('x','x\n')!,/No newline/);
  assert.equal(boundedTextDiff('x\n'.repeat(4001),'y'),null);
  assert.equal(boundedTextDiff('a'.repeat(131072),'b'.repeat(131072)),null);
});
