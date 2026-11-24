import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { MediaLibraryEntry, MediaLibraryListResponse, MediaLibraryRoot } from '@agentopsdeck/shared';
import type { Hono } from 'hono';
import { mimeTypeFor } from '../utils/mime.js';

export type MediaLibraryConfig = {
  enabled: boolean;
  allowedDirs: string[];
  signingSecret?: string | undefined;
  linkTtlSeconds: number;
};

type ResolvedRoot = MediaLibraryRoot & { directory: string };

const DIRECT_VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm']);
const KNOWN_VIDEO_EXTENSIONS = new Set([...DIRECT_VIDEO_EXTENSIONS, '.mkv', '.avi']);
const MAX_DIRECTORY_ENTRIES = 500;

export class MediaLibrary {
  private readonly roots: ResolvedRoot[];
  private readonly secret: Buffer;

  constructor(private readonly config: MediaLibraryConfig) {
    this.roots = config.allowedDirs.map((directory, index) => ({
      id: String(index),
      label: path.basename(path.resolve(directory)) || path.resolve(directory),
      directory: path.resolve(directory),
    }));
    this.secret = Buffer.from(config.signingSecret || randomBytes(32).toString('base64url'));
  }

  public isSignedStreamRequest(request: Request) {
    if (!this.config.enabled || !this.roots.length) return false;
    const url = new URL(request.url);
    if (url.pathname !== '/api/media-library/stream') return false;
    const root = url.searchParams.get('root');
    const relativePath = url.searchParams.get('path');
    const expires = url.searchParams.get('expires');
    const signature = url.searchParams.get('signature');
    if (!root || !relativePath || !expires || !signature) return false;
    const expiry = Number(expires);
    if (!Number.isSafeInteger(expiry) || expiry < Math.floor(Date.now() / 1000)) return false;
    return safeSignatureEqual(signature, this.sign(root, relativePath, expiry));
  }

  public register(app: Hono) {
    app.get('/api/media-library', async (c) => {
      const publicRoots = this.roots.map(({ id, label }) => ({ id, label }));
      const rootId = c.req.query('root');
      if (!this.config.enabled || !this.roots.length) return c.json(emptyResponse(publicRoots));
      if (!rootId) return c.json(emptyResponse(publicRoots, true));

      const relativePath = normalizeRelativePath(c.req.query('path') ?? '');
      if (relativePath === undefined) return c.json({ error: 'invalid media path' }, 400);
      const root = this.roots.find((candidate) => candidate.id === rootId);
      if (!root) return c.json({ error: 'media root not found' }, 404);

      try {
        const directory = await resolveWithinRoot(root.directory, relativePath, 'directory');
        const dirents = await readdir(directory, { withFileTypes: true });
        const visible = dirents
          .filter((entry) => !entry.name.startsWith('.'))
          .filter((entry) => entry.isDirectory() || KNOWN_VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
          .slice(0, MAX_DIRECTORY_ENTRIES);
        const entries = (await Promise.all(visible.map((entry) => this.describeEntry(root, relativePath, entry.name, entry.isDirectory()))))
          .filter((entry): entry is MediaLibraryEntry => Boolean(entry))
          .sort((left, right) => left.kind === right.kind
            ? left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
            : left.kind === 'directory' ? -1 : 1);
        const response: MediaLibraryListResponse = {
          enabled: true,
          roots: publicRoots,
          root: root.id,
          path: relativePath,
          entries,
          truncated: dirents.length > MAX_DIRECTORY_ENTRIES,
          updatedAt: Date.now(),
        };
        return c.json(response);
      } catch (error) {
        return c.json({ error: mediaError(error) }, mediaErrorStatus(error));
      }
    });

    app.on(['GET', 'HEAD'], '/api/media-library/stream', async (c) => {
      if (!this.isSignedStreamRequest(c.req.raw)) return c.json({ error: 'invalid or expired media link' }, 401);
      const rootId = c.req.query('root')!;
      const relativePath = normalizeRelativePath(c.req.query('path') ?? '');
      const root = this.roots.find((candidate) => candidate.id === rootId);
      if (!root || relativePath === undefined || !isDirectVideo(relativePath)) return c.json({ error: 'video not found' }, 404);

      try {
        const filePath = await resolveWithinRoot(root.directory, relativePath, 'file');
        const info = await stat(filePath);
        const range = parseRange(c.req.header('range'), info.size);
        if (range === 'invalid') return new Response(null, { status: 416, headers: { 'content-range': `bytes */${info.size}`, 'accept-ranges': 'bytes' } });
        const start = range?.start ?? 0;
        const end = range?.end ?? info.size - 1;
        const statusCode = range ? 206 : 200;
        const headers = new Headers({
          'accept-ranges': 'bytes',
          'content-type': mimeTypeFor(filePath),
          'content-length': String(Math.max(0, end - start + 1)),
          'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`,
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
        });
        if (range) headers.set('content-range', `bytes ${start}-${end}/${info.size}`);
        if (c.req.method === 'HEAD' || info.size === 0) return new Response(null, { status: statusCode, headers });
        const stream = createReadStream(filePath, { start, end });
        return new Response(Readable.toWeb(stream) as ReadableStream, { status: statusCode, headers });
      } catch (error) {
        return c.json({ error: mediaError(error) }, mediaErrorStatus(error));
      }
    });
  }

  private async describeEntry(root: ResolvedRoot, parent: string, name: string, directory: boolean): Promise<MediaLibraryEntry | undefined> {
    const relativePath = normalizeRelativePath(path.join(parent, name));
    if (relativePath === undefined) return undefined;
    try {
      const fullPath = await resolveWithinRoot(root.directory, relativePath, directory ? 'directory' : 'file');
      const info = await stat(fullPath);
      if (directory) return { name, path: relativePath, kind: 'directory', modifiedAt: info.mtimeMs };
      const playable = isDirectVideo(relativePath);
      const entry: MediaLibraryEntry = {
        name,
        path: relativePath,
        kind: 'video',
        size: info.size,
        modifiedAt: info.mtimeMs,
        mimeType: mimeTypeFor(relativePath),
        playable,
      };
      if (playable) entry.playbackUrl = this.playbackUrl(root.id, relativePath);
      return entry;
    } catch {
      return undefined;
    }
  }

  private playbackUrl(root: string, relativePath: string) {
    const expires = Math.floor(Date.now() / 1000) + this.config.linkTtlSeconds;
    const params = new URLSearchParams({ root, path: relativePath, expires: String(expires) });
    params.set('signature', this.sign(root, relativePath, expires));
    return `/api/media-library/stream?${params.toString()}`;
  }

  private sign(root: string, relativePath: string, expires: number) {
    return createHmac('sha256', this.secret).update(`${root}\n${relativePath}\n${expires}`).digest('base64url');
  }
}

function emptyResponse(roots: MediaLibraryRoot[], enabled = false): MediaLibraryListResponse {
  return { enabled, roots, path: '', entries: [], updatedAt: Date.now() };
}

function normalizeRelativePath(value: string) {
  if (value.includes('\0') || path.isAbsolute(value)) return undefined;
  const normalized = value.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.').join('/');
  if (normalized.split('/').includes('..')) return undefined;
  return normalized;
}

async function resolveWithinRoot(rootDirectory: string, relativePath: string, kind: 'file' | 'directory') {
  const root = await realpath(rootDirectory);
  const candidate = await realpath(path.resolve(root, relativePath));
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw new MediaPathError('media path is outside the configured root', 403);
  const info = await stat(candidate);
  if (kind === 'file' ? !info.isFile() : !info.isDirectory()) throw new MediaPathError(`media ${kind} not found`, 404);
  return candidate;
}

function isDirectVideo(relativePath: string) {
  return DIRECT_VIDEO_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

function parseRange(value: string | undefined, size: number): { start: number; end: number } | 'invalid' | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || size <= 0) return 'invalid';
  const rawStart = match[1] ?? '';
  const rawEnd = match[2] ?? '';
  if (!rawStart && !rawEnd) return 'invalid';
  let start: number;
  let end: number;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return 'invalid';
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function safeSignatureEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

class MediaPathError extends Error {
  constructor(message: string, readonly status: 403 | 404) {
    super(message);
  }
}

function mediaError(error: unknown) {
  if (error instanceof MediaPathError) return error.message;
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return 'media path not found';
  return 'failed to read media library';
}

function mediaErrorStatus(error: unknown): 403 | 404 | 500 {
  if (error instanceof MediaPathError) return error.status;
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return 404;
  return 500;
}
