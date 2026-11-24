import type { ConnectorUserStore } from './connector-user-store.js';
import { validConnectorExecutionOutput } from './connector-execution-domain.js';

export const CONNECTOR_NATIVE_REPLY_TEXT_BYTES = 1024 * 1024;
// JSON can encode each one-byte control character as six bytes. Keep normal
// commands at 16 KiB; only fixed native reply envelopes receive this allowance.
export const CONNECTOR_NATIVE_REPLY_COMMAND_BYTES = 6 * CONNECTOR_NATIVE_REPLY_TEXT_BYTES + 16_384;
export type ConnectorNativeReplyCommands = {
  openClawGatewayFinalReply: { input: { sessionKey: string; event: {
    runId: string; gatewayConnectionId: string; phase: 'completed';
    reply: { text: string; sequence: number }; replyOnly?: true;
  } }; output: boolean };
  openClawCliFinalReply: { input: { sessionKey: string; commandId: string;
    phase: 'completed' | 'failed'; deliveryMode: 'web-only' | 'mirror'; replyText: string | null }; output: boolean };
};
export type ConnectorNativeReplyKind = keyof ConnectorNativeReplyCommands;
export const connectorNativeReplySteps = Object.freeze({ openClawGatewayFinalReply: 62, openClawCliFinalReply: 63 });
export const isConnectorNativeReplyKind = (kind: string): kind is ConnectorNativeReplyKind => Object.hasOwn(connectorNativeReplySteps, kind);
const fields = (v: unknown, keys: string[]): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
  && keys.length === Object.keys(v).length && keys.every(key => Object.hasOwn(v, key));
const identity = (v: unknown, limit: number): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= limit;
const replyText = (v: unknown): v is string => typeof v === 'string' && Buffer.byteLength(v) <= CONNECTOR_NATIVE_REPLY_TEXT_BYTES;
export function validConnectorNativeReplyInput(kind: ConnectorNativeReplyKind, value: unknown): boolean {
  const v = value as Record<string, unknown>;
  switch (kind) {
    case 'openClawGatewayFinalReply': {
      if (!fields(value, ['sessionKey', 'event']) || !identity(v.sessionKey, 4096)) return false;
      const event = v.event as Record<string, unknown>;
      const replyOnly = event?.replyOnly;
      return (fields(event, ['runId', 'gatewayConnectionId', 'phase', 'reply'])
        || fields(event, ['runId', 'gatewayConnectionId', 'phase', 'reply', 'replyOnly']) && replyOnly === true)
        && identity(event.runId, 512) && identity(event.gatewayConnectionId, 512) && event.phase === 'completed'
        && fields(event.reply, ['text', 'sequence']) && replyText(event.reply.text)
        && Number.isSafeInteger(event.reply.sequence) && Number(event.reply.sequence) >= 0;
    }
    case 'openClawCliFinalReply': return fields(value, ['sessionKey', 'commandId', 'phase', 'deliveryMode', 'replyText'])
      && identity(v.sessionKey, 4096) && identity(v.commandId, 512)
      && (v.phase === 'completed' || v.phase === 'failed') && (v.deliveryMode === 'web-only' || v.deliveryMode === 'mirror')
      && (v.replyText === null || v.phase === 'completed' && v.deliveryMode === 'mirror' && replyText(v.replyText));
  }
}
export const validConnectorNativeReplyOutput = (_kind: ConnectorNativeReplyKind, value: unknown): value is boolean => typeof value === 'boolean';
type Owner = Pick<ConnectorUserStore, 'openClawExecutions' | 'mirrorOutbox'>;
/** Native evidence only: no mirror transport, invocation, authority proof,
 * callback, SQL or caller-supplied outbox parameters cross this boundary.
 * Original mirror fields are read from the original saved admission.
 * Final journal, mirror evidence and original event/receipt sinks retain the
 * single original transaction; no await/retry appears inside it. */
export function executeConnectorNativeReply<K extends ConnectorNativeReplyKind>(kind: K,
  input: ConnectorNativeReplyCommands[K]['input'], owner: Owner): boolean {
  if (!validConnectorNativeReplyInput(kind, input)) throw Error('connector_storage_unavailable');
  if (kind === 'openClawGatewayFinalReply') {
    const v = input as ConnectorNativeReplyCommands['openClawGatewayFinalReply']['input'];
    // Original observe owns correlation, early evidence, completed/failed
    // conflicts and the original Gateway mirror-evidence transaction.
    return owner.openClawExecutions.observe(v.sessionKey, v.event);
  }
  if (kind === 'openClawCliFinalReply') {
    const v = input as ConnectorNativeReplyCommands['openClawCliFinalReply']['input'];
    const fact = owner.openClawExecutions.get(v.sessionKey);
    if (!fact) return false;
    if (!validConnectorExecutionOutput('openClawExecutionRead', fact) || fact.sessionKey !== v.sessionKey) throw Error('connector_storage_unavailable');
    if (fact.commandId !== v.commandId || fact.origin !== 'cli') return false;
    return owner.openClawExecutions.finishCli(v.sessionKey, v.commandId, v.phase, db => {
      if (v.phase !== 'completed' || owner.openClawExecutions.get(v.sessionKey)?.phase !== 'completed') return;
      const job = owner.mirrorOutbox.get(v.commandId);
      if (v.deliveryMode === 'web-only') {
        if (job) throw Error('connector_storage_unavailable');
        return;
      }
      if (!job || job.sessionKey !== v.sessionKey || job.idempotencyKey !== v.commandId || job.legacy) throw Error('connector_storage_unavailable');
      owner.mirrorOutbox.recordCliReplyInTransaction(db, job, v.replyText === null ? undefined : v.replyText);
    });
  }
  throw Error('connector_storage_unavailable');
}
