import { realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { readSourcePreview, sourceReferenceMedia, sourceApprovalTarget, type SourcePreviewConfig, type SourcePreviewFailure } from '../messages/source-preview.js';
import { SourceApprovals } from '../messages/source-approval.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import type { ArtifactReceiverConfig, ArtifactRegistryAccess } from '../messages/artifact-receiver.js';
import { openArtifactDownload } from '../messages/artifact-receiver.js';
import { localMediaResource, mediaResourceId } from '../messages/media-resource.js';
import type { DeckStore } from '../projection/deck-store.js';
import { verifiedFileResponse } from '../utils/file-response.js';
import { mimeTypeFor } from '../utils/mime.js';
import type { SdkAttachmentStore } from './sdk-attachment-store.js';
import type { SessionMediaAccess } from './async-session-media.js';
import { hasSourceApproveAdminScope, hasSourceApproveScope, type SessionMediaIdentity, type SessionMediaObservation } from './connector-session-media-domain.js';

/** No caller paths, redirects, fetches or separate resource catalog. A resource
 * exists only while the exact session/message still references its source URL.
 */
export function registerSessionMediaRoutes(app: Hono, deps: {
  tokens?: ConnectorTokenStore; access?: SessionMediaAccess; store: DeckStore; inboundDir: string | ((name: string) => string);
  artifactConfig: ArtifactReceiverConfig; artifactRegistry?: ArtifactRegistryAccess;
  sourcePreview?: SourcePreviewConfig;
  sdkAttachments?: SdkAttachmentStore;
  /** Exact durable summary lookup; never a path lookup or a tool-detail read. */
  sourceMessage?: (sessionKey: string, messageId: string) => ChatMessage | null | undefined;
  refreshMessages: (sessionKey: string, options?: { maxAgeMs?: number }) => Promise<void>;
}) {
  if (!deps.access && !deps.tokens || deps.access && (deps.tokens || deps.sdkAttachments || deps.sourceMessage))
    throw new Error('Session media requires exactly one authority owner');
  const approvals = new SourceApprovals(event => console.info(JSON.stringify({ type: 'source-preview-approval', ...event })));
  const messageFor = (key: string, id: string) => {
    // null is an authoritative durable miss. Never revive an old native binding
    // from a retained UI projection; undefined alone means unsupported runtime.
    const durable = deps.sourceMessage?.(key, id);
    const message = durable === undefined ? deps.store.getMessages(key).find(row => row.id === id) : durable;
    return message?.id === id && message.sessionKey === key ? message : undefined;
  };
  const mediaBase = '/api/connector/v1/sessions/:sessionKey/messages/:messageId/media/:resourceId';
  const open = (request: Request, key: string, messageId: string, resourceId: string) => {
    let expected: SessionMediaIdentity | undefined;
    const input = (approval: boolean) => ({ authorization: request.headers.get('authorization') ?? '', key, messageId, resourceId, approval, ...(expected ? { expected } : {}) });
    const read = async (approval = false): Promise<SessionMediaObservation> => {
      request.signal.throwIfAborted();
      let observation: SessionMediaObservation;
      if (deps.access) observation = await deps.access.observe(input(approval));
      else {
        const token = deps.tokens!.authenticate(request);
        if (!token || !(['messages:read', 'media:read'] as const).every(scope => deps.tokens!.hasScope(token.tokenId, scope))
          || approval && !hasSourceApproveScope(token.scopes)) throw new HTTPException(403, { message: 'Missing session media scope' });
        observation = { key, messageId, resourceId, readerId: token.tokenId, nativeSessionId: null, durable: deps.sourceMessage?.(key, messageId) !== undefined,
          mayApprove: hasSourceApproveScope(token.scopes), mayApproveAdmin: hasSourceApproveAdminScope(token.scopes), source: null, attachment: null };
      }
      request.signal.throwIfAborted();
      if (expected && (expected.readerId !== observation.readerId || expected.nativeSessionId !== observation.nativeSessionId)) throw new HTTPException(403);
      expected ??= { readerId: observation.readerId, nativeSessionId: observation.nativeSessionId };
      if (!deps.access || !observation.durable) {
        const message = messageFor(key, messageId);
        observation = { ...observation, source: message && sourceReferenceMedia(message).find(row => mediaResourceId(row.url) === resourceId) || null };
      }
      return observation;
    };
    return { read, input };
  };
  const run = (request: Request, work: () => Promise<Response>) => deps.access ? deps.access.run(request, work) : work();
  for (const method of ['POST', 'DELETE'] as const) app.on(method, `${mediaBase}/approval`, c => run(c.req.raw, async () => {
    c.header('Cache-Control', 'no-store');
    if (!/^[a-f0-9]{64}$/.test(c.req.param('resourceId')!) || c.req.param('sessionKey')!.length > 2048
      || c.req.param('messageId')!.length > 4096) return c.json({ error: 'Media not found' }, 404);
    const sessionKey = c.req.param('sessionKey')!;
    const access = open(c.req.raw, sessionKey, c.req.param('messageId')!, c.req.param('resourceId')!);
    const initial = await access.read(true), source = initial.source?.sourceReference;
    const guard = async () => {
      const current = await access.read(true);
      if (!source || current.source?.sourceReference?.href !== source.href) throw new HTTPException(404, { message: 'Source reference unavailable' });
    };
    await guard();
    if (method === 'DELETE') { approvals.revoke(initial.readerId, sessionKey, source!); return c.json({ ok: true }); }
    const current = await access.read(true);
    const approved = await approvals.approve(initial.readerId, sessionKey, source!,
      { roots: deps.sourcePreview?.approvalDirs ?? [], allowAdminExactFile: current.mayApproveAdmin }, async () => {
        const fresh = await access.read(true);
        if (!source || fresh.source?.sourceReference?.href !== source.href) throw new HTTPException(404, { message: 'Source reference unavailable' });
        if (current.mayApproveAdmin && !fresh.mayApproveAdmin) throw new HTTPException(403, { message: 'Source approval authority changed' });
      });
    return c.json({ ok: approved }, approved ? 200 : 409);
  }));
  app.get(mediaBase, c => run(c.req.raw, async () => {
    c.header('Cache-Control', 'no-store');
    const sessionKey = c.req.param('sessionKey'), messageId = c.req.param('messageId'), id = c.req.param('resourceId');
    const access = open(c.req.raw, sessionKey, messageId, id);
    if (!/^[a-f0-9]{64}$/.test(id) || sessionKey.length > 2048 || messageId.length > 4096) return c.json({ error: 'Media not found' }, 404);
    const initial = await access.read();
    const legacy = deps.sdkAttachments?.read(sessionKey, messageId, id), attachment = initial.attachment ?? legacy?.media;
    if (attachment) {
      const size = attachment.size ?? legacy!.bytes.length;
      let offset = 0;
      const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
        try {
          const current = await access.read();
          if (deps.access ? JSON.stringify(current.attachment) !== JSON.stringify(attachment)
            : !deps.sdkAttachments!.media(sessionKey, messageId).some(item => mediaResourceId(item.url) === id)) throw new HTTPException(403);
          if (offset >= size) { controller.close(); return; }
          const bytes = deps.access ? await deps.access.chunk({ ...access.input(false), expected: { readerId: initial.readerId, nativeSessionId: initial.nativeSessionId }, offset, size })
            : legacy!.bytes.slice(offset, offset + 65536);
          await access.read(); c.req.raw.signal.throwIfAborted();
          controller.enqueue(bytes); offset += bytes.length;
        } catch (error) { controller.error(error); }
      } }, { highWaterMark: 0 });
      return new Response(stream, { headers: { 'Content-Type': attachment.mimeType!, 'Content-Length': String(size),
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'" } });
    }
    if (!initial.durable) await deps.refreshMessages(sessionKey, { maxAgeMs: 1_500 }).catch(() => undefined);
    const source = (await access.read()).source;
    if (source?.sourceReference) {
      const guard = async () => {
        if ((await access.read()).source?.sourceReference?.href !== source.sourceReference!.href) throw new HTTPException(403, { message: 'Source reference membership changed' });
      };
      try {
        const failure: { reason: SourcePreviewFailure } = { reason: 'missing' };
        let preview = await readSourcePreview(source.sourceReference, deps.sourcePreview ?? { allowedDirs: [] }, guard, value => { failure.reason = value; });
        const approvalState = await access.read();
        let approved = false;
        if (!preview && failure.reason === 'outside-roots' && approvalState.mayApprove) {
          const grantGuard = async () => {
            await guard();
            const fresh = await access.read(true);
            if (approvalState.mayApproveAdmin && !fresh.mayApproveAdmin) throw new HTTPException(403, { message: 'Source approval authority changed' });
          };
          const approvalOptions = { roots: deps.sourcePreview?.approvalDirs ?? [], allowAdminExactFile: approvalState.mayApproveAdmin };
          const grant = await approvals.resolve(initial.readerId, sessionKey, source.sourceReference, approvalOptions, grantGuard);
          if (grant) {
            const activeGrantGuard = async () => {
              await grantGuard();
              if (!approvals.active(initial.readerId, sessionKey, source.sourceReference!, grant)) throw new HTTPException(403, { message: 'Source approval expired or revoked' });
            };
            preview = await readSourcePreview(source.sourceReference,
              { allowedDirs: grant.root ? [grant.root] : [], approvedFile: grant }, activeGrantGuard, value => { failure.reason = value; });
            await activeGrantGuard();
            approved = !!preview;
          }
          if (!preview && failure.reason === 'outside-roots' && await sourceApprovalTarget(source.sourceReference, approvalOptions, grantGuard))
            c.header('X-AgentOpsDeck-Source-Approval', 'available');
        }
        await guard();
        if (!preview) { c.header('X-AgentOpsDeck-Source-Error', failure.reason); return c.json({ error: 'Source preview unavailable' }, 404); }
        c.header('X-Content-Type-Options', 'nosniff');
        return c.json({ ...preview, ...(approved ? { temporaryApproval: true } : {}) });
      } catch (error) {
        if (error instanceof HTTPException) throw error;
        return c.json({ error: 'Source preview unavailable' }, 404);
      }
    }
    if (deps.access && initial.durable) return c.json({ error: 'Media not found' }, 404);
    const members = () => deps.store.getMessages(sessionKey).find(message => message.id === messageId && message.sessionKey === sessionKey)?.media;
    const media = members()?.find(media => mediaResourceId(media.url) === id), resource = media && localMediaResource(media.url);
    if (!media || !resource) return c.json({ error: 'Media not found' }, 404);
    const guard = async () => {
      await access.read();
      if (!members()?.some(item => item.url === media.url)) throw new HTTPException(403, { message: 'Message media membership changed' });
    };
    try {
      let filePath: string, info, name: string, mimeType: string;
      if (resource.kind === 'artifact') {
        if (!deps.artifactConfig.enabled || !deps.artifactRegistry) return c.json({ error: 'Media not found' }, 404);
        const artifact = await openArtifactDownload(resource.id, deps.artifactConfig, deps.artifactRegistry);
        await guard();
        if (!artifact) return c.json({ error: 'Media not found' }, 404);
        filePath = artifact.path; info = artifact.info; name = artifact.record.name; mimeType = artifact.record.mimeType;
      } else {
        const root = await realpath(typeof deps.inboundDir === 'function' ? deps.inboundDir(resource.id) : deps.inboundDir);
        filePath = await realpath(join(root, resource.id));
        await guard();
        if (dirname(filePath) !== root) return c.json({ error: 'Media not found' }, 404);
        info = await stat(filePath); name = resource.id; mimeType = mimeTypeFor(name);
      }
      await guard();
      if (!info.isFile()) return c.json({ error: 'Media not found' }, 404);
      if (info.size > 64 * 1024 * 1024) return c.json({ error: 'Media exceeds size limit' }, 413);
      return await verifiedFileResponse({ filePath, info, size: info.size, name, mimeType, request: c.req.raw, authorize: guard });
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      return c.json({ error: 'Media not found' }, 404);
    }
  }));
}
import type { ChatMessage } from '@agentopsdeck/shared';
