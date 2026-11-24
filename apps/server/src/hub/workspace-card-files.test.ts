import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_HUB_NOTEBOOK_LAYOUT, emptyNativeDrawio, workspaceFileCardContent, workspaceFileCardResource,
  WORKSPACE_FILE_CARD_KINDS, type WorkspaceFileCard } from '@agentopsdeck/shared';
import { WorkspaceBoards } from './workspace-boards.js';
import { WorkspaceBoardFiles, type FileBoardIntent } from './workspace-board-files.js';
import { WorkspaceCards } from './workspace-cards.js';
import { WorkspaceDrawings } from './workspace-drawings.js';
import { WorkspaceNativeDrawio } from './workspace-native-drawio.js';
import { SessionNotebooks } from './session-notebooks.js';
import { WorkspaceCardConfigurations } from './workspace-card-configurations.js';
import { NativeWorkspaceCardFileProjection } from './workspace-card-file-projection.js';
import { WorkspaceCardFiles } from './workspace-card-files.js';
import { parseCardFile, serializeCardFile } from '../connector/workspace-file-card-format.js';

const samples: WorkspaceFileCard[] = [
  { kind: 'taskboard', content: { title: 'Tasks', tasks: [] } },
  { kind: 'statuscard', content: { title: 'Status', tasks: [] } },
  { kind: 'notebook', content: { title: 'Note', text: '# Hello\n- [ ] Todo', archive: 'Archived evidence' } },
  { kind: 'report', content: { title: 'Report', text: 'Verified findings' } },
  { kind: 'metric-card', content: { title: 'Build', value: 'OK', detail: '', tone: 'green', progress: 100 } },
  { kind: 'drawing', content: { format: 'agentopsdeck-drawing', version: 1, title: 'Whiteboard', nodes: [], edges: [], strokes: [] } },
  { kind: 'native-drawio', content: emptyNativeDrawio() },
  { kind: 'website', content: { title: 'App', connectionId: 'node-1', websiteId: 'preview' } },
  { kind: 'browser', content: { title: 'Docs', url: 'https://example.org/' } },
  { kind: 'research', content: { title: 'Research', query: 'cache', sources: [] } },
  { kind: 'terminal', content: { title: 'Shell', connectionId: 'node-1', targetId: 'daily-shell' } },
  { kind: 'media', content: { title: 'Video', mediaId: 'sample' } },
  { kind: 'dashboard', content: { title: 'Overview', description: '', items: [] } },
];
function fixture() {
  const db = new DatabaseSync(':memory:');
  const stores = { boards: new WorkspaceBoards(db), cards: new WorkspaceCards(db), drawings: new WorkspaceDrawings(db),
    nativeDrawio: new WorkspaceNativeDrawio(db), notebooks: new SessionNotebooks(db), configurations: new WorkspaceCardConfigurations(db),
    sessionNotebook: (user: string, session: string) => user === 'alice' && session === 'owned' ? {
      textId: 'private-session-note', layoutId: 'private-session-layout', fallbackTitle: 'Session note',
    } : undefined };
  let authorized = true;
  const auth = (intent: FileBoardIntent) => authorized && intent.userId === 'alice' && intent.authority === 1;
  const projection = new NativeWorkspaceCardFileProjection(db, stores);
  const files = new WorkspaceCardFiles(db, projection, auth);
  const legacy = new WorkspaceBoardFiles(db, stores.boards, auth);
  const intent = (resourceId: string): FileBoardIntent => ({ bindingId: randomUUID(), userId: 'alice', resourceId,
    sessionId: 'codex:owned', connectionId: 'connector', authority: 1 });
  const bind = (resource: string) => {
    const input = intent(resource);
    assert.ok(files.prepare(input, projection.get('alice', resource)!.revision));
    assert.ok(files.activate('alice', input.bindingId));
    return input;
  };
  return { db, stores, projection, files, legacy, intent, bind, auth, deny: () => { authorized = false; } };
}
const snapshot = (value: WorkspaceFileCard) => ({ state: 'ready' as const, value: parseCardFile(Buffer.from(serializeCardFile(value)))! });

test('hot notebook projection never reads archive text but preserves full-file data and cold CAS', () => {
  const f=fixture();
  try {
    const resource=workspaceFileCardResource('notebook','hub:default'),textId=JSON.stringify(['hub-notebook',1]);
    const binding=f.bind(resource);
    f.files.apply('alice',binding.bindingId,snapshot({kind:'notebook',content:{title:'Note',text:'hot',archive:'cold'.repeat(13_000)}}));
    const full=f.projection.get('alice',resource)!;
    assert.equal(full.kind,'notebook');
    if(full.kind!=='notebook')assert.fail();
    assert.equal(full.content.archive,'cold'.repeat(13_000));
    const getArchive=f.stores.notebooks.getArchive;
    f.stores.notebooks.getArchive=()=>{throw Error('hot read touched cold text');};
    const hot=f.projection.get('alice',resource,'hot')!;
    assert.equal(hot.revision,full.revision);
    assert.equal(Object.hasOwn(hot.content,'archive'),false);
    f.stores.notebooks.getArchive=getArchive;
    const cold=f.stores.notebooks.getArchive('alice',textId);
    assert.ok(f.stores.notebooks.saveArchive('alice',{resourceId:textId,revision:cold.revision,text:cold.text+' newer'},binding.bindingId));
    assert.ok(f.projection.get('alice',resource,'hot')!.revision>hot.revision);
    assert.equal(f.projection.get('alice',resource)!.revision,f.projection.get('alice',resource,'hot')!.revision);
  } finally { f.db.close(); }
});

test('native projection covers every declared kind', () => assert.deepEqual(samples.map(s => s.kind).sort(), [...WORKSPACE_FILE_CARD_KINDS].sort()));
for (const sample of samples) test(`${sample.kind}: Agent file updates native store; durable CAS, owner fence and revoke`, () => {
  const f = fixture();
  try {
    const id = sample.kind === 'notebook' ? `hub:${randomUUID()}` : randomUUID();
    const resource = workspaceFileCardResource(sample.kind, id);
    if (sample.kind === 'metric-card') assert.equal(f.stores.cards.save('alice', id, { ...sample.content, revision: 0, mutationId: randomUUID() }).status, 'saved');
    if (['website', 'browser', 'research', 'terminal', 'media', 'dashboard'].includes(sample.kind))
      assert.equal(f.stores.configurations.save('alice', id, { ...sample, revision: 0, mutationId: randomUUID() }).status, 'saved');
    const initial = f.projection.get('alice', resource)!;
    const binding = f.bind(resource);
    assert.ok(f.projection.get('alice', resource)!.revision > initial.revision, 'bind invalidates older native drafts');
    f.files.apply('alice', binding.bindingId, snapshot(workspaceFileCardContent(f.projection.get('alice', resource)!)));
    assert.equal(f.files.prepareWrite('alice', binding.bindingId, { ...workspaceFileCardContent(initial), revision: initial.revision, mutationId: randomUUID() }), undefined);
    assert.equal(f.files.apply('bob', binding.bindingId, snapshot(sample)), 'denied');
    const changed = { ...sample, content: { ...sample.content, title: 'Agent title' } } as WorkspaceFileCard;
    assert.equal(f.files.apply('alice', binding.bindingId, snapshot(changed)), 'updated');
    const native = f.projection.get('alice', resource)!;
    assert.deepEqual(workspaceFileCardContent(native), workspaceFileCardContent(changed));
    assert.ok(native.revision > initial.revision);
    assert.equal(f.files.apply('alice', binding.bindingId, snapshot(changed)), 'unchanged');
    assert.equal(f.files.apply('alice', binding.bindingId, { state: 'invalid' }), 'retained');
    assert.deepEqual(f.projection.get('alice', resource), native);
    f.files.apply('alice', binding.bindingId, snapshot(changed));
    const write = { ...changed, revision: native.revision, mutationId: randomUUID() };
    assert.equal(f.files.prepareWrite('alice', binding.bindingId, { ...write, revision: native.revision - 1 }), undefined);
    assert.equal(f.files.prepareWrite('alice', binding.bindingId, write)?.fresh, true);
    const restart = new WorkspaceCardFiles(f.db, f.projection, f.auth);
    assert.equal(restart.prepareWrite('alice', binding.bindingId, write)?.fresh, false);
    assert.equal(restart.writeReceipt('alice', binding.bindingId, write.mutationId)?.state, 'uncertain');
    assert.equal(restart.prepareWrite('alice', binding.bindingId, { ...write, content: { ...write.content, title: 'reused' } } as typeof write), undefined);
    const wrongKind: WorkspaceFileCard = sample.kind === 'browser'
      ? { kind: 'report', content: { title: 'bad', text: '' } } : { kind: 'browser', content: { title: 'bad', url: '' } };
    assert.equal(f.files.apply('alice', binding.bindingId, snapshot(wrongKind)), 'invalid');
    assert.ok(restart.revoke('alice', binding.bindingId));
    const released = workspaceFileCardContent(f.projection.get('alice', resource)!);
    assert.deepEqual(released, native.kind === 'notebook'
      ? { kind: 'notebook', content: { title: native.content.title, text: native.content.text } } : workspaceFileCardContent(native));
    assert.ok(f.projection.get('alice', resource)!.revision > native.revision, 'unlink invalidates older file drafts');
    assert.equal(restart.apply('alice', binding.bindingId, snapshot(sample)), 'denied');
  } finally { f.db.close(); }
});

test('legacy tasks and generic status/task views cannot bind the same native resource in either order', () => {
  const f = fixture();
  try {
    const binding = f.bind(workspaceFileCardResource('statuscard', 'default'));
    assert.equal(f.legacy.prepare(f.intent('default'), 0), undefined);
    assert.equal(f.files.prepare(f.intent(workspaceFileCardResource('taskboard', 'default')), 0), undefined);
    f.files.revoke('alice', binding.bindingId);
    const old = f.intent('default'); assert.ok(f.legacy.prepare(old, f.stores.boards.get('alice', 'default').revision));
    assert.equal(f.files.prepare(f.intent(workspaceFileCardResource('statuscard', 'default')), 0), undefined);
    f.legacy.revoke('alice', old.bindingId);
    assert.ok(f.files.prepare(f.intent(workspaceFileCardResource('taskboard', 'default')), f.stores.boards.get('alice', 'default').revision));
  } finally { f.db.close(); }
});

test('private notebook delegates text/title but permits move/resize before the first layout save', () => {
  const f = fixture();
  try {
    const resource = workspaceFileCardResource('notebook', 'hub:default'), binding = f.bind(resource);
    const textId = JSON.stringify(['hub-notebook', 1]), layoutId = JSON.stringify(['hub-notebook-layout', 1, 'default']);
    assert.equal(f.stores.notebooks.save('alice', { resourceId: textId, text: 'bypass', revision: 0 }), undefined);
    assert.ok(f.stores.notebooks.save('alice', { resourceId: layoutId, text: JSON.stringify({ ...DEFAULT_HUB_NOTEBOOK_LAYOUT, x: 222, width: 500 }), revision: f.stores.notebooks.get('alice', layoutId).revision }));
    assert.equal(f.stores.notebooks.save('alice', { resourceId: layoutId, text: JSON.stringify({ ...DEFAULT_HUB_NOTEBOOK_LAYOUT, title: 'bypass' }), revision: 1 }), undefined);
    assert.equal(f.files.apply('alice', binding.bindingId, snapshot({ kind: 'notebook', content: { title: 'Agent', text: 'Content', archive: '' } })), 'updated');
    const layout = JSON.parse(f.stores.notebooks.get('alice', layoutId).text);
    assert.equal(layout.x, 222); assert.equal(layout.width, 500); assert.equal(layout.title, 'Agent');
    f.files.revoke('alice', binding.bindingId);
    assert.equal(f.stores.notebooks.save('alice', { resourceId: textId, text: 'stale before unlink', revision: f.stores.notebooks.get('alice', textId).revision - 1 }), undefined);
    assert.ok(f.stores.notebooks.save('alice', { resourceId: textId, text: 'manual', revision: f.stores.notebooks.get('alice', textId).revision }));
    assert.equal(f.projection.get('bob', workspaceFileCardResource('notebook', 'session:owned')), undefined);
    assert.equal(f.projection.get('alice', workspaceFileCardResource('notebook', 'session:other')), undefined);
    assert.ok(f.projection.get('alice', workspaceFileCardResource('notebook', 'session:owned')));
  } finally { f.db.close(); }
});

test('notebook import rolls back text and archive when title write fails', () => {
  const f = fixture();
  try {
    const resource = workspaceFileCardResource('notebook', 'hub:default'), binding = f.bind(resource);
    const save = f.stores.notebooks.save.bind(f.stores.notebooks);
    f.stores.notebooks.save = (user, input, id) => input.resourceId.includes('layout') ? undefined : save(user, input, id);
    const before = f.projection.get('alice', resource);
    assert.throws(() => f.files.apply('alice', binding.bindingId, snapshot({ kind: 'notebook', content: { title: 'Agent', text: 'New text', archive: 'New archive' } })));
    assert.deepEqual(f.projection.get('alice', resource), before);
    assert.equal(f.files.get('alice', binding.bindingId)?.sourceHash, null);
  } finally { f.db.close(); }
});

test('original owner can unlink a private notebook after session access is revoked', () => {
  const f = fixture();
  try {
    const resource = workspaceFileCardResource('notebook', 'session:owned'), binding = f.bind(resource);
    const before = f.stores.notebooks.get('alice', 'private-session-note');
    f.stores.sessionNotebook = () => undefined;
    f.deny();
    assert.equal(f.projection.get('alice', resource), undefined);
    assert.equal(f.files.revoke('bob', binding.bindingId), false);
    assert.ok(f.files.revoke('alice', binding.bindingId));
    assert.equal(f.files.current('alice', resource), undefined);
    const after = f.stores.notebooks.get('alice', 'private-session-note');
    assert.equal(after.text, before.text);
    assert.ok(after.revision > before.revision);
    assert.equal(f.stores.notebooks.save('alice', { ...before, text: 'stale destination' }), undefined);
  } finally { f.db.close(); }
});

test('ordinary native saves cannot bypass a prepared/active delegation; authority loss stops projection', () => {
  const f = fixture();
  try {
    const id = randomUUID(), sample = samples.find(s => s.kind === 'browser')!;
    f.stores.configurations.save('alice', id, { ...sample, revision: 0, mutationId: randomUUID() });
    const resource = workspaceFileCardResource('browser', id), intent = f.intent(resource);
    assert.ok(f.files.prepare(intent, 1));
    assert.equal(f.stores.configurations.save('alice', id, { ...sample, revision: 1, mutationId: randomUUID() }).status, 'file-managed');
    f.files.activate('alice', intent.bindingId); f.deny();
    assert.equal(f.files.apply('alice', intent.bindingId, snapshot(sample)), 'denied');
    assert.equal(f.files.prepareWrite('alice', intent.bindingId, { ...sample, revision: 1, mutationId: randomUUID() }), undefined);
  } finally { f.db.close(); }
});
