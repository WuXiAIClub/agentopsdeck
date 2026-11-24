import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { workspaceFileCardResource, type WorkspaceFileCard } from '@agentopsdeck/shared';
import { WorkspaceBoards } from './workspace-boards.js';
import { WorkspaceBoardFiles } from './workspace-board-files.js';
import { WorkspaceCards } from './workspace-cards.js';
import { WorkspaceDrawings } from './workspace-drawings.js';
import { WorkspaceNativeDrawio } from './workspace-native-drawio.js';
import { SessionNotebooks } from './session-notebooks.js';
import { WorkspaceCardConfigurations } from './workspace-card-configurations.js';
import { NativeWorkspaceCardFileProjection } from './workspace-card-file-projection.js';
import { WorkspaceCardFiles } from './workspace-card-files.js';
import { HubFileBoardService, type FileBoardTarget } from './workspace-board-file-service.js';
import { HubFileCardService } from './workspace-card-file-service.js';
import { parseBoardFile, serializeBoardFile } from '../connector/workspace-board-file-format.js';
import { parseCardFile, serializeCardFile } from '../connector/workspace-file-card-format.js';

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(complete => { resolve = complete; });
  return { promise, resolve };
}
function fixture(kind: 'board' | 'card') {
  const db = new DatabaseSync(':memory:');
  const stores = { boards: new WorkspaceBoards(db), cards: new WorkspaceCards(db), drawings: new WorkspaceDrawings(db),
    nativeDrawio: new WorkspaceNativeDrawio(db), notebooks: new SessionNotebooks(db), configurations: new WorkspaceCardConfigurations(db), sessionNotebook: () => undefined };
  const projection = new NativeWorkspaceCardFileProjection(db, stores);
  const boards = new WorkspaceBoardFiles(db, stores.boards, () => true), cards = new WorkspaceCardFiles(db, projection, () => true);
  const resource = kind === 'board' ? 'default' : workspaceFileCardResource('taskboard', 'default');
  const files = kind === 'board' ? boards : cards, bindingId = randomUUID();
  const get = () => kind === 'board' ? stores.boards.get('owner', resource) : projection.get('owner', resource)!;
  assert.ok(files.prepare({ bindingId, userId: 'owner', resourceId: resource, sessionId: 'codex:synthetic', connectionId: 'synthetic', authority: 1 }, get().revision));
  assert.ok(files.activate('owner', bindingId));
  const content = (title: string) => ({ title, tasks: [] });
  const card = (title: string): WorkspaceFileCard => ({ kind: 'taskboard', content: content(title) });
  const snapshot = (title: string) => kind === 'board'
    ? { state: 'ready', value: parseBoardFile(Buffer.from(serializeBoardFile(content(title)))) }
    : { state: 'ready', value: parseCardFile(Buffer.from(serializeCardFile(card(title)))) };
  const apply = (title: string) => kind === 'board'
    ? boards.apply('owner', bindingId, { state: 'ready', value: parseBoardFile(Buffer.from(serializeBoardFile(content(title))))! })
    : cards.apply('owner', bindingId, { state: 'ready', value: parseCardFile(Buffer.from(serializeCardFile(card(title))))! });
  assert.equal(apply('A'), 'updated');
  const subscribed = deferred<void>(), requested = deferred<void>(), reply = deferred<unknown>();
  let waiting = deferred<{ title: string; applied: ReturnType<typeof deferred<void>> } | undefined>(), dispatches = 0;
  async function* events(_ids: string[], signal: AbortSignal) {
    const abort = () => waiting.resolve(undefined);
    signal.addEventListener('abort', abort, { once: true }); subscribed.resolve();
    try {
      while (!signal.aborted) {
        const frame = await waiting.promise;
        if (!frame) break;
        waiting = deferred();
        yield { event: `${kind === 'board' ? 'board' : 'card'}-file.snapshot`, data: JSON.stringify({ id: bindingId, snapshot: snapshot(frame.title) }) };
        frame.applied.resolve();
      }
    } finally { signal.removeEventListener('abort', abort); }
  }
  const client: FileBoardTarget['client'] = {
    async json<Result>(path: string) {
      if (path.endsWith('/writes') || path.endsWith('/snapshot')) { dispatches++; requested.resolve(); return await reply.promise as Result; }
      return { writeProtocol: 1 } as Result;
    }, fileBoardEvents: events, fileCardEvents: events,
  };
  const resolve = () => ({ connectionId: 'synthetic', authority: 1, sessionKey: 'codex:synthetic', client, valid: () => {} });
  const service = kind === 'board' ? new HubFileBoardService(boards, stores.boards, resolve) : new HubFileCardService(cards, resolve);
  return { service, files, bindingId, resource, get, reply, requested, snapshot, apply, subscribed,
    dispatches: () => dispatches,
    title: () => kind === 'board' ? stores.boards.get('owner', resource).title : (projection.get('owner', resource) as { content: { title: string } }).content.title,
    write: (mutationId: string) => kind === 'board'
      ? (service as HubFileBoardService).write('owner', resource, bindingId, { ...content('X'), revision: get().revision, mutationId })
      : (service as HubFileCardService).write('owner', resource, bindingId, { ...card('X'), revision: get().revision, mutationId }),
    feed: async (title: string) => { const applied = deferred<void>(); waiting.resolve({ title, applied }); await applied.promise; },
    close: async () => { await service.close(); db.close(); },
  };
}

for (const kind of ['board', 'card'] as const) for (const operation of ['refresh', 'write'] as const)
for (const observation of ['unchanged', 'sse-aba', 'sse-same', 'external-aba'] as const)
test(`${kind}/${operation}/${observation}: delayed snapshot respects observation generation and receipt facts`, async () => {
  const subject = fixture(kind), mutationId = randomUUID();
  try {
    subject.service.start(); await subject.subscribed.promise;
    const pending = operation === 'refresh' ? subject.service.refresh('owner', subject.resource, subject.bindingId) : subject.write(mutationId);
    await subject.requested.promise;
    const initialHash = subject.files.get('owner', subject.bindingId)!.sourceHash, initialRevision = subject.get().revision;
    if (observation === 'sse-aba') { await subject.feed('B'); await subject.feed('A'); }
    if (observation === 'sse-same') await subject.feed('A');
    if (observation === 'external-aba') { subject.apply('B'); subject.apply('A'); }
    assert.equal(subject.files.get('owner', subject.bindingId)!.sourceHash, initialHash);
    if (observation.endsWith('aba')) assert.ok(subject.get().revision > initialRevision);
    if (observation === 'sse-same') assert.equal(subject.get().revision, initialRevision);
    subject.reply.resolve(operation === 'refresh' ? { snapshot: subject.snapshot('X') } : { receipt: { mutationId, state: 'saved', snapshot: subject.snapshot('X') } });
    await pending;
    assert.equal(subject.title(), observation === 'unchanged' ? 'X' : 'A');
    assert.equal(subject.dispatches(), 1);
    if (operation === 'write') assert.equal(subject.files.writeReceipt('owner', subject.bindingId, mutationId)!.state, 'saved');
  } finally { await subject.close(); }
});
