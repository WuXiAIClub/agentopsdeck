import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { WORKSPACE_FILE_CARD_MAX_BYTES, validWorkspaceFileCardResource, validWorkspaceFileCardWrite,
  parseWorkspaceFileCardResource, validBoardUuid, workspaceFileCardContent } from '@agentopsdeck/shared';
import type { AsyncHubFileBindingReads } from '../hub/async-file-binding-reads.js';
import type { AsyncHubWorkspaceReports } from '../hub/async-workspace-reports.js';
import type { AsyncHubWorkspaceProjections } from '../hub/async-workspace-projections.js';
import type { AsyncHubWorkspaceConfigurations } from '../hub/async-workspace-configurations.js';
import { HUB_CONFIGURATION_KINDS, type HubConfigurationKind } from '../hub/member-configuration-domain.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import type { HubStore } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';
import { HubArchiveUpgradeRejected, type HubFileCardService } from '../hub/workspace-card-file-service.js';
import { HubFileBoardError } from '../hub/workspace-board-file-service.js';
import { registerHubWorkspaceFiles } from './hub-workspace-board-files.js';
import { publicFileBoardBinding } from '../hub/workspace-board-files.js';
import { readJsonBody } from '../utils/http-body.js';
import { beginNativeEditorRequest, writeBoundNativeCard, type NativeFileWriteDependencies } from './hub-native-file-write.js';
import type { AsyncHubNativeFiles } from '../hub/async-native-files.js';

type AsyncCardFiles = {
  mode: 'async'; nativeFiles: Pick<AsyncHubNativeFiles, 'begin'>;
  editorAccess: NonNullable<NativeFileWriteDependencies['editorAccess']>;
  reports: Pick<AsyncHubWorkspaceReports, 'save'>;
  projections: Pick<AsyncHubWorkspaceProjections, 'get'>;
  configurations: Pick<AsyncHubWorkspaceConfigurations, 'get' | 'save'>;
  enabled: boolean;
};
type LegacyCardFiles = {
  mode?: 'legacy';
  bindingReads?: Pick<AsyncHubFileBindingReads, 'read'>;
  nativeFiles?: Pick<AsyncHubNativeFiles, 'begin'>;
  editorAccess?: NativeFileWriteDependencies['editorAccess'];
  reports?: Pick<AsyncHubWorkspaceReports, 'save'>;
  projections?: Pick<AsyncHubWorkspaceProjections, 'get'>;
  configurations?: Pick<AsyncHubWorkspaceConfigurations, 'get' | 'save'>;
  store: HubStore; principal: (c: Context) => HubPrincipal; service?: HubFileCardService; enabled: boolean;
};
export function registerHubCardFiles(app: Hono, deps: AsyncCardFiles | LegacyCardFiles) {
  if (deps.mode === 'async' && (!deps.nativeFiles || typeof deps.nativeFiles.begin !== 'function'
    || !deps.editorAccess || typeof deps.editorAccess.begin !== 'function'
    || !deps.reports || typeof deps.reports.save !== 'function'
    || !deps.projections || typeof deps.projections.get !== 'function'
    || !deps.configurations || typeof deps.configurations.get !== 'function' || typeof deps.configurations.save !== 'function'))
    throw Error('Hub card file dependencies unavailable');
  const legacy = () => {
    if (deps.mode === 'async') throw Error('Hub card file legacy operation unavailable');
    return deps;
  };
  const base = '/api/hub/v1/workspace/file-cards/:resourceId';
  const actor = async (c: Context) => {
    const authority = await beginNativeEditorRequest(c, deps.mode === 'async'
      ? {editorAccess: deps.editorAccess} : deps);
    return {...authority.principal, check: authority.check};
  };
  const run = async (work: () => Promise<Response>) => {
    try { return await work(); } catch (error) {
      if (!(error instanceof HubMemberRequestError)) throw error;
      if (error.status === 499) return new Response(JSON.stringify({ error: 'request_cancelled' }), {
        status: 499, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
      throw new HTTPException(error.status, { message: error.status === 503
        ? 'Workspace content temporarily unavailable' : 'Workspace access changed' });
    }
  };
  const configuration = (c: Context) => {
    const ref = parseWorkspaceFileCardResource(c.req.param('resourceId'));
    if (!ref || c.req.url.includes('?') || !HUB_CONFIGURATION_KINDS.includes(ref.kind as HubConfigurationKind)) throw new HTTPException(400);
    return { kind: ref.kind as HubConfigurationKind, id: ref.id };
  };
  app.post(`${base}/file-binding/:id/include-archive`, c => run(async () => {
    c.header('Cache-Control', 'no-store');
    const resource = c.req.param('resourceId');
    if (c.req.url.includes('?') || parseWorkspaceFileCardResource(resource)?.kind !== 'notebook' || !validBoardUuid(c.req.param('id'))) throw new HTTPException(400);
    // Extract original HTTP evidence before body awaits; no synchronous
    // principal/store/service is consulted in the async composition.
    const port = deps.nativeFiles ? await deps.nativeFiles.begin(c.req.raw, {domain: 'card', resourceId: resource!}) : undefined;
    const owner = port ? undefined : legacy().principal(c).userId;
    const input = await readJsonBody(c.req.raw, 4096) as { requestId?: unknown; revision?: unknown } | undefined;
    if (!input || Object.keys(input).sort().join(',') !== 'requestId,revision' || !validBoardUuid(input.requestId)
      || !Number.isSafeInteger(input.revision) || (input.revision as number) < 0) throw new HTTPException(400);
    if (port) {
      if (!deps.enabled) throw new HTTPException(503);
      return c.json(await port.includeArchive(c.req.param('id')!, input.requestId, input.revision as number));
    }
    const source = legacy();
    if (source.principal(c).userId !== owner) throw new HTTPException(401);
    if (!source.service || !deps.enabled) throw new HTTPException(503);
    try {
      const receipt = await source.service.includeArchive(owner!, resource!, c.req.param('id')!, input.requestId, input.revision as number);
      if (source.principal(c).userId !== owner) throw new HTTPException(401);
      return c.json({ receipt });
    } catch (error) {
      // Explicit negative evidence, not a guessed outcome from an HTTP failure.
      // No intent was admitted and no delayed Connector write can follow.
      if (error instanceof HubArchiveUpgradeRejected && source.principal(c).userId === owner) return c.json({ notAdmitted: true });
      if (error instanceof HubFileBoardError) throw new HTTPException(error.status);
      throw error;
    }
  }));
  const protocol = {
    base: `${base}/file-binding`, parameter: 'resourceId', validResource: validWorkspaceFileCardResource,
    validWrite: validWorkspaceFileCardWrite, maxBytes: WORKSPACE_FILE_CARD_MAX_BYTES + 4096,
  };
  if (deps.mode === 'async') registerHubWorkspaceFiles(app, {mode: 'async', nativeFiles: deps.nativeFiles,
    enabled: deps.enabled, bindingDomain: 'card'}, protocol);
  else if (deps.service) registerHubWorkspaceFiles(app, { principal: deps.principal, files: deps.store.cardFiles,
    service: deps.service, enabled: deps.enabled, ...(deps.nativeFiles ? {nativeFiles: deps.nativeFiles} : {}),
    ...(deps.bindingReads ? { bindingReads: deps.bindingReads } : {}), bindingDomain: 'card' }, protocol);
  else app.get(`${base}/file-binding`, c => run(async () => {
    const user = await actor(c), resource = c.req.param('resourceId');
    if (!validWorkspaceFileCardResource(resource)) throw new HTTPException(400);
    const source = legacy();
    const current = source.bindingReads ? await source.bindingReads.read(c.req.raw, user.userId, { domain: 'card', action: 'current', resourceId: resource })
      : source.store.cardFiles.current(user.userId, resource); await user.check();
    c.header('Cache-Control', 'no-store');
    return c.json({ enabled: false, binding: current ? publicFileBoardBinding(current) : null });
  }));
  app.get(base, c => run(async () => {
    const user = await actor(c), resource = c.req.param('resourceId');
    if (!validWorkspaceFileCardResource(resource) || c.req.url.includes('?')) throw new HTTPException(400);
    const document = deps.projections ? await deps.projections.get(c.req.raw, user.userId, resource)
      : legacy().store.cardFileProjection.get(user.userId, resource);
    await user.check();
    if (!document) throw new HTTPException(404);
    return c.json(document);
  }));
  // A service pane need not have saved configuration yet. Absence is an
  // ordinary read result, not a missing content document or a write request.
  app.get(`${base}/configuration`, c => run(async () => {
    const user = await actor(c), ref = configuration(c);
    const document = deps.configurations ? await deps.configurations.get(c.req.raw, user.userId, ref.kind, ref.id)
      : legacy().store.cardConfigurations.get(user.userId, ref.kind, ref.id) ?? null;
    await user.check();
    // Preserve the original projection wire: GET excludes updatedAt, PUT retains it.
    return c.json({ document: document ? { ...workspaceFileCardContent(document), revision: document.revision } : null });
  }));
  app.put(`${base}/document`, c => run(async () => {
    c.header('Cache-Control', 'no-store');
    const authority = await beginNativeEditorRequest(c, deps.mode === 'async'
      ? {editorAccess: deps.editorAccess} : deps), user = authority.principal.userId;
    const resource = c.req.param('resourceId'), ref = parseWorkspaceFileCardResource(resource);
    if (deps.editorAccess && (!deps.reports || !deps.projections || !deps.nativeFiles)) throw new HTTPException(503);
    if (!ref || ref.kind !== 'report' || c.req.url.includes('?')) throw new HTTPException(400);
    const input = await readJsonBody(c.req.raw, WORKSPACE_FILE_CARD_MAX_BYTES + 4096);
    await authority.check();
    if (!validWorkspaceFileCardWrite(input) || input.kind !== 'report') throw new HTTPException(400);
    // Pin the destination of this save. Retrying an old local save after binding
    // must never turn it into a new Agent-file mutation (or vice versa).
    const expectedBinding = c.req.header('X-AgentOpsDeck-File-Binding');
    if (expectedBinding === 'none' && deps.reports) {
      const result = await deps.reports.save(c.req.raw, user, resource, input);
      await authority.check();
      if (result.status === 'binding-conflict') throw new HTTPException(409);
      return result.status === 'saved' ? c.json(result.document) : c.json({ error: result.status }, result.status === 'limit' ? 429 : 409);
    }
    if (deps.nativeFiles) {
      if (!expectedBinding) throw new HTTPException(409);
      const bound = await writeBoundNativeCard({nativeFiles: deps.nativeFiles,
        fileCardsEnabled: deps.enabled}, user, ref.id, input, c.req.raw, expectedBinding);
      if (!bound || !deps.projections) throw new HTTPException(503); // No synchronous private/projection fallback.
      const document = await deps.projections.get(c.req.raw, user, resource);
      await authority.check();
      return c.json(document);
    }
    const source = legacy();
    if (!expectedBinding || expectedBinding !== (source.store.cardFiles.current(user, resource)?.bindingId ?? 'none')) throw new HTTPException(409);
    if (!await writeBoundNativeCard({ hubStore: source.store, ...(source.service ? { fileCards: source.service } : {}), fileCardsEnabled: deps.enabled }, user, ref.id, input)) {
      const result = source.store.cardFileProjection.saveReport(user, ref.id, input);
      if (result !== 'saved') return c.json({ error: result }, result === 'limit' ? 429 : 409);
    }
    await authority.check();
    return c.json(source.store.cardFileProjection.get(user, resource));
  }));
  // Declarative configuration only: this route never invokes browser/shell,
  // websites, media or research. Existing execution authorization stays intact.
  app.put(`${base}/configuration`, c => run(async () => {
    const user = await actor(c), ref = configuration(c);
    const input = await readJsonBody(c.req.raw, WORKSPACE_FILE_CARD_MAX_BYTES + 4096);
    await user.check();
    if (!validWorkspaceFileCardWrite(input) || input.kind !== ref.kind) throw new HTTPException(400);
    const result = deps.configurations ? await deps.configurations.save(c.req.raw, user.userId, ref.kind, ref.id, input)
      : legacy().store.cardConfigurations.save(user.userId, ref.id, input);
    await user.check();
    return result.status === 'saved' ? c.json(result.document) : c.json({ error: result.status }, result.status === 'limit' ? 429 : 409);
  }));
}
