import type { BoardTask } from '@agentopsdeck/shared';
export type TaskSessionInput = { requestId: string; connectionId: string; runtime: string; title: string; model?: string; taskIds: string[];
  fields: ('status'|'detail')[]; expiresAt: number };
export type TaskSessionReceipt = { intent: Omit<TaskSessionInput,'taskIds'> & { boardId: string; boardRevision: number; tasks: BoardTask[] };
  creationRequestId: string; bindingRequestId: string; state: 'prepared'|'creation_unknown'|'creation_rejected'|'created'|'binding_unknown'|'binding_rejected'|'bound'|'cancelled';
  sessionId: string|null; bindingId: string|null };
const uuid = (v: unknown): v is string => typeof v==='string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
export function validTaskSessionReceipt(r: TaskSessionReceipt, id: string, board: string) {
  return r && r.intent?.requestId===id && r.intent.boardId===board && uuid(r.creationRequestId) && uuid(r.bindingRequestId)
    && r.creationRequestId!==r.bindingRequestId && typeof r.intent.title==='string' && r.intent.title.length<=120
    && ['codex','claude-code','ghcp'].includes(r.intent.runtime) && Number.isSafeInteger(r.intent.expiresAt)
    && (r.intent.model===undefined || typeof r.intent.model==='string' && r.intent.model.length>0 && r.intent.model.length<=256 && r.intent.model.trim()===r.intent.model && !/[\x00-\x1f\x7f]/.test(r.intent.model))
    && Array.isArray(r.intent.fields) && r.intent.fields.length>0 && r.intent.fields.every(f=>f==='status'||f==='detail')
    && Array.isArray(r.intent.tasks) && r.intent.tasks.length>0 && r.intent.tasks.length<=32
    && r.intent.tasks.every(t=>t && typeof t==='object') && new Set(r.intent.tasks.map(t=>t.id)).size===r.intent.tasks.length
    && r.intent.tasks.every(t=>uuid(t.id)&&typeof t.title==='string'&&t.title.length<=240)
    && ['prepared','creation_unknown','creation_rejected','created','binding_unknown','binding_rejected','bound','cancelled'].includes(r.state)
    && (r.sessionId===null||typeof r.sessionId==='string'&&r.sessionId.length<=2048)
    && (!['created','binding_unknown','binding_rejected','bound'].includes(r.state)||!!r.sessionId)
    && (r.state!=='bound'||r.bindingId===r.bindingRequestId);
}
