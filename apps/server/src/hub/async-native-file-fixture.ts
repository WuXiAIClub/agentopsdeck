import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {TestContext} from 'node:test';
import {Hono} from 'hono';
import {CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER, workspaceFileCardContent, workspaceFileCardResource, type BoardContent, type WorkspaceFileCard} from '@agentopsdeck/shared';
import {ConnectorTokenStore} from '../auth/connector-token.js';
import {ConnectorWorkspaceFiles} from '../connector/workspace-board-files.js';
import {registerConnectorWorkspaceFiles} from '../connector/workspace-board-files-http.js';
import {boardFileCodec, parseBoardFile, serializeBoardFile} from '../connector/workspace-board-file-format.js';
import {cardFileCodec, parseCardFile, serializeCardFile} from '../connector/workspace-file-card-format.js';
import {NODE_ID_HEADER} from '../connector/node-identity.js';
import {PerformanceDiagnostics} from '../diagnostics/performance.js';
import {HubStore} from './hub-store.js';
import {OriginalHubAdministrativeCommands} from './original-administrative-commands.js';
import {AsyncHubMemberOwner} from './async-member-owner.js';
import {createAsyncConnectorClientResolver} from './async-connector-client.js';
import {AsyncHubNativeFiles} from './async-native-files.js';
import {hubMemberEvidence} from './member-owner-domain.js';
import {nativeFileExpectation, validHubNativeFileReply, type HubNativeFileCommand, type HubNativeFileResult, type NativeFileScope} from './member-native-file-domain.js';
import {encodeHubSessionId} from './session-id.js';
import {AsyncNativeFileBackgroundAccess} from './async-native-file-background-access.js';
import {AsyncNativeFileBackground} from './async-native-file-background.js';
import type {NativeFileBackgroundCommand, NativeFileBackgroundResult} from './native-file-background-domain.js';
import type {HubNotebookMachineCommand, HubNotebookMachineResult} from './member-notebook-machine-domain.js';

export const nativeNotebook = JSON.stringify(['hub-notebook', 1]);
export const deferredNative = () => {let resolve!: () => void; const promise = new Promise<void>(r => {resolve = r;}); return {promise, resolve};};
export async function asyncNativeFileFixture(t: TestContext, mode: 'original' | 'worker', domain: NativeFileScope['domain'] = 'board', legacyBindingId?: string,
  seedBeforeMount?: (store: HubStore, sessionId: string) => void) {
  const root = await mkdtemp(join(tmpdir(), 'async-native-file-')), file = join(root, 'hub.sqlite'), directory = join(root, 'files');
  await mkdir(directory, {mode: 0o700});
  const seed = new HubStore(file, 'fixture'), key = seed.identities.issueKey('default');
  (seed as unknown as {db: DatabaseSync}).db.prepare("INSERT INTO hub_roles VALUES ('default','admin',1)").run();
  const admin = seed.identities.issueKey('default'), cookie = seed.identities.createSession(key.token)!;
  seed.ensureLocalConnection({id: 'local', label: 'Local', connectorUrl: 'local://aod-connector', environmentId: 'local', environmentLabel: 'Local', status: 'enabled'});
  const nodeId = 'node_' + randomUUID(), sessionKey = 'codex:' + randomUUID(), sessionId = encodeHubSessionId('local', sessionKey);
  seed.pinConnectionNode('local', 'default', seed.connectionAuthority('local', 'default')!, nodeId);
  seed.boards.save('default', 'default', {title: 'PRIVATE_NATIVE_BOARD', tasks: [], revision: 0, mutationId: randomUUID()});
  seed.notebooks.save('default', {resourceId: nativeNotebook, revision: 0, text: 'new old'});
  const scope: NativeFileScope = {domain, resourceId: domain === 'board' ? 'default' : workspaceFileCardResource('notebook', 'hub:default')};
  const revision = domain === 'board' ? seed.boards.get('default', scope.resourceId).revision : seed.cardFileProjection.get('default', scope.resourceId)!.revision;
  // Historical hot-only bindings must exist BEFORE mounting either owner.
  // New production admission always delegates the real archive as well.
  let legacyDocument: WorkspaceFileCard | undefined;
  if (legacyBindingId) {
    assert.equal(domain, 'card');
    const claim = seed.cardFileProjection.claim.bind(seed.cardFileProjection);
    seed.cardFileProjection.claim = (user, resource, id) => claim(user, resource, id, false);
    assert.ok(seed.cardFiles.prepare({bindingId: legacyBindingId, userId: 'default', resourceId: scope.resourceId,
      sessionId, connectionId: 'local', authority: seed.connectionAuthority('local', 'default')!}, revision));
    assert.ok(seed.cardFiles.activate('default', legacyBindingId));
    legacyDocument = seed.cardFileProjection.get('default', scope.resourceId)!;
    assert.equal(legacyDocument.kind === 'notebook' && legacyDocument.content.archive, undefined);
  }
  seedBeforeMount?.(seed, sessionId);
  await seed.close();
  const db = new DatabaseSync(':memory:'), tokens = new ConnectorTokenStore(join(root, 'tokens')), token = tokens.createTransient(['boards:files'], 'default');
  const remote = domain === 'board' ? new ConnectorWorkspaceFiles(db, directory, owner => owner === 'default', boardFileCodec)
    : new ConnectorWorkspaceFiles(db, directory, owner => owner === 'default', cardFileCodec());
  const app = new Hono();
  app.use('*', async (c, next) => {c.header(CONNECTOR_PROTOCOL_HEADER, String(CONNECTOR_PROTOCOL.max)); c.header(NODE_ID_HEADER, nodeId); await next();});
  const dependencies = {tokens, session: (id: string) => ({exists: id === sessionKey, ready: true}), runtimes: () => ['codex'] as const};
  const routes = domain === 'board'
    ? registerConnectorWorkspaceFiles(app, {...dependencies, boards: remote as ConnectorWorkspaceFiles<BoardContent>})
    : registerConnectorWorkspaceFiles(app, {...dependencies, boards: remote as ConnectorWorkspaceFiles<WorkspaceFileCard>});
  await routes.ready;
  if (legacyDocument) await (remote as ConnectorWorkspaceFiles<WorkspaceFileCard>).install('default', {
    id: legacyBindingId!, sessionKey, content: workspaceFileCardContent(legacyDocument),
  });
  const calls = {install: 0, write: 0, receipt: 0, snapshot: 0, remove: 0, capability: 0, subscribe: 0};
  const hooks: {before?: ((request: Request) => Promise<void> | void) | undefined; after?: ((request: Request, response: Response) => Promise<Response> | Response) | undefined;
    ack?: ((command: HubNativeFileCommand, result: HubNativeFileResult) => Promise<void> | void) | undefined;
    backgroundAck?: ((command: NativeFileBackgroundCommand, result: NativeFileBackgroundResult) => Promise<void> | void) | undefined;
    machineAck?: ((command: HubNotebookMachineCommand, result: HubNotebookMachineResult) => Promise<void> | void) | undefined} = {};
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const headers = {'x-agentopsdeck-key': key.token};
  const request = (signal?: AbortSignal, auth: Record<string, string> = headers) => new Request('http://hub.invalid/native-file', {headers: auth, signal: signal ?? null});
  const evidence = hubMemberEvidence(request());
  let metadata: HubStore | undefined;
  const mount = () => {
    metadata = mode === 'original' ? new HubStore(file, 'fixture') : undefined;
    const owner = metadata ? new OriginalHubAdministrativeCommands(metadata, diagnostics) : new AsyncHubMemberOwner({file, encryptionSecret: 'fixture'}, diagnostics);
    const port: Pick<AsyncHubMemberOwner, 'command'> = {command: async (kind, input) => {
      const result = await owner.command(kind, input);
      if (kind === 'nativeFile') await hooks.ack?.((input as {command: HubNativeFileCommand}).command, result as HubNativeFileResult);
      if (kind === 'notebookMachine') await hooks.machineAck?.(input as HubNotebookMachineCommand, result as HubNotebookMachineResult);
      return result;
    }};
    const resolver = createAsyncConnectorClientResolver(port, {connectionId: 'local', token: token.token, fileBoardToken: token.token, dispatch: async req => {
      const path = new URL(req.url).pathname;
      assert.ok(path.startsWith('/api/connector/v1/workspace/' + (domain === 'board' ? 'board-files' : 'card-files')));
      if (req.method === 'PUT') calls.install++;
      else if (req.method === 'DELETE') calls.remove++;
      else if (req.method === 'POST' && path.endsWith('/subscribe')) calls.subscribe++;
      else if (req.method === 'POST') calls.write++;
      else if (path.endsWith('/snapshot')) calls.snapshot++;
      else if (path.includes('/writes/')) calls.receipt++;
      else if (path.endsWith('-files')) calls.capability++;
      await hooks.before?.(req);
      const response = await app.fetch(req);
      return hooks.after ? hooks.after(req, response) : response;
    }}, diagnostics);
    const service = new AsyncHubNativeFiles(port, resolver, diagnostics);
    const privateOwner = owner.nativeFileBackground();
    const backgroundAccess = new AsyncNativeFileBackgroundAccess({command: async input => {
      const result = await privateOwner.command(input); await hooks.backgroundAck?.(input, result); return result;
    }});
    const background = new AsyncNativeFileBackground(backgroundAccess, ref => resolver.nativeFileBackground!(backgroundAccess, ref), diagnostics);
    return {owner, port, service, resolver, metadata, backgroundAccess, background};
  };
  let current = mount();
  const close = async () => {await current.background.close(); await current.service.close(); await current.resolver.close(); await current.owner.close(); await current.metadata?.close();};
  const ready = async () => {if (current.owner instanceof AsyncHubMemberOwner) await current.owner.open();};
  const command = async (command: HubNativeFileCommand) => {
    const snapshot = await current.owner.command('memberSnapshot', evidence); assert.ok(snapshot);
    const result = await current.owner.command('nativeFile', {evidence, expectedScope: snapshot.recoveryScope, command});
    assert.ok(validHubNativeFileReply(nativeFileExpectation(command), result), JSON.stringify(result));
    return result;
  };
  const ok = async (commandInput: HubNativeFileCommand) => {
    const result = await command(commandInput); assert.ok(result && !('error' in result), JSON.stringify(result)); return result;
  };
  t.after(async () => {
    hooks.ack = undefined; hooks.before = undefined; hooks.after = undefined; hooks.backgroundAck = undefined; hooks.machineAck = undefined;
    await close(); await routes.close(); db.close();
    for (const secret of [key.token, admin.token, cookie, 'PRIVATE_NATIVE_BOARD', nativeNotebook]) assert.equal(logs.join('').includes(secret), false);
    await rm(root, {recursive: true, force: true});
  });
  // Match production ready-before-services without racing migration against
  // a caller's external SQL connection. Cleanup is retained if open rejects.
  await ready();
  return {root, scope, sessionId, revision, key, cookie, calls, hooks, logs, request, command, ok,
    current: () => current,
    begin: (signal?: AbortSignal, auth?: Record<string, string>) => current.service.begin(request(signal, auth), scope),
    reopen: async () => {await close(); current = mount(); await ready();}, close,
    document: async (bindingId: string) => (await ok({...scope, action: 'bind-plan', bindingId, sessionId, revision})).document!,
    remotePath: (id: string) => remote.get('default', id).path,
    notebookRevisions: () => {
      const external = new DatabaseSync(file);
      try {
        const get = (table: string) => (external.prepare(`SELECT revision FROM ${table} WHERE user_id=? AND resource_id=?`).get('default', nativeNotebook) as {revision: number} | undefined)?.revision ?? 0;
        return {hotRevision: get('hub_session_notebooks'), coldRevision: get('hub_notebook_archives')};
      } finally {external.close();}
    },
    sql: (text: string) => {const external = new DatabaseSync(file); try {external.exec(text);} finally {external.close();}},
    revokeKey: async () => {
      const evidence = hubMemberEvidence(request(undefined, {'x-agentopsdeck-key': admin.token}));
      const snapshot = await current.owner.command('memberSnapshot', evidence); assert.ok(snapshot);
      return current.owner.command('memberKeyRevoke', {evidence, expectedScope: snapshot.recoveryScope, userId: 'default', keyId: key.id});
    },
    snapshot: (content: BoardContent | WorkspaceFileCard) => ({state: 'ready' as const, value: (domain === 'board'
      ? parseBoardFile(Buffer.from(serializeBoardFile(content as BoardContent)))
      : parseCardFile(Buffer.from(serializeCardFile(content as WorkspaceFileCard))))!}),
  };
}
