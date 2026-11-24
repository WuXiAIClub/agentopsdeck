import { createHash } from 'node:crypto';
import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import { QuickChatConflict } from './quick-chat-store.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Only existing local cleanup operations. This command cannot claim, resend,
 * settle UNKNOWN, free provider work or delete the original request receipt. */
export type HubQuickChatCleanupCommand = { action: 'cancel' | 'clear'; requestId: string };
type Code = 'missing' | 'already-dispatched' | 'not-terminal';
export type HubQuickChatCleanupResult = null | {
  action: HubQuickChatCleanupCommand['action']; digest: string; status: 200 | 409; code: Code | null;
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k));
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function validHubQuickChatCleanupCommand(v: unknown): v is HubQuickChatCleanupCommand {
  return object(v) && fields(v,['action','requestId']) && (v.action === 'cancel' || v.action === 'clear')
    && typeof v.requestId === 'string' && v.requestId.length > 0 && v.requestId.length <= 512
    && v.requestId.trim() === v.requestId && !/[\u0000-\u001f\u007f]/.test(v.requestId);
}
export function validHubQuickChatCleanupResult(v: unknown): v is HubQuickChatCleanupResult {
  return v === null || object(v) && fields(v,['action','digest','status','code'])
    && (v.action === 'cancel' || v.action === 'clear') && typeof v.digest === 'string' && /^[a-f0-9]{64}$/.test(v.digest)
    && (v.status === 200 ? v.code === null : v.status === 409 && (v.code === 'missing'
      || v.action === 'cancel' && v.code === 'already-dispatched' || v.action === 'clear' && v.code === 'not-terminal'));
}
export function validHubQuickChatCleanupReply(command: HubQuickChatCleanupCommand, value: unknown): value is HubQuickChatCleanupResult {
  return validHubQuickChatCleanupResult(value) && (value === null || value.action === command.action && value.digest === digest(command));
}
export function executeHubQuickChatCleanupCommand(owner: HubStore, principal: HubPrincipal,
  fresh: () => HubPrincipal | undefined, command: HubQuickChatCleanupCommand,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics): HubQuickChatCleanupResult {
  let trace: ReturnType<PerformanceDiagnostics['start']> | undefined, failed = true, authorityDenied = false;
  try { trace = diagnostics.start('hub-quick-chat'); trace.add('step',command.action === 'cancel' ? 10 : 11); } catch { /* Observation only. */ }
  // Keep denial latched across ROLLBACK. Re-reading restored rows after a
  // failed COMMIT proof must not turn a genuine revocation into a conflict ACK.
  const authorized = () => {
    if (authorityDenied || fresh()?.userId !== principal.userId) { authorityDenied = true; return false; }
    return true;
  };
  try {
    if (!authorized()) return null;
    let code: Code | null = null;
    try {
      // These original store methods own the ROOT transaction, repeat fresh
      // authority on entry and before COMMIT, and refuse nested transactions.
      if (command.action === 'cancel') owner.quickChat.cancelAdmitted(principal.userId,command.requestId,authorized);
      else owner.quickChat.clearResult(principal.userId,command.requestId,authorized);
    } catch (error) {
      if (authorityDenied) return null;
      if (!(error instanceof QuickChatConflict) || !['missing','already-dispatched','not-terminal'].includes(error.message)) throw error;
      code = error.message as Code;
    }
    if (!authorized()) return null;
    const result: HubQuickChatCleanupResult = { action: command.action, digest: digest(command), status: code ? 409 : 200, code };
    if (!validHubQuickChatCleanupReply(command,result)) throw Error('hub_member_storage_unavailable');
    failed = result.status !== 200;
    try { trace?.add('settled',1); } catch { /* Original ACK unchanged. */ }
    return result;
  } finally { try { trace?.finish(failed); } catch { /* No authority from logs. */ } }
}
