import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexRolloutReader, RolloutObservationPendingError } from './rollout-reader.js';
import { RolloutProjection } from './rollout-projection.js';
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return {promise,resolve}; };
const tick = () => new Promise<void>(done => setImmediate(done));
function lease(close: () => Promise<void> = async () => {}) { return new RolloutProjection([{bytes:0,memoryBytes:0,refs:0,lines:async function*(){},close}]); }

test('owned proof timeout retains the original iterator and lease through actual cleanup', async () => {
  const held=gate(), cleaning=gate(), reader=new CodexRolloutReader(); let closes=0,active=true,acquires=0;
  const snapshot=lease(async()=>{assert.equal(active,false); closes++; await cleaning.promise;});
  try {
    await assert.rejects((reader as any).observeLeasedProjectionWithin('path',10,()=>{acquires++;return snapshot;},async (_:unknown,expired:()=>boolean)=>{await held.promise;active=false;assert.equal(expired(),true);return 'late';}),RolloutObservationPendingError);
    assert.equal(closes,0);assert.equal(acquires,1);
    await assert.rejects((reader as any).observeLeasedProjectionWithin('path',10,()=>{acquires++;return snapshot;},async()=>1),RolloutObservationPendingError);assert.equal(acquires,1);
    let closed=false;const close=reader.close();void close.then(()=>{closed=true;});await tick();assert.equal(closed,false);
    held.resolve();await tick();assert.equal(closes,1);assert.equal(closed,false);cleaning.resolve();await close;
    assert.equal(reader.cacheStats().pendingSnapshotWaits,0);
  } finally {held.resolve();cleaning.resolve();await reader.close();}
});

test('timely owned proof transfers the same lease back without a second read',async()=>{
  const reader=new CodexRolloutReader();let closes=0,reads=0;reader.readSnapshot=async()=>{reads++;throw Error('must not read');};
  const snapshot=lease(async()=>{closes++;});const value=await (reader as any).observeLeasedProjectionWithin('path',1000,()=>snapshot,async (original:unknown,expired:()=>boolean)=>{assert.equal(original,snapshot);assert.equal(expired(),false);return 7;});
  assert.equal(value.snapshot,snapshot);assert.equal(value.value,7);assert.equal(reads,0);await reader.close();assert.equal(closes,0);await snapshot.dispose();assert.equal(closes,1);
});

test('owned proof preserves original rejection and retains cleanup failure',async()=>{
  const reader=new CodexRolloutReader(),original=Error('private-proof'),cleanup=Error('private-cleanup');
  await assert.rejects((reader as any).observeLeasedProjectionWithin('path',1000,()=>lease(async()=>{throw cleanup;}),async()=>{throw original;}),error=>error===original);
  await assert.rejects(reader.close(),error=>error===cleanup);
});

test('invalid deadline or closed reader never acquires caller-owned lease',async()=>{
  const reader=new CodexRolloutReader();let acquired=0;const acquire=()=>{acquired++;return lease();};
  await assert.rejects((reader as any).observeLeasedProjectionWithin('path',0,acquire,async()=>1),/Invalid rollout observation deadline/);
  await reader.close();await assert.rejects((reader as any).observeLeasedProjectionWithin('path',10,acquire,async()=>1),/reader closed/);assert.equal(acquired,0);
});
