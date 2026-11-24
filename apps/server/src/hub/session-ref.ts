import { isAgentRuntimeId, sessionRuntimeId, type SessionRef } from '@agentopsdeck/shared';
import { isNodeId } from '../connector/node-identity.js';

// The current Connector protocol prefixes Codex thread IDs. Keep this legacy
// translation in one place; the reference itself carries runtime separately.
export function sessionRef(nodeId: string | undefined, legacyKey: string): SessionRef | undefined {
  if (!isNodeId(nodeId)) return undefined; // Unverified nodes have no canonical identity.
  if (!validKey(legacyKey)) throw new Error('Invalid Connector session key');
  const runtimeId = sessionRuntimeId(legacyKey);
  const nativeSessionKey = runtimeId === 'openclaw' ? legacyKey : legacyKey.slice(runtimeId.length + 1);
  if (!validKey(nativeSessionKey)) throw new Error('Invalid native session key');
  return { nodeId, runtimeId, nativeSessionKey };
}

export function legacySessionKey(ref: SessionRef): string {
  if (!isNodeId(ref.nodeId) || !validKey(ref.nativeSessionKey)
    || !isAgentRuntimeId(ref.runtimeId)) throw new Error('Invalid SessionRef');
  // A legacy OpenClaw key in the Codex namespace cannot be routed losslessly.
  if (ref.runtimeId === 'openclaw' && sessionRuntimeId(ref.nativeSessionKey) !== 'openclaw') throw new Error('Ambiguous legacy session key');
  const key = ref.runtimeId === 'openclaw' ? ref.nativeSessionKey : `${ref.runtimeId}:${ref.nativeSessionKey}`;
  if (!validKey(key)) throw new Error('Invalid Connector session key');
  return key;
}

function validKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.length <= 4096
    && !/[\u0000-\u001f\u007f]/.test(key)
    && Buffer.from(key, 'utf8').toString('utf8') === key;
}
