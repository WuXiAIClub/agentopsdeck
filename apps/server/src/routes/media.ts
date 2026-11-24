import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileResponse } from '../utils/file-response.js';
import type { Hono } from 'hono';
import { inboundMediaReadDirectory, persistMediaPayloads, type PersistMediaPayload } from '../messages/send-message.js';
import type { ArtifactReceiverConfig, ArtifactRegistryAccess } from '../messages/artifact-receiver.js';
import { mimeTypeFor } from '../utils/mime.js';

export type MediaRoutesOptions = {
  publicBaseUrl?: string | undefined;
  inboundDir?: string;
  /** Trusted local effect/lifetime hook, never supplied by HTTP input. */
  publish?<T>(request: Request, payload: PersistMediaPayload, work: (check: () => Promise<void>) => Promise<T>): Promise<T>;
  artifact?: {
    config: ArtifactReceiverConfig;
    registry: ArtifactRegistryAccess;
    open: (id: string, config: ArtifactReceiverConfig, registry: ArtifactRegistryAccess) => Promise<{ record: { name: string; mimeType: string; size: number }; path: string } | undefined>;
    response: (params: { filePath: string; name: string; mimeType: string; size: number; request: Request }) => Response;
  };
};

type PublishMediaRequest = {
  name?: unknown;
  mimeType?: unknown;
  contentBase64?: unknown;
};

export function registerMediaRoutes(app: Hono, options: MediaRoutesOptions = {}) {
  app.post('/api/media/publish', async (c) => {
    let body: PublishMediaRequest;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'request body must be JSON' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'request body must be an object' }, 400);
    if (typeof body.name !== 'string' || body.name.trim() === '') return c.json({ error: 'name is required' }, 400);
    if (typeof body.mimeType !== 'string' || body.mimeType.trim() === '') return c.json({ error: 'mimeType is required' }, 400);
    if (typeof body.contentBase64 !== 'string') return c.json({ error: 'contentBase64 is required' }, 400);

    try {
      const payload = {
        name: body.name,
        mimeType: body.mimeType,
        contentBase64: body.contentBase64,
      };
      const persist = (check?: () => Promise<void>) => persistMediaPayloads([payload], {
        ...(options.inboundDir ? { inboundDir: options.inboundDir } : {}), ...(check ? { check } : {}),
      });
      const [published] = await (options.publish ? options.publish(c.req.raw, payload, persist) : persist());
      if (!published) return c.json({ error: 'media payload is required' }, 400);
      const downloadUrl = absoluteMediaUrl(c.req.raw, published.media.url, options.publicBaseUrl);
      return c.json({
        media: published.media,
        downloadUrl,
        markdownUrl: `[${published.media.name}](${downloadUrl})`,
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'failed to publish media' }, 400);
    }
  });

  app.get('/api/media/inbound/:name', async (c) => {
    const name = path.basename(c.req.param('name'));
    if (!/^[\w.-]+$/.test(name)) return c.json({ error: 'invalid media name' }, 400);
    const mediaPath = path.join(options.inboundDir ?? inboundMediaReadDirectory(name), name);
    try {
      const info = await stat(mediaPath);
      if (!info.isFile()) return c.json({ error: 'media not found' }, 404);
      return fileResponse({ filePath: mediaPath, name, mimeType: mimeTypeFor(name), size: info.size, request: c.req.raw });
    } catch {
      return c.json({ error: 'media not found' }, 404);
    }
  });

  app.get('/api/artifacts/:id', async (c) => {
    if (!options.artifact) return c.json({ error: 'artifact receiver is not configured' }, 404);
    const artifact = await options.artifact.open(c.req.param('id'), options.artifact.config, options.artifact.registry);
    if (!artifact) return c.json({ error: 'artifact not found' }, 404);
    return options.artifact.response({
      filePath: artifact.path,
      name: artifact.record.name,
      mimeType: artifact.record.mimeType,
      size: artifact.record.size,
      request: c.req.raw,
    });
  });
}

function absoluteMediaUrl(request: Request, mediaUrl: string, publicBaseUrl?: string) {
  if (publicBaseUrl) return new URL(mediaUrl, publicBaseUrl).toString();

  const fallback = new URL(request.url);
  const forwardedProto = firstForwardedValue(request.headers.get('x-forwarded-proto'));
  const forwardedHost = firstForwardedValue(request.headers.get('x-forwarded-host'));
  const host = forwardedHost || firstForwardedValue(request.headers.get('host')) || fallback.host;
  const protocol = forwardedProto || fallback.protocol.replace(/:$/, '') || 'http';
  return new URL(mediaUrl, `${protocol}://${host}`).toString();
}

function firstForwardedValue(value: string | null) {
  return value?.split(',')[0]?.trim() || undefined;
}
