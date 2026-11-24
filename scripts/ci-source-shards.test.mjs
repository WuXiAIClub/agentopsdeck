import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import * as shards from './ci-source-shards.mjs';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { copyFile, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverTests } from './run-source-tests.mjs';
import { partitionManifest } from './verify-full-source-batches.mjs';
import { fileURLToPath } from 'node:url';

function editSummary(receipt, edit) {
  const attempt=receipt.attempts[0]; attempt.summary=edit(attempt.summary);
  attempt.summarySha256=createHash('sha256').update(attempt.summary).digest('hex');
  const {evidenceSha256,...evidence}=attempt;
  attempt.evidenceSha256=createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}
const identity = { commit: 'a'.repeat(40), pipeline: '42' };
const summary = '# tests 3\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n# duration_ms 1.5\n';
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ci-shards-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['apps/server/src', 'packages/shared/src', 'packages/shared/dist', 'scripts']) await mkdir(join(root, dir), { recursive: true });
  for (let i=0;i<33;i++) await writeFile(join(root, 'apps/server/src', `${String(i).padStart(3,'0')}.test.ts`), '');
  for (const path of ['pnpm-lock.yaml','tsconfig.base.json','apps/server/tsconfig.json','packages/shared/tsconfig.json',
    'scripts/source-shadow-guard.mjs','scripts/source-shadow-guard.test.mjs','scripts/verify-full-source-batches.mjs',
    'scripts/verify-full-source-batches.test.mjs','scripts/ci-source-shards.mjs','scripts/ci-source-shards.test.mjs']) await writeFile(join(root,path), '');
  await writeFile(join(root,'packages/shared/src/build-info.generated.ts'), 'timestamp exact common bytes');
  await writeFile(join(root,'packages/shared/dist/index.js'), 'compiled shared');
  await writeFile(join(root,'scripts/run-source-tests.mjs'), `console.log('SYNTHETIC_SECRET_DO_NOT_UPLOAD'); console.log(${JSON.stringify(summary)});`);
  return root;
}

test('real source discovery partitions the complete current manifest without fixed-count drift', async () => {
  const files = await discoverTests(fileURLToPath(new URL('../apps/server/src', import.meta.url)));
  const batches = partitionManifest(files);
  assert.equal(batches.length, Math.ceil(files.length / 32));
  assert.deepEqual(batches.flat(), files);
  assert.ok(batches.slice(0, -1).every(batch => batch.length === 32));
  assert.equal(batches.at(-1).length, files.length % 32 || 32);
  assert.equal(new Set(batches.flat()).size,files.length);
});

test('prepared identity and real subprocess shard receipts aggregate exact coverage without publishing secret payload', async t => {
  assert.equal(typeof shards.prepareSource, 'function');
  const root = await fixture(t);
  const prepared = join(root,'.ci-prepared');
  await shards.prepareSource(root, prepared, identity, 2);
  const options = { ...identity, total:2, prepared:join(prepared,'prepared.json') };
  for (const index of [2,1]) await shards.runShard(root, join(root,`.ci-evidence/server-${index}`), { ...options,index });
  await shards.aggregateSource(root, prepared, join(root,'.ci-evidence'), identity,2);
  const evidence = await readFile(join(root,'.ci-evidence/server-1/result.json'),'utf8');
  assert.ok(!evidence.includes('SYNTHETIC_SECRET_DO_NOT_UPLOAD'));
  assert.deepEqual(await readdir(join(root,'.ci-evidence/server-1')),['result.json']);
  const path = join(root,'.ci-evidence/server-1/result.json');
  const original = JSON.parse(evidence);
  for (const mutate of [r=>r.passed=false,r=>r.index=2,r=>r.total=36,r=>r.commit='b'.repeat(40),r=>r.pipeline='43',
    r=>r.preparedId='b'.repeat(64),r=>r.version=0,r=>r.attempts=[],r=>r.attempts.push(r.attempts[0]),
    r=>r.attempts[0].code=1,r=>r.attempts[0].code=null,r=>r.attempts[0].signal='SIGKILL',
    r=>r.attempts[0].files.pop(),r=>editSummary(r,s=>s+'# tests 3\n'),r=>editSummary(r,s=>s.replace('# todo 0','# todo 1')),
    r=>editSummary(r,s=>s+'# SYNTHETIC_SECRET_DO_NOT_UPLOAD\n'),r=>editSummary(r,s=>s.replace('# duration_ms 1.5','# duration_ms 1..5')),
    r=>editSummary(r,s=>s.replace('# pass 2','# pass 0').replace('# skipped 1','# skipped 3')),
    r=>r.attempts[0].summarySha256='0'.repeat(64),r=>editSummary(r,s=>s.replace('# cancelled 0','# cancelled 1')),
    r=>r.attempts[0].sha256='0'.repeat(64),r=>r.attempts[0].sha256='invalid',r=>r.attempts[0].secret='SYNTHETIC_SECRET_DO_NOT_UPLOAD']) {
    const changed = structuredClone(original); mutate(changed); await writeFile(path,JSON.stringify(changed));
    await assert.rejects(shards.aggregateSource(root, prepared,join(root,'.ci-evidence'),identity,2));
  }
  await writeFile(path,evidence);
  await rename(join(root,'.ci-evidence/server-2'),join(root,'saved-server-2'));
  await assert.rejects(shards.aggregateSource(root,prepared,join(root,'.ci-evidence'),identity,2));
  await symlink(join(root,'saved-server-2'),join(root,'.ci-evidence/server-2'),'dir');
  await assert.rejects(shards.aggregateSource(root,prepared,join(root,'.ci-evidence'),identity,2));
  await rm(join(root,'.ci-evidence/server-2'));
  await rename(join(root,'saved-server-2'),join(root,'.ci-evidence/server-2'));
  await writeFile(join(root,'packages/shared/src/build-info.generated.ts'),'different timestamp');
  await assert.rejects(shards.aggregateSource(root,prepared,join(root,'.ci-evidence'),identity,2));
});

test('32-file shard groups retain 128 KiB serial batch budget and strict multi-batch receipts', async t => {
  const root=await fixture(t);
  // Three 70 KiB files must run separately, not in one nominal 32-file batch.
  for (let i=0;i<3;i++) await writeFile(join(root,'apps/server/src',`${String(i).padStart(3,'0')}.test.ts`),'x'.repeat(70*1024));
  const marker=join(root,'calls.jsonl');
  await writeFile(join(root,'scripts/run-source-tests.mjs'),`
    await (await import('node:fs/promises')).appendFile(${JSON.stringify(marker)},JSON.stringify(process.argv.slice(3))+'\\n');
    console.log(${JSON.stringify(summary)});`);
  const prepared=join(root,'.ci-prepared'); await shards.prepareSource(root,prepared,identity,2);
  for (const index of [1,2]) await shards.runShard(root,join(root,`.ci-evidence/server-${index}`),
    {...identity,index,total:2,prepared:join(prepared,'prepared.json')});
  await shards.aggregateSource(root,prepared,join(root,'.ci-evidence'),identity,2);
  const calls=(await readFile(marker,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(calls.map(files=>files.length),[1,1,30,1]);
  const path=join(root,'.ci-evidence/server-1/result.json');
  const original=JSON.parse(await readFile(path,'utf8'));
  assert.equal(original.batchSourceByteMaximum,128*1024);
  assert.equal(original.attempts.length,3);
  for (const edit of [r=>r.batchSourceByteMaximum=256*1024,r=>r.attempts.reverse(),r=>r.attempts.pop(),
    r=>r.attempts.push(r.attempts[0])]) {
    const changed=structuredClone(original); edit(changed); await writeFile(path,JSON.stringify(changed));
    await assert.rejects(shards.aggregateSource(root,prepared,join(root,'.ci-evidence'),identity,2));
  }
});

test('ordinary failing batch preserves red receipt and runs remaining disjoint batches once', async t => {
  const root=await fixture(t), marker=join(root,'calls.jsonl');
  for(let i=0;i<2;i++) await writeFile(join(root,'apps/server/src',`${String(i).padStart(3,'0')}.test.ts`),'x'.repeat(80*1024));
  await writeFile(join(root,'scripts/run-source-tests.mjs'),`
    await (await import('node:fs/promises')).appendFile(${JSON.stringify(marker)},JSON.stringify(process.argv.slice(3))+'\\n');
    console.error('SYNTHETIC_SECRET_DO_NOT_UPLOAD');
    console.log(${JSON.stringify(summary)}); if(process.argv.includes('000.test.ts')) process.exitCode=1;`);
  const prepared=join(root,'.ci-prepared'); await shards.prepareSource(root,prepared,identity,2);
  const path=join(root,'.ci-evidence/server-1');
  await assert.rejects(shards.runShard(root,path,{...identity,index:1,total:2,prepared:join(prepared,'prepared.json')}));
  const raw=await readFile(join(path,'result.json'),'utf8'), receipt=JSON.parse(raw);
  assert.equal(receipt.passed,false); assert.equal(receipt.attempts.length,2);
  assert.deepEqual(receipt.attempts.map(a=>a.code),[1,0]);
  assert.ok(!raw.includes('SYNTHETIC_SECRET_DO_NOT_UPLOAD'));
  const calls=(await readFile(marker,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(calls.length,2); assert.equal(new Set(calls.flat()).size,32);
});

test('real CLI shard invokes precisely one original batch; failed payload stays private and incomplete stays red', async t => {
  const root=await fixture(t);
  for(const name of ['ci-source-shards.mjs','verify-full-source-batches.mjs','source-shadow-guard.mjs'])
    await copyFile(new URL(name,import.meta.url),join(root,'scripts',name));
  // Synthetic runner exports discovery needed by verifier but runs real subprocess when invoked.
  const originalRunner=await readFile(new URL('run-source-tests.mjs',import.meta.url),'utf8');
  const prefix=originalRunner.slice(0, originalRunner.indexOf('if (process.argv[1]'));
  await writeFile(join(root,'scripts/run-source-tests.mjs'),prefix+`
    if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await (await import('node:fs/promises')).appendFile(${JSON.stringify(join(root,'argv.jsonl'))},JSON.stringify(process.argv.slice(2))+'\\n');
    console.log('SYNTHETIC_SECRET_DO_NOT_UPLOAD'); console.log(${JSON.stringify(summary)}); }`);
  const prepared=join(root,'.ci-prepared');
  await shards.prepareSource(root,prepared,identity,2);
  const args=[join(root,'scripts/ci-source-shards.mjs'),'run',join(root,'.ci-evidence/server-2'),
    '--shard','2','2','--prepared',join(prepared,'prepared.json'),'--commit',identity.commit,'--pipeline',identity.pipeline];
  const child=spawnSync(process.execPath,args,{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr); assert.ok(!child.stdout.includes('FULL'));
  assert.deepEqual(JSON.parse((await readFile(join(root,'argv.jsonl'),'utf8')).trim()),['server','032.test.ts']);
  await assert.rejects(shards.aggregateSource(root,prepared,join(root,'.ci-evidence'),identity,2));
  await assert.rejects(shards.runShard(root,join(root,'.ci-evidence/server-2'),{...identity,index:2,total:2,prepared:join(prepared,'prepared.json')}),{code:'EEXIST'});
  const full=spawnSync(process.execPath,[join(root,'scripts/verify-full-source-batches.mjs'),join(root,'full-private')],
    {encoding:'utf8',env:{...process.env,CI_NODE_INDEX:'2',CI_NODE_TOTAL:'2'}});
  assert.equal(full.status,0,full.stderr); assert.match(full.stdout,/# FULL source manifest verified: 33 files/);
  const calls=(await readFile(join(root,'argv.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(calls.length,3); assert.equal(calls[1].length,33); assert.equal(calls[2].length,2);
});

test('fixed 36-job CLI prepare/shard/aggregate executes all 1126 synthetic files exactly once', async t => {
  const root=await fixture(t);
  for(let i=33;i<1126;i++) await writeFile(join(root,'apps/server/src',`${String(i).padStart(4,'0')}.test.ts`),'');
  for(const name of ['ci-source-shards.mjs','verify-full-source-batches.mjs','source-shadow-guard.mjs'])
    await copyFile(new URL(name,import.meta.url),join(root,'scripts',name));
  const originalRunner=await readFile(new URL('run-source-tests.mjs',import.meta.url),'utf8');
  const prefix=originalRunner.slice(0, originalRunner.indexOf('if (process.argv[1]'));
  await writeFile(join(root,'scripts/run-source-tests.mjs'),prefix+`
    if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
      await (await import('node:fs/promises')).appendFile(${JSON.stringify(join(root,'argv.jsonl'))},JSON.stringify(process.argv.slice(2))+'\\n');
      console.error('SYNTHETIC_SECRET_DO_NOT_UPLOAD'); console.log(${JSON.stringify(summary)});
    }`);
  const cli=(name,args)=> {
    const child=spawnSync(process.execPath,[join(root,'scripts',name),...args],{encoding:'utf8'});
    assert.equal(child.status,0,child.stderr); return child;
  };
  const prepared=join(root,'.ci-prepared'), evidence=join(root,'.ci-evidence');
  cli('ci-source-shards.mjs',['prepare',prepared,identity.commit,identity.pipeline]);
  for(let index=36;index>=1;index--) cli('ci-source-shards.mjs',['run',join(evidence,`server-${index}`),
    '--shard',String(index),'36','--prepared',join(prepared,'prepared.json'),'--commit',identity.commit,'--pipeline',identity.pipeline]);
  const accepted=cli('ci-source-shards.mjs',['aggregate',prepared,evidence,identity.commit,identity.pipeline]);
  assert.match(accepted.stdout,/1126 files, 36 unique successful shards/);
  const calls=(await readFile(join(root,'argv.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(calls.length,36); assert.ok(calls.every(call=>call[0]==='server'));
  const actual=calls.flatMap(call=>call.slice(1)); assert.equal(new Set(actual).size,1126);
  assert.deepEqual(actual.sort(),await discoverTests(join(root,'apps/server/src')));
});

test('failed subprocess cannot publish raw secret or a successful receipt; no retries', async t => {
  const root=await fixture(t);
  for(const [name,body,code] of [
    ['nonzero','process.exit(7);',7],
    ['signal',"process.kill(process.pid,'SIGTERM');",null],
    ['truncated',"console.log('# tests 3');",0],
    ['cancelled',`console.log(${JSON.stringify(summary.replace('# cancelled 0','# cancelled 1'))});`,0],
    ['todo',`console.log(${JSON.stringify(summary.replace('# todo 0','# todo 1'))});`,0],
    ['duplicate',`console.log(${JSON.stringify(summary+summary)});`,0],
  ]) {
    const marker=join(root,`calls-${name}`);
    await writeFile(join(root,'scripts/run-source-tests.mjs'),`(await import('node:fs')).appendFileSync(${JSON.stringify(marker)},'x'); console.error('SYNTHETIC_SECRET_DO_NOT_UPLOAD'); ${body}`);
    const prepared=join(root,`.prepared-${name}`); await shards.prepareSource(root,prepared,identity,2);
    const directory=join(root,`.evidence-${name}/server-1`);
    await assert.rejects(shards.runShard(root,directory,{...identity,index:1,total:2,prepared:join(prepared,'prepared.json')}));
    const receipt=await readFile(join(directory,'result.json'),'utf8');
    assert.ok(!receipt.includes('SYNTHETIC_SECRET_DO_NOT_UPLOAD'));
    assert.equal(JSON.parse(receipt).passed,false); assert.equal(JSON.parse(receipt).attempts.length,1);
    assert.equal(JSON.parse(receipt).attempts[0].code,code);
    assert.equal(await readFile(marker,'utf8'),'x','no second child or retry');
  }
});

test('prepared source guards reject adjacent JS, symlinks, fixed-count mismatch and mid-child drift', async t => {
  const root=await fixture(t);
  await assert.rejects(shards.prepareSource(root,join(root,'wrong-count'),identity),/shard count/);
  const shadow=join(root,'apps/server/src/000.test.js'); await writeFile(shadow,'');
  await assert.rejects(shards.prepareSource(root,join(root,'shadow'),identity,2),/shadows/);
  await rm(shadow);
  const link=join(root,'packages/shared/src/linked'); await symlink(join(root,'packages/shared/dist'),link,'dir');
  await assert.rejects(shards.prepareSource(root,join(root,'linked'),identity,2),/symbolic links/);
  await rm(link);
  await writeFile(join(root,'scripts/run-source-tests.mjs'),`
    await (await import('node:fs/promises')).writeFile(${JSON.stringify(join(root,'packages/shared/src/build-info.generated.ts'))},'child changed timestamp');
    console.log(${JSON.stringify(summary)});`);
  const prepared=join(root,'.ci-prepared'); await shards.prepareSource(root,prepared,identity,2);
  const directory=join(root,'.ci-evidence/server-1');
  await assert.rejects(shards.runShard(root,directory,{...identity,index:1,total:2,prepared:join(prepared,'prepared.json')}),/Prepared source/);
  assert.equal(JSON.parse(await readFile(join(directory,'result.json'),'utf8')).passed,false);
});

test('explicit shard arguments fail closed and never consult shard environment', () => {
  assert.equal(typeof shards.parseShardArguments, 'function');
  const identity = ['--prepared', 'prepared.json', '--commit', 'a'.repeat(40), '--pipeline', '42'];
  assert.deepEqual(shards.parseShardArguments(['--shard', '2', '36', ...identity]),
    { index: 2, total: 36, prepared: 'prepared.json', commit: 'a'.repeat(40), pipeline: '42' });
  for (const args of [[], ['--shard','0','36'], ['--shard','1.5','36'], ['--shard','-1','36'], ['--shard','NaN','36'], ['--shard','9007199254740992','9007199254740992'], ['--shard','37','36'], ['--shard','1'],
    ['--shard','1','36',...identity,'--shard','1','36'], ['--shard','1','36',...identity,'--unknown','x'],
    ['--shard','1','36',...identity.slice(0,-2)]]) assert.throws(() => shards.parseShardArguments(args));
});
