import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ConnectorMachineAuthority } from './machine-authority.js';
import { settleMachineWork } from './machine-authority.js';
import { registerFileRequestOwnership } from './file-authority.js';
import { readJsonBody } from '../utils/http-body.js';
import { permitsTerminal, terminalSize, terminalUuid, TerminalSessions, type TerminalSpawner, type TerminalTarget } from './terminals.js';

export function registerConnectorTerminals(app: Hono, tokens: ConnectorMachineAuthority, targets: TerminalTarget[] = [], spawn?: TerminalSpawner) {
  const base = '/api/connector/v1/terminals';
  const requests = registerFileRequestOwnership(app, base, undefined, 'connector-machine-services');
  const sessions = new TerminalSessions(spawn, owner => tokens.hasScope(owner, 'terminals:use'), Date.now, tokens.changes);
  const actor = async (c: Context) => {
    requests.check(c.req.raw);
    if (!await tokens.authenticate(c.req.raw)) throw new HTTPException(401);
    const result = await tokens.requireScope(c.req.raw, 'terminals:use');
    if (!result) throw new HTTPException(403);
    requests.check(c.req.raw);
    c.header('Cache-Control', 'no-store');
    return result;
  };
  const body = async (c: Context, keys: string[]) => {
    await actor(c);
    const v = await readJsonBody(c.req.raw, 40_000);
    await actor(c);
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) throw new HTTPException(400);
    return v as Record<string, unknown>;
  };
  app.get(`${base}/targets`, async c => {
    const a = await actor(c);
    return c.json({ targets: targets.filter(t => permitsTerminal(t, a)).map(({ id, label, kind }) => ({ id, label, kind })) });
  });
  app.post(base, async c => {
    const v = await body(c, ['targetId', 'requestId', 'cols', 'rows']), a = await actor(c);
    if (!terminalUuid(v.requestId) || !terminalSize(v.cols, v.rows)) throw new HTTPException(400);
    const target = targets.find(t => t.id === v.targetId && permitsTerminal(t, a));
    if (!target) throw new HTTPException(404);
    const result = await sessions.start(a.tokenId, target, v.requestId, Number(v.cols), Number(v.rows), () => requests.check(c.req.raw));
    if (c.req.raw.signal.aborted) { await sessions.stop(a.tokenId, result.id); throw new HTTPException(409); }
    await actor(c);
    return c.json(result);
  });
  app.post(`${base}/:id/input`, async c => {
    const v = await body(c, ['sequence', 'data']), a = await actor(c);
    if (!Number.isSafeInteger(v.sequence) || Number(v.sequence) < 1 || typeof v.data !== 'string' || !v.data.length || v.data.length > 8192) throw new HTTPException(400);
    await sessions.write(a.tokenId, c.req.param('id'), Number(v.sequence), v.data, () => requests.check(c.req.raw));
    return c.json({ accepted: true });
  });
  app.post(`${base}/:id/resize`, async c => {
    const v = await body(c, ['cols', 'rows']), a = await actor(c);
    if (!terminalSize(v.cols, v.rows)) throw new HTTPException(400);
    await sessions.resize(a.tokenId, c.req.param('id'), Number(v.cols), Number(v.rows), () => requests.check(c.req.raw));
    return c.json({ resized: true });
  });
  app.get(`${base}/:id/output`, async c => {
    const a = await actor(c), cursor = Number(c.req.query('cursor'));
    if (c.req.query('cursor') === undefined || !Number.isSafeInteger(cursor) || cursor < 0) throw new HTTPException(400);
    const result = await sessions.read(a.tokenId, c.req.param('id'), cursor, c.req.raw.signal);
    await actor(c);
    return c.json(result);
  });
  app.delete(`${base}/:id`, async c => { await sessions.stop((await actor(c)).tokenId, c.req.param('id')); return c.json({ stopped: true }); });
  let closing: Promise<void> | undefined;
  return { close: () => closing ??= settleMachineWork([requests.close(), sessions.close()]) };
}
