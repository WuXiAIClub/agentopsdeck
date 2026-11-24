import { readInteractionAnswer, readInteractionSubmission, readInteractionView, type InteractionSubmission, type InteractionView } from '@agentopsdeck/shared';
import { decodeHubSessionId, encodeHubSessionId } from './session-id.js';

/** Only the two original Weixin native effects. Never an arbitrary HTTP RPC. */
export type WeixinAction =
  | Readonly<{ operation: 'stop'; sessionKey: string; runId: string; key: string }>
  | Readonly<{ operation: 'answer'; sessionKey: string; requestId: string; ownerId: string; submission: InteractionSubmission }>;
export type WeixinActionResult = Readonly<{ status: 'interrupt_requested' }> | InteractionView;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\x00-\x1f\x7f]/.test(v);
const fields = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
export function validWeixinAction(v: unknown): v is WeixinAction {
  if (!object(v) || !text(v.sessionKey) || !v.sessionKey.startsWith('codex:')) return false;
  if (v.operation === 'stop') return fields(v, ['operation','sessionKey','runId','key']) && text(v.runId) && text(v.key);
  return v.operation === 'answer' && fields(v, ['operation','sessionKey','requestId','ownerId','submission'])
    && text(v.requestId) && v.requestId.length <= 256 && text(v.ownerId) && !!readInteractionSubmission(v.submission);
}
/** Enrollment is computed from the exact private bridge request, never headers. */
export function weixinActionFor(ownerId: string, path: string, body: unknown): WeixinAction | undefined {
  const match = /^\/api\/hub\/v1\/sessions\/([^/]+)\/(messages|interactions\/([^/]+)\/answer)$/.exec(path);
  if (!match || !object(body)) return;
  let sessionId: string, requestId: string;
  try { sessionId = decodeURIComponent(match[1]!); requestId = match[3] ? decodeURIComponent(match[3]) : ''; } catch { return; }
  const decoded = decodeHubSessionId(sessionId);
  if (!decoded || encodeHubSessionId(decoded.connectionId, decoded.remoteSessionKey) !== sessionId) return;
  let command: WeixinAction;
  if (match[2] === 'messages') {
    if (!fields(body, ['message','expectedRunId','deliveryMode','media','idempotencyKey']) || body.message !== '/stop'
      || body.deliveryMode !== 'web-only' || !Array.isArray(body.media) || body.media.length || !text(body.expectedRunId) || !text(body.idempotencyKey)) return;
    command = { operation: 'stop', sessionKey: decoded.remoteSessionKey, runId: body.expectedRunId, key: body.idempotencyKey };
  } else {
    const submission = readInteractionSubmission(body); if (!submission) return;
    command = { operation: 'answer', sessionKey: decoded.remoteSessionKey, requestId, ownerId, submission };
  }
  return validWeixinAction(command) ? JSON.parse(JSON.stringify(command)) as WeixinAction : undefined;
}
export function weixinActionWire(command: WeixinAction) {
  if (!validWeixinAction(command)) throw Error('weixin_action_unavailable');
  const base = `/sessions/${encodeURIComponent(command.sessionKey)}`;
  return command.operation === 'stop'
    ? { path: `${base}/messages`, method: 'POST', headers: { 'idempotency-key': command.key }, body: JSON.stringify({
      message: '/stop', expectedRunId: command.runId, deliveryMode: 'web-only', media: [], idempotencyKey: command.key }) }
    : { path: `${base}/interactions/${encodeURIComponent(command.requestId)}/answer`, method: 'POST', body: JSON.stringify(command.submission) };
}
export function readWeixinActionResult(command: WeixinAction, status: number, body: unknown, nodeId?: string): WeixinActionResult | undefined {
  if (status < 200 || status >= 300 || !object(body)) return;
  if (command.operation === 'stop') {
    // An upstream explicit uncertainty receipt overrides optimistic metadata.
    if (body.command !== undefined && (!object(body.command) || body.command.key !== command.key || body.command.state !== 'accepted')) return;
    if (body.status !== 'interrupt_requested' || body.runId !== undefined && body.runId !== command.runId
      || body.idempotencyKey !== undefined && body.idempotencyKey !== command.key) return;
    return Object.freeze({ status: 'interrupt_requested' });
  }
  const view = readInteractionView(body);
  if (!view || view.request.requestId !== command.requestId || view.request.runId !== command.submission.runId
    || view.request.sessionKey !== command.sessionKey || view.request.ownerId !== command.ownerId
    || !readInteractionAnswer(view.request, command.submission.answer) || nodeId && view.request.nodeId !== nodeId
    || view.revision < command.submission.expectedRevision || view.status !== 'answered' || view.delivery !== 'confirmed') return;
  return view;
}
