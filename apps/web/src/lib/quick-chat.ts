export type QuickProfile = { id: string; revision: number; name: string; target: string; model: string; outputLimit: number };
export type QuickReceipt = { requestId: string; profile: QuickProfile; state: 'admitted' | 'unknown' | 'completed' | 'failed'; createdAt: number; resultExpiresAt: number | null };
export type QuickResult = { receipt: QuickReceipt; output: string | null };
export type QuickTurn = { requestId: string; question: string; result?: QuickResult };
/** Keep the newest complete pairs within the server's bounded context window.
 * Unknown/cleared results never enter context; no plaintext browser persistence. */
export function quickHistory(turns: QuickTurn[], input: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  const pairs: Array<Array<{ role: 'user' | 'assistant'; content: string }>> = [];
  let chars = input.length;
  for (const turn of [...turns].reverse()) {
    if (turn.result?.receipt.state !== 'completed' || !turn.result.output?.trim() || !turn.question.trim()) continue;
    if (pairs.length >= 16 || chars + turn.question.length + turn.result.output.length > 48000) break;
    chars += turn.question.length + turn.result.output.length;
    pairs.unshift([{ role: 'user', content: turn.question }, { role: 'assistant', content: turn.result.output }]);
  }
  return pairs.flat();
}
export type QuickConfig = { target: { id: string; label: string; provider: string; model: string; models?: Array<{ id: string; label: string }>;
  catalogState?: 'ready' | 'unavailable'; maxOutput: number; recovery: 'local-receipt-only' } | null; profiles: QuickProfile[]; receipts: QuickReceipt[] };
export const quickModels = (target: QuickConfig['target']) => target ? target.models ?? [{ id: target.model, label: target.model }] : [];
type Obj = Record<string, unknown>;
const obj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const int = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
export const quickId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
export function quickProfile(v: unknown): v is QuickProfile {
  return obj(v) && quickId(v.id) && int(v.revision) && v.revision > 0 && str(v.name, 80) && str(v.target, 512) && str(v.model, 128)
    && int(v.outputLimit) && v.outputLimit > 0 && v.outputLimit <= 2000;
}
export function quickReceipt(v: unknown): v is QuickReceipt {
  return obj(v) && quickId(v.requestId) && quickProfile(v.profile) && ['admitted', 'unknown', 'completed', 'failed'].includes(String(v.state))
    && int(v.createdAt) && (v.resultExpiresAt === null || int(v.resultExpiresAt));
}
export function quickConfig(v: unknown): v is QuickConfig {
  return obj(v) && (v.target === null || obj(v.target) && str(v.target.id, 512) && str(v.target.label, 128) && str(v.target.provider, 2048)
    && str(v.target.model, 128) && int(v.target.maxOutput) && v.target.maxOutput > 0 && v.target.maxOutput <= 2000 && v.target.recovery === 'local-receipt-only'
    && (v.target.catalogState === undefined || ['ready', 'unavailable'].includes(String(v.target.catalogState)))
    && (v.target.models === undefined || Array.isArray(v.target.models) && v.target.models.length > 0 && v.target.models.length <= 512
      && v.target.models.every(m => obj(m) && str(m.id, 128) && m.id.trim() === m.id && str(m.label, 128))
      && new Set(v.target.models.map(m => (m as Obj).id)).size === v.target.models.length
      && v.target.models.some(m => (m as Obj).id === (v.target as Obj).model)))
    && Array.isArray(v.profiles) && v.profiles.length <= 32 && v.profiles.every(quickProfile)
    && Array.isArray(v.receipts) && v.receipts.length <= 32 && v.receipts.every(quickReceipt);
}
export function quickResult(v: unknown, requestId: string): v is QuickResult {
  return obj(v) && quickReceipt(v.receipt) && v.receipt.requestId === requestId
    && (v.output === null || typeof v.output === 'string' && v.output.length <= 32000 && v.receipt.state === 'completed');
}
