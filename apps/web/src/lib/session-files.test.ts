import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage, ChatMessageMedia } from '@agentopsdeck/shared';
import { collectSessionFiles, recordedFileDiff } from './session-files.js';

const media = (path = '/repo/a.ts', line = 1): ChatMessageMedia => ({ type: 'file', name: 'a.ts', url: `/api/hub/v1/sessions/s/messages/m/media/${'a'.repeat(64)}`, sourceReference: { href: `${path}:${line}`, path, line } });
const message: ChatMessage = { id: 'm', sessionKey: 's', role: 'assistant', text: 'claimed edits are not evidence', createdAt: 1 };
test('historical diff requires exact native result, path and message identity', () => {
  const detail: ChatMessage = { ...message, role: 'tool', toolPhase: 'result', status: 'sent', toolName: 'fileChange',
    sourceFiles: [{ path: '/repo/a.ts', kind: 'modified' }],
    text: '[tool fileChange]\nstatus: completed\noutput:\n' + JSON.stringify({ status: 'completed', changes: [{ path: '/repo/a.ts', diff: '-old\n+new' }] }) };
  assert.equal(recordedFileDiff(detail, 's', 'm', '/repo/a.ts'), '-old\n+new');
  for (const override of [{ status: 'failed' }, { toolPhase: 'call' }, { role: 'assistant' }, { toolName: 'shell' }, { sourceFiles: [] }, { text: detail.text.slice(0, -5) }]) {
    assert.equal(recordedFileDiff({ ...detail, ...override } as ChatMessage, 's', 'm', '/repo/a.ts'), undefined);
  }
  for (const [session, id, path] of [['other', 'm', '/repo/a.ts'], ['s', 'other', '/repo/a.ts'], ['s', 'm', '/other/a.ts']]) {
    assert.equal(recordedFileDiff(detail, session!, id!, path!), undefined);
  }
  const files = collectSessionFiles([detail, { ...message, id: 'later-ref', createdAt: 5, media: [media()] }], 's').files;
  assert.equal(files[0]!.messageId, 'later-ref'); assert.equal(files[0]!.changeMessageId, 'm', 'later prose must not replace the source of the modification');
});
test('file list only uses current session metadata; prose/user/tool claims do not become edit proof', () => {
  assert.deepEqual(collectSessionFiles([message], 's').files, []);
  assert.equal(collectSessionFiles([{ ...message, media: [media()] }], 'other').files.length, 0);
  for (const role of ['user', 'system', 'tool'] as const) assert.equal(collectSessionFiles([{ ...message, role, media: [media()] }], 's').files.length, 0);
  const row = collectSessionFiles([{ ...message, media: [media()] }], 's').files[0]!;
  assert.equal(row.change, undefined); assert.equal(row.path, '/repo/a.ts');
});
test('aggregates references by path with latest completed edit evidence and stable newest order', () => {
  const edit: ChatMessage = { ...message, role: 'tool', toolPhase: 'result', status: 'sent', sourceFiles: [{ path: '/repo/a.ts', kind: 'modified' }], media: [media()], createdAt: 2 };
  const result = collectSessionFiles([edit, { ...message, createdAt: 3, media: [media('/repo/a.ts', 4)] }, { ...message, createdAt: 4, media: [media('/repo/b.ts')] }], 's');
  assert.deepEqual(result.files.map(f => f.path), ['/repo/b.ts', '/repo/a.ts']);
  assert.equal(result.files[1]?.change, 'modified'); assert.equal(result.files[1]?.mentions, 2);
  assert.equal(result.files[1]?.media?.sourceReference?.line, 4);
  for (const status of ['sending', 'failed', 'outcome_unknown', 'queued'] as const) assert.equal(collectSessionFiles([{ ...edit, status }], 's').files.length, 0);
});
test('deletions visible without preview, future recreation supersedes deletion', () => {
  const deleted: ChatMessage = { ...message, role: 'tool', toolPhase: 'result', status: 'sent', sourceFiles: [{ path: '/repo/a.ts', kind: 'deleted' }] };
  assert.equal(collectSessionFiles([deleted], 's').files[0]?.change, 'deleted');
  const restored: ChatMessage = { ...deleted, createdAt: 2, sourceFiles: [{ path: '/repo/a.ts', kind: 'added' }], media: [media()] };
  assert.equal(collectSessionFiles([deleted, restored], 's').files[0]?.change, 'added');
});
test('bounds loaded history, row count and metadata; rejects malformed or external preview addresses', () => {
  const many = Array.from({ length: 2500 }, (_, i) => ({ ...message, id: String(i), createdAt: i, media: [media(`/repo/${i}.ts`)] }));
  const result = collectSessionFiles(many, 's'); assert.equal(result.files.length, 80); assert.equal(result.limited, true); assert.equal(result.files[0]?.path, '/repo/2499.ts');
  for (const url of ['https://untrusted/file', '/etc/private.ts', '/api/arbitrary', '/api/hub/v1/sessions/s/messages/m/media/short']) {
    assert.equal(collectSessionFiles([{ ...message, media: [{ ...media(), url }] }], 's').files.length, 0);
  }
  const malformed = { ...media(), sourceReference: { href: '/repo/a.ts:1', path: '/different.ts', line: 1 } };
  assert.equal(collectSessionFiles([{ ...message, media: [malformed] }], 's').files.length, 0);
});
import { mergeIndexedSessionFiles } from './session-files.js';
import { fileRecordHistory } from './session-files.js';

test('history retains distinct edits, deduplicates loaded/index evidence and bounds selected path', () => {
  const edit: ChatMessage = { ...message, role: 'tool', toolPhase: 'result', status: 'sent', sourceFiles: [{path:'/repo/a.ts',kind:'modified'}] };
  const entries = Array.from({length:60}, (_, i) => ({path:'/repo/a.ts', kind:'added' as const, messageId:String(i), createdAt:i}));
  const result = fileRecordHistory([{...edit,id:'59',createdAt:59}, {...edit,id:'foreign',sessionKey:'other'}, {...edit,id:'failed',status:'failed'}],entries,'s','/repo/a.ts');
  assert.equal(result.records.length,40); assert.equal(result.limited,true);
  assert.deepEqual(result.records[0],{messageId:'59',createdAt:59,kind:'modified',source:'loaded'});
  assert.equal(result.records[1]?.source,'index');
  assert.equal(fileRecordHistory([edit],entries,'s','/other').records.length,0);
});

test('new edits without preview and deletions never inherit older media, regardless of order', () => {
  const old: ChatMessage = {...message,id:'old',createdAt:1,role:'tool',toolPhase:'result',status:'sent',sourceFiles:[{path:'/repo/a.ts',kind:'modified'}],media:[media()]};
  for (const kind of ['modified','deleted'] as const) {
    const latest: ChatMessage = {...old,id:'latest',createdAt:2,media:[],sourceFiles:[{path:'/repo/a.ts',kind}]};
    for (const input of [[old,latest],[latest,old]]) assert.equal(collectSessionFiles(input,'s').files[0]?.media,undefined);
  }
});

test('native diff rejects explicit errors and oversized or duplicate change envelopes', () => {
  const detail: ChatMessage = {...message,role:'tool',toolPhase:'result',status:'sent',toolName:'fileChange',sourceFiles:[{path:'/repo/a.ts',kind:'modified'}]};
  for (const body of [
    {status:'completed',error:'failure',changes:[{path:'/repo/a.ts',diff:'x'}]},
    {status:'completed',success:false,changes:[{path:'/repo/a.ts',diff:'x'}]},
    {status:'completed',changes:Array.from({length:65},()=>({path:'/repo/a.ts',diff:'x'}))},
    {status:'completed',changes:[{path:'/repo/a.ts',diff:'x'},{path:'/repo/a.ts',diff:'y'}]},
  ]) assert.equal(recordedFileDiff({...detail,text:'[tool fileChange]\nstatus: completed\noutput:\n'+JSON.stringify(body)},'s','m','/repo/a.ts'),undefined);
});

test('indexed evidence merges with live messages without resurrecting old previews or deletions', () => {
  const loaded = [{ path: '/repo/a.ts', lastSeenAt: 10, messageId: 'live', mentions: 1, changeAt: 10, change: 'added' as const, media: media() }];
  assert.equal(mergeIndexedSessionFiles(loaded, [{ path: '/repo/a.ts', kind: 'deleted', createdAt: 9, messageId: 'old' }])[0]!.change, 'added');
  const deleted = mergeIndexedSessionFiles(loaded, [{ path: '/repo/a.ts', kind: 'deleted', createdAt: 11, messageId: 'new' }])[0]!;
  assert.equal(deleted.change, 'deleted'); assert.equal(deleted.media, undefined);
  const restored = mergeIndexedSessionFiles([deleted], [{ path: '/repo/a.ts', kind: 'added', createdAt: 12, messageId: 'restore', media: media() }])[0]!;
  assert.equal(restored.change, 'added'); assert.ok(restored.media);
});
