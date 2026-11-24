import { sessionRuntimeId } from '@agentopsdeck/shared';
import { createHash } from 'node:crypto';
import { resolveExplicitChannelRoute } from '../messages/channel-route.js';
import type { MirrorDeliveryClaim, MirrorDeliveryRef } from '../messages/mirror.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { createTurnAuthorizer } from './execution-grants.js';
import { createMirrorAuthorizer } from './mirror-authorization.js';

export type ConnectorMirrorDeliveryCommands = {
  mirrorDeliveryClaim: { input: { key: string; defaultAgentId: string; localOpenClawCli: boolean }; output: MirrorDeliveryClaim };
  mirrorDeliveryAck: { input: MirrorDeliveryRef; output: boolean };
};
export type ConnectorMirrorDeliveryKind = keyof ConnectorMirrorDeliveryCommands;
export const connectorMirrorDeliverySteps = Object.freeze({ mirrorDeliveryClaim: 354, mirrorDeliveryAck: 355 });
export const isConnectorMirrorDeliveryKind = (kind: string): kind is ConnectorMirrorDeliveryKind => Object.hasOwn(connectorMirrorDeliverySteps, kind);
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => !!v && typeof v === 'object'
  && !Array.isArray(v) && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const id = (v: unknown, max = 512): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= max && !/[\x00-\x1f\x7f]/.test(v);
const key = (v: unknown): v is string => id(v, 4096) && sessionRuntimeId(v) === 'openclaw';
export function validMirrorDeliveryRef(v: unknown): v is MirrorDeliveryRef {
  return fields(v, ['key', 'id', 'messageId', 'digest', 'attemptedAt']) && key(v.key) && id(v.id)
    && id(v.messageId, 4096) && typeof v.digest === 'string' && /^[a-f0-9]{64}$/.test(v.digest)
    && Number.isSafeInteger(v.attemptedAt) && Number(v.attemptedAt) >= 0;
}
export function validConnectorMirrorDeliveryInput(kind: ConnectorMirrorDeliveryKind, v: unknown): boolean {
  return kind === 'mirrorDeliveryAck' ? validMirrorDeliveryRef(v)
    : fields(v, ['key', 'defaultAgentId', 'localOpenClawCli']) && key(v.key) && id(v.defaultAgentId) && typeof v.localOpenClawCli === 'boolean';
}
export function validConnectorMirrorDeliveryOutput(kind: ConnectorMirrorDeliveryKind, v: unknown): boolean {
  if (kind === 'mirrorDeliveryAck') return typeof v === 'boolean';
  if (fields(v, ['state'])) return ['idle', 'blocked', 'no_output'].includes(String(v.state));
  return fields(v, ['state', 'ref', 'route', 'text']) && v.state === 'send' && validMirrorDeliveryRef(v.ref)
    && typeof v.text === 'string' && !!v.text.trim() && createHash('sha256').update(v.text).digest('hex') === v.ref.digest
    && fields(v.route, ['originatingChannel', 'originatingTo', 'outboundTarget'], ['originatingAccountId'])
    && id(v.route.originatingChannel) && id(v.route.originatingTo, 4096) && id(v.route.outboundTarget, 4096)
    && (v.route.originatingAccountId === undefined || id(v.route.originatingAccountId));
}
export function mirrorDeliveryReplyMatches(input: ConnectorMirrorDeliveryCommands['mirrorDeliveryClaim']['input'], v: MirrorDeliveryClaim): boolean {
  if (v.state !== 'send') return true;
  const route = resolveExplicitChannelRoute(input.key, input.defaultAgentId);
  return input.localOpenClawCli && v.ref.key === input.key && !!route
    && route.originatingChannel === v.route.originatingChannel && route.originatingTo === v.route.originatingTo
    && route.outboundTarget === v.route.outboundTarget && route.originatingAccountId === v.route.originatingAccountId;
}
/** Internal fixed lane: callers cannot supply actor, native evidence, route or
 * text. Original admission and original live token/grant stores are authority. */
export function executeConnectorMirrorDelivery<K extends ConnectorMirrorDeliveryKind>(kind: K,
  input: ConnectorMirrorDeliveryCommands[K]['input'], owner: ConnectorUserStore,
  tokens?: ConnectorTokenStore): ConnectorMirrorDeliveryCommands[K]['output'] {
  if (!validConnectorMirrorDeliveryInput(kind, input)) throw Error('connector_storage_unavailable');
  let value: unknown;
  if (kind === 'mirrorDeliveryAck') value = owner.mirrorOutbox.acknowledgeDelivery(input as MirrorDeliveryRef);
  else {
    const v = input as ConnectorMirrorDeliveryCommands['mirrorDeliveryClaim']['input'];
    // Maintenance/closing is a temporary veto, not a reason to retire intent.
    if (!owner.sdkCommandAdmissionOpen) value = { state: 'idle' };
    else {
      if (!tokens) throw Error('connector_storage_unavailable');
      const authorize = createTurnAuthorizer(owner.executionGrants, (actor, scope) => tokens.hasScope(actor, scope));
      value = owner.mirrorOutbox.claimDelivery(v.key, v.localOpenClawCli, createMirrorAuthorizer(authorize, v.defaultAgentId));
    }
  }
  if (!validConnectorMirrorDeliveryOutput(kind, value)) throw Error('connector_storage_unavailable');
  // Only committed journal rows may wake stream readers. Unknown sends do not
  // invent a failure or success event; the original durable attempt owns that.
  if (kind === 'mirrorDeliveryAck' ? value === true : (value as MirrorDeliveryClaim).state !== 'idle') owner.events.changes.notify();
  return value as ConnectorMirrorDeliveryCommands[K]['output'];
}
