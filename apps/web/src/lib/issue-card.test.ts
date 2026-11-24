import assert from 'node:assert/strict';
import test from 'node:test';
import { validIssueSources, validIssuePage, type IssueSourceView } from './issue-card.js';
const source: IssueSourceView = { id: 'source', label: 'Source', provider: 'gitlab', origin: 'https://fixture.invalid', project: '12', kinds: ['issue'] };
const item = () => ({ identity: { provider: 'gitlab', origin: source.origin, connection: source.id, project: source.project, kind: 'issue', remoteId: '1' }, sourceKey: 'a'.repeat(64), title: '<script>text</script>', state: 'open', url: `${source.origin}/issues/1`, body: 'plain', updatedAt: 1 });
const page = () => ({ items: [item()], nextCursor: null, observedAt: 1, completeness: 'complete', consistency: 'best_effort', retryAfter: null });
test('source catalog must be unique, explicit HTTPS and read-only', () => {
  assert.equal(validIssueSources({ readOnly: true, sources: [source] }), true);
  for (const v of [null, {}, { readOnly: false, sources: [source] }, { readOnly: true, sources: [source, source] }, { readOnly: true, sources: [{ ...source, origin: 'javascript:alert(1)' }] }]) assert.equal(validIssueSources(v), false);
});
test('issue response fences identity, URL, duplicate rows, bounds and runtime shape', () => {
  assert.equal(validIssuePage(page(), source), true);
  for (const patch of [{ url: 'https://evil.invalid' }, { body: 'x'.repeat(65537) }, { updatedAt: NaN }, { sourceKey: 'bad' }, { identity: { ...item().identity, project: '13' } }]) assert.equal(validIssuePage({ ...page(), items: [{ ...item(), ...patch }] }, source), false);
  assert.equal(validIssuePage({ ...page(), items: [item(), item()] }, source), false);
  for (const value of [null, {}, { ...page(), nextCursor: '../' }, { ...page(), retryAfter: -1 }]) assert.equal(validIssuePage(value, source), false);
});
test('work items require explicit provider capability and cannot masquerade as issues; metadata is bounded',()=>{
  const workSource={...source,kinds:['issue','work_item'] as ('issue'|'work_item')[]};
  assert.equal(validIssueSources({readOnly:true,sources:[workSource]}),true);
  assert.equal(validIssueSources({readOnly:true,sources:[{...workSource,provider:'github'}]}),false);
  const work={...item(),identity:{...item().identity,kind:'work_item'},number:'3',labels:['bug'],assignees:['owner'],typeName:'Task',metadataPartial:true};
  assert.equal(validIssuePage({...page(),items:[work]},workSource,'work_item'),true);
  assert.equal(validIssuePage({...page(),items:[work]},workSource),false);
  assert.equal(validIssuePage({...page(),items:[work]},source,'work_item'),false);
  for(const patch of [{number:3},{number:'0'},{labels:[null]},{assignees:['\n']},{metadataPartial:'yes'},{typeName:'x'.repeat(129)}])
    assert.equal(validIssuePage({...page(),items:[{...work,...patch}]},workSource,'work_item'),false);
});
