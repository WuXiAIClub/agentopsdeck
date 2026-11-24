import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createHash } from 'node:crypto';
import { BOARD_MAX_BODY_BYTES } from '@agentopsdeck/shared';
import { validBoardAgentWrite, type BoardAgentWrite, type BoardAgentResult } from '../hub/workspace-board-capabilities.js';
import { readJsonBody } from '../utils/http-body.js';
import { validBoardAgentRead, type BoardAgentRead } from '../hub/workspace-board-read.js';
import type { HubBoardMachineRead } from '../hub/member-board-machine-domain.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import type { Awaitable } from '../auth/route-persistence.js';

/** Original synchronous store and complete async owner share the unchanged
 * HTTP shape. Every authority result is awaited, never a Promise truthiness. */
export type WorkspaceBoardMachinePort = {
  authorized(token: string, request?: Request): Awaitable<boolean>;
  read(token: string, query: BoardAgentRead, request?: Request): Awaitable<HubBoardMachineRead | undefined>;
  update(token: string, document: BoardAgentWrite, request?: Request): Awaitable<BoardAgentResult>;
};
async function machineResponse(work: () => Promise<Response>): Promise<Response> {
  try { return await work(); }
  catch (error) {
    if (error instanceof HubMemberRequestError) {
      if (error.status === 499) return new Response(null, { status: 499 });
      throw new HTTPException(error.status, { message: 'Workspace board storage unavailable' });
    }
    throw error;
  }
}

const PATH = '/api/workspace-agent/v1/board';
/** Only this exact path/method pair uses machine authentication. No cookies,
 * query credentials, Hub login fallback or wildcard bypass are accepted. */
export function isWorkspaceAgentRequest(request: Request) {
  const path = new URL(request.url).pathname;
  return path === PATH && ['GET', 'POST'].includes(request.method)
    || request.method === 'GET' && (path === '/api/workspace-agent/v1/notebook' || /^\/api\/workspace-agent\/v1\/notebook\/moves\/[a-f0-9-]{36}$/.test(path))
    || request.method === 'POST' && path === '/api/workspace-agent/v1/notebook/moves';
}
const LEGACY_MACHINE_CREDENTIAL_PREFIX = ['cp', '(?:board|note)', ''].join('_');
const MACHINE_CREDENTIAL_BEARER_PATTERN = new RegExp(`^Bearer\\s+(?:aod_(?:board|note)_|${LEGACY_MACHINE_CREDENTIAL_PREFIX})`, 'i');
const MACHINE_CREDENTIAL_KEY_PATTERN = new RegExp(`^(?:aod_(?:board|note)_|${LEGACY_MACHINE_CREDENTIAL_PREFIX})`);

export function hasBoardCapabilityCredential(request: Request) {
  return MACHINE_CREDENTIAL_BEARER_PATTERN.test(request.headers.get('authorization') ?? '')
    || MACHINE_CREDENTIAL_KEY_PATTERN.test(request.headers.get('x-agentopsdeck-key') ?? '');
}
export function registerWorkspaceAgentRoutes(app: Hono, capabilities: WorkspaceBoardMachinePort) {
  // A taskboard Agent should batch task changes, not spin on this endpoint.
  // Buckets contain hashes, never raw credentials; bound both memory and readers.
  const buckets = new Map<string, { until: number; requests: number; readers: number }>();
  let readers = 0;
  app.on(['GET', 'POST'], PATH, async c => machineResponse(async () => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    const token = /^Bearer (aod_board_[A-Za-z0-9_-]{43})$/.exec(c.req.header('authorization') ?? '')?.[1];
    if (!token || !await capabilities.authorized(token, c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
    const now = Date.now(), key = createHash('sha256').update(token).digest('hex');
    for (const [id, bucket] of buckets) if (bucket.until <= now && !bucket.readers) buckets.delete(id);
    let bucket = buckets.get(key);
    if (!bucket && buckets.size < 1024) { bucket = { until: now + 60_000, requests: 0, readers: 0 }; buckets.set(key, bucket); }
    if (!bucket || bucket.requests >= 120 || (c.req.method === 'POST' && (readers >= 16 || bucket.readers >= 2))) {
      c.header('Retry-After', '60'); return c.json({ error: 'Task board request limit' }, 429);
    }
    bucket.requests++;
    if (c.req.method === 'GET') {
      const params = new URL(c.req.url).searchParams;
      let query: unknown = {};
      if ([...params.keys()].some(k => k !== 'read') || params.getAll('read').length > 1 || (params.get('read')?.length ?? 0) > 4096) return c.json({ error: 'Invalid task read' }, 400);
      try { if (params.has('read')) query = JSON.parse(params.get('read')!); } catch { return c.json({ error: 'Invalid task read' }, 400); }
      if (!validBoardAgentRead(query)) return c.json({ error: 'Invalid task read' }, 400);
      const readQuery = query;
      const snapshot = await capabilities.read(token, readQuery, c.req.raw);
      if (snapshot && 'error' in snapshot) return c.json(snapshot, snapshot.error === 'revision_changed' ? 409 : 400);
      return snapshot ? c.json(snapshot) : c.json({ error: 'unauthorized' }, 401);
    }
    bucket.readers++; readers++;
    let input: unknown;
    try { input = await readJsonBody(c.req.raw, BOARD_MAX_BODY_BYTES); }
    finally { bucket.readers--; readers--; }
    // Authentication is repeated after asynchronous body consumption; revocation
    // also precedes receipt lookup in the synchronous transaction below.
    if (!await capabilities.authorized(token, c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
    if (!validBoardAgentWrite(input)) return c.json({ error: 'Invalid task update' }, 400);
    const document = input;
    const result = await capabilities.update(token, document, c.req.raw);
    if (result.status === 'saved') return c.json(result);
    return c.json({ error: result.status }, result.status === 'denied' ? 403 : result.status === 'invalid' ? 400 : result.status === 'limit' ? 429 : 409);
  }));
}
