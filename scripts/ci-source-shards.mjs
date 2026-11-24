import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { lstat, mkdtemp, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverTests } from './run-source-tests.mjs';
import { partitionManifest, partitionSourceManifest, FULL_SUITE_BATCH_SOURCE_BYTES,
  sourceInventory, createExclusiveEvidenceDirectory, parseSuccessfulSummary,
  recordStrictBatch, assertSuccessfulFullCoverage } from './verify-full-source-batches.mjs';

const fields = ['tests','suites','pass','fail','cancelled','skipped','todo','duration_ms'];
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => hash(JSON.stringify(value));
function keys(value, expected) { assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), 'Unexpected evidence fields'); }
function checkIdentity(identity) {
  keys(identity,['commit','pipeline']);
  assert.match(identity.commit, /^[a-f0-9]{40}$/); assert.match(identity.pipeline, /^[1-9][0-9]*$/);
}
function canonical(summary) {
  for (const field of fields) {
    assert.ok(Number.isFinite(summary[field]) && summary[field]>=0);
    if (field !== 'duration_ms') assert.ok(Number.isSafeInteger(summary[field]));
  }
  return fields.map(field=>`# ${field} ${summary[field]}\n`).join('');
}
async function treeInventory(root, directory) {
  const result=[];
  async function visit(path) {
    const stat=await lstat(join(root,path)); assert.ok(!stat.isSymbolicLink(),'Artifact refuses symbolic links');
    if(stat.isDirectory()) for(const name of (await readdir(join(root,path))).sort()) await visit(join(path,name));
    else { assert.ok(stat.isFile()); result.push({path,sha256:hash(await readFile(join(root,path)))}); }
  }
  await visit(directory); assert.ok(result.length); return result;
}
async function readJson(path) {
  // Check every ancestor: following a symlinked evidence directory is forbidden too.
  let current=resolve(path);
  while (true) { assert.ok(!(await lstat(current)).isSymbolicLink(),'Evidence refuses symbolic links'); const parent=dirname(current); if(parent===current) break; current=parent; }
  assert.ok((await lstat(path)).isFile()); return JSON.parse(await readFile(path,'utf8'));
}
async function snapshot(root,identity,total) {
  checkIdentity(identity);
  const files=await discoverTests(join(root,'apps/server/src'));
  assert.equal(partitionManifest(files).length,total,'Configured shard count does not match complete manifest');
  return {version:1,...identity,total,files,source:await sourceInventory(root),shared:await treeInventory(root,'packages/shared/dist')};
}
export async function prepareSource(root,directory,identity,total=36) {
  const prepared=await snapshot(root,identity,total);
  await createExclusiveEvidenceDirectory(directory);
  await writeFile(join(directory,'prepared.json'),JSON.stringify({...prepared,id:digest(prepared)})+'\n',{flag:'wx',mode:0o600});
}
async function verifyPrepared(root,path,identity,total) {
  const prepared=await readJson(path);
  const expected=await snapshot(root,identity,total);
  assert.deepEqual(prepared,{...expected,id:digest(expected)},'Prepared source/identity mismatch');
  return prepared;
}
async function checkpoint(directory,receipt) {
  const temp=join(directory,'result.next');
  await writeFile(temp,JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});
  await rename(temp,join(directory,'result.json'));
}
async function boundedBatches(root, files) {
  const sizes = new Map(await Promise.all(files.map(async file =>
    [file, (await stat(join(root, 'apps/server/src', file))).size])));
  return partitionSourceManifest(files, sizes);
}
export async function runShard(root,directory,options) {
  const {index,total,prepared:preparedPath,commit,pipeline}=options;
  checkIdentity({commit,pipeline});
  assert.ok(Number.isSafeInteger(index)&&index>0&&index<=total);
  const prepared=await verifyPrepared(root,preparedPath,{commit,pipeline},total);
  const selected=partitionManifest(prepared.files)[index-1];
  await createExclusiveEvidenceDirectory(directory);
  const receipt={version:1,commit,pipeline,index,total,preparedId:prepared.id,concurrency:4,batchTimeoutMs:900000,batchMaximum:32,
    batchSourceByteMaximum:FULL_SUITE_BATCH_SOURCE_BYTES,passed:false,attempts:[]};
  await checkpoint(directory,receipt);
  // Raw payload NEVER resides beneath the published evidence directory.
  const privateDirectory=await mkdtemp(join(tmpdir(),'agentopsdeck-private-batch-'));
  const result={attempts:[],batches:[]};
  try {
    for (const [batchIndex, files] of (await boundedBatches(root, selected)).entries()) {
      await verifyPrepared(root,preparedPath,{commit,pipeline},total);
      const logPath=join(privateDirectory,`batch-${batchIndex+1}.log`);
      const output=createWriteStream(logPath,{flags:'wx',mode:0o600});
      const status=await new Promise((accept,reject)=>{
        const child=spawn(process.execPath,[join(root,'scripts/run-source-tests.mjs'),'server',...files],{cwd:root,stdio:['ignore','pipe','pipe']});
        child.stdout.pipe(output,{end:false}); child.stderr.pipe(output,{end:false});
        output.once('error',reject); child.once('error',reject);
        child.once('close',(code,signal)=>output.end(()=>accept({code,signal})));
      });
      const log=await readFile(logPath,'utf8');
      const attempt={files,...status,sha256:hash(log)};
      receipt.attempts.push({...attempt,summary:null,summarySha256:null,evidenceSha256:null});
      await checkpoint(directory,receipt);
      // Preserve original parser and strict exit/signal recording, never passed:true alone.
      const passed=recordStrictBatch(result,attempt,log);
      if (!passed) {
        // No names/error payload in the public trace. Keep the original private
        // log and continue only after an ordinary exit, never a live child.
        console.error(`SHARD ${index}/${total} batch ${batchIndex+1}: FAILED; private log retained`);
        continue;
      }
      const summary=canonical(parseSuccessfulSummary(log));
      const evidence={files,...status,sha256:hash(log),summary,summarySha256:hash(summary)};
      receipt.attempts[batchIndex]={...evidence,evidenceSha256:digest(evidence)};
      await verifyPrepared(root,preparedPath,{commit,pipeline},total);
      await checkpoint(directory,receipt);
    }
    assertSuccessfulFullCoverage(selected,result);
    receipt.passed=true;
    console.log(`SHARD ${index}/${total}: ${selected.length} files verified`);
  } finally { await checkpoint(directory,receipt); }
}
export async function aggregateSource(root,preparedDirectory,evidenceDirectory,identity,total=36) {
  const prepared=await verifyPrepared(root,join(preparedDirectory,'prepared.json'),identity,total);
  const expected=Array.from({length:total},(_,i)=>`server-${i+1}`).sort();
  assert.deepEqual((await readdir(evidenceDirectory)).sort(),expected,'Missing or unexpected shard evidence');
  const combined={attempts:[],batches:[]};
  for(let index=1;index<=total;index++) {
    const directory=join(evidenceDirectory,`server-${index}`);
    assert.deepEqual(await readdir(directory),['result.json']);
    const receipt=await readJson(join(directory,'result.json'));
    keys(receipt,['version','commit','pipeline','index','total','preparedId','concurrency','batchTimeoutMs','batchMaximum','batchSourceByteMaximum','passed','attempts']);
    assert.deepEqual({...receipt,attempts:[]},{version:1,...identity,index,total,preparedId:prepared.id,concurrency:4,batchTimeoutMs:900000,batchMaximum:32,
      batchSourceByteMaximum:FULL_SUITE_BATCH_SOURCE_BYTES,passed:true,attempts:[]});
    const batches=await boundedBatches(root,partitionManifest(prepared.files)[index-1]);
    assert.equal(receipt.attempts.length,batches.length);
    for (const [batchIndex, attempt] of receipt.attempts.entries()) {
      keys(attempt,['files','code','signal','sha256','summary','summarySha256','evidenceSha256']);
      const {evidenceSha256,...evidence}=attempt;
      assert.equal(evidenceSha256,digest(evidence),'Canonical evidence hash mismatch');
      assert.deepEqual(attempt.files,batches[batchIndex]);
      assert.match(attempt.sha256,/^[a-f0-9]{64}$/);
      assert.equal(attempt.summarySha256,hash(attempt.summary));
      assert.equal(attempt.summary,canonical(parseSuccessfulSummary(attempt.summary)),'Noncanonical summary payload');
      assert.ok(recordStrictBatch(combined,{files:attempt.files,code:attempt.code,signal:attempt.signal},attempt.summary));
    }
  }
  assertSuccessfulFullCoverage(prepared.files,combined);
  await verifyPrepared(root,join(preparedDirectory,'prepared.json'),identity,total);
  console.log(`FULL source manifest aggregated: ${prepared.files.length} files, ${total} unique successful shards`);
}


export function parseShardArguments(args) {
  const result = {};
  for (let i = 0; i < args.length;) {
    const option = args[i++];
    const key = { '--shard': 'index', '--prepared': 'prepared', '--commit': 'commit', '--pipeline': 'pipeline' }[option];
    assert.ok(key && !(key in result), 'Unknown or duplicate shard option');
    if (key === 'index') {
      for (const field of ['index', 'total']) {
        const value = args[i++];
        assert.match(value ?? '', /^[1-9][0-9]*$/);
        result[field] = Number(value);
        assert.ok(Number.isSafeInteger(result[field]));
      }
    } else {
      const value = args[i++];
      assert.ok(value && !value.startsWith('--'), 'Missing shard option value');
      result[key] = value;
    }
  }
  assert.deepEqual(Object.keys(result).sort(), ['commit', 'index', 'pipeline', 'prepared', 'total']);
  assert.ok(result.index <= result.total);
  assert.match(result.commit, /^[a-f0-9]{40}$/);
  assert.match(result.pipeline, /^[1-9][0-9]*$/);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  assert.ok(['prepare','run','aggregate'].includes(command), 'Unknown source evidence command');
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  if (command === 'run') {
    assert.ok(args[0] && !args[0].startsWith('--'), 'Explicit evidence directory required');
    await runShard(root,resolve(args[0]),parseShardArguments(args.slice(1)));
  } else {
    assert.equal(args.length, command === 'prepare' ? 3 : 4, 'Explicit directory/commit/pipeline required');
    const [directory, evidence, commit, pipeline] = command === 'prepare' ? [args[0],null,args[1],args[2]] : args;
    if(command === 'prepare') await prepareSource(root,resolve(directory),{commit,pipeline});
    else await aggregateSource(root,resolve(directory),resolve(evidence),{commit,pipeline});
  }
}
