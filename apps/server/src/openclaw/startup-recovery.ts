import type { SendDeliveryMode } from '@agentopsdeck/shared';
import { isRecord, type TurnQueue } from '../commands/turn-queue.js';
import type { OpenClawExecutions } from './executions.js';
import type { ExplicitRoute, OpenClawQueuedPayload } from './turn-queue.js';

/** Sole-owner startup only. Legacy entries cannot prove that a previous send
 * never reached the native runtime. Preserve them as unknown, never replay. */
export function recoverOpenClawStartup(turns: TurnQueue, executions: OpenClawExecutions, queueFile?: string) {
  executions.recoverInterrupted();
  turns.importLegacy<OpenClawQueuedPayload>('openclaw', queueFile, (sessionKey, entry) => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.sessionKey !== sessionKey
      || typeof entry.message !== 'string' || typeof entry.createdAt !== 'number'
      || !['web-only', 'mirror'].includes(String(entry.deliveryMode)) || !Array.isArray(entry.media)
      || entry.media.some(item => !isRecord(item) || !isRecord(item.media) || !isRecord(item.gatewayAttachment))
      || (entry.inFlight !== undefined && typeof entry.inFlight !== 'boolean')
      || (entry.deliveryMode === 'mirror' && (!isRecord(entry.explicitRoute) || typeof entry.explicitRoute.outboundTarget !== 'string'))) {
      throw new Error('Invalid legacy OpenClaw queue entry');
    }
    return { id: entry.id, sessionKey, createdAt: entry.createdAt, state: 'outcome_unknown',
      payload: { message: entry.message, deliveryMode: entry.deliveryMode as SendDeliveryMode,
        media: entry.media as OpenClawQueuedPayload['media'],
        ...(entry.explicitRoute ? { explicitRoute: entry.explicitRoute as ExplicitRoute } : {}) } };
  });
  turns.recoverInterrupted('openclaw');
}
