import type { InteractionCapabilities } from '@agentopsdeck/shared';
import type { InteractionRuntime } from '../commands/interaction-runtime.js';
import type { WorkerInteractionContext } from '../commands/interaction-port.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import type { SdkExecution } from './sdk-execution-journal.js';
import type { SdkTextInput } from './sdk-dispatch.js';

export const sdkInteractionCapabilities: InteractionCapabilities = {
  version: 1, kinds: ['approval', 'text', 'single-select', 'multi-select'], modes: ['automatic', 'interactive'],
};
export function interactionCapabilitiesFor(agent: string): InteractionCapabilities {
  return { ...sdkInteractionCapabilities, kinds: sdkInteractionCapabilities.kinds.filter(kind => kind !== 'multi-select' || agent === 'claude-code') };
}

export function sdkInteractionContext(store: ConnectorUserStore, runtime: InteractionRuntime | undefined,
  agent: 'claude-code' | 'ghcp', execution: SdkExecution,
  authorize: (key: string, actor: SdkTextInput, action: 'messages:send') => boolean): WorkerInteractionContext | undefined {
  if (!runtime) return;
  const ownerId = store.turns.interactionOwner(agent, execution.key, execution.members);
  if (!ownerId) return; // no delegated/shared authority inferred
  const scope = { ownerId, nodeId: store.nodeId, sessionKey: execution.key, runId: execution.id };
  if (store.interactions.mode(scope) !== 'interactive') return;
  const journal = agent === 'ghcp' ? store.copilotJournal : store.claudeJournal;
  const live = () => {
    const current = journal.current(execution.key);
    return store.sdkCommandAdmissionOpen && current?.id === execution.id && current.epoch === execution.epoch
      && !current.stopRequested && ['dispatching', 'running'].includes(current.phase)
      && !store.commands.sessionDeletion(execution.key);
  };
  return { runtime, scope, capabilities: interactionCapabilitiesFor(agent),
    // Neither SDK exposes native goal continuations. Explicit absent is not
    // inferred from a failed/unsupported Codex goal lookup.
    continuation: async () => {
      if (!live()) throw new Error('Original native execution is unavailable');
      return { connectionId: execution.epoch, goal: { status: 'absent', version: `${agent}:no-native-goal:v1` } };
    },
    permitted: async () => live() && authorize(execution.key, { actorId: ownerId, text: '', images: [] }, 'messages:send'),
  };
}
