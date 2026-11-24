import { join } from 'node:path';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { executeConnectorSdkDispatch, validConnectorSdkDispatchInput } from './connector-sdk-dispatch-domain.js';
import type { ConnectorSdkDispatchCommands } from './connector-sdk-dispatch-domain.js';
import type { SdkTextInput } from './sdk-dispatch.js';
import { workerTurnContext } from './sdk-turn-context.js';
import { boardFileCodec, BOARD_CONTEXT_MAX_CHARS } from './workspace-board-file-format.js';
import { cardFileCodec } from './workspace-file-card-format.js';
import { LOCAL_FILE_BOARD_OWNER, type FileBoardPolicy } from './workspace-board-file-policy.js';
import { createWorkspaceFileAuthorizer, type WorkspaceFileToolPolicies } from './connector-workspace-file-domain.js';

type Scope = ConnectorSdkDispatchCommands['sdkNativeReady']['input'];
type Context = { text: string; files: string[] };
export type ConnectorSdkContextCommands = {
  sdkExecutionContext: { input: Scope; output: (Scope & { context: Context }) | null };
};
export const connectorSdkContextSteps = Object.freeze({ sdkExecutionContext: 335 });
export const validConnectorSdkContextInput = (value: unknown): value is Scope => validConnectorSdkDispatchInput('sdkNativeReady', value);
export function validConnectorSdkContextOutput(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'context')) return false;
  const { context, ...scope } = value as Scope & { context: unknown };
  if (!validConnectorSdkContextInput(scope) || !context || typeof context !== 'object' || Array.isArray(context)
    || Object.keys(context).sort().join(',') !== 'files,text') return false;
  try { workerTurnContext(context as Context); return true; } catch { return false; }
}
export function sdkContextReplyMatches(input: Scope, output: Scope): boolean {
  return output.runtime === input.runtime && output.ref.id === input.ref.id && output.ref.key === input.ref.key
    && output.ref.epoch === input.ref.epoch && output.ref.nativeSessionId === input.ref.nativeSessionId;
}

/** The original dispatching FIFO supplies identity. No caller actor, path,
 * permission flag, filesystem effect or second writer participates here. */
export function createConnectorSdkContextCommands(owner: ConnectorUserStore, tokens?: ConnectorTokenStore,
  policy?: FileBoardPolicy, toolPolicies: WorkspaceFileToolPolicies = {}) {
  const allowed = createWorkspaceFileAuthorizer(owner, tokens, policy, toolPolicies);
  const boards = policy ? owner.createWorkspaceFileMetadata(boardFileCodec, allowed) : undefined;
  const cards = policy ? owner.createWorkspaceFileMetadata(cardFileCodec(), allowed) : undefined;
  return (input: Scope): ConnectorSdkContextCommands['sdkExecutionContext']['output'] => {
    if (!validConnectorSdkContextInput(input) || !tokens) throw Error('connector_storage_unavailable');
    if (!executeConnectorSdkDispatch('sdkNativeReady', input, owner, tokens)) return null;
    const original = owner.turns.dispatchPrefix<SdkTextInput>(input.runtime, input.ref.key)[0]!.payload;
    const actor = original.actorId === 'local:daily' ? LOCAL_FILE_BOARD_OWNER : original.actorId;
    let context: Context = { text: '', files: [] };
    if (policy && boards && cards && !original.executionGrant && allowed(actor, input.ref.key)) {
      const boardPaths = boards.filesForSession(actor, input.ref.key).map(row => join(policy.root, row.id, boardFileCodec.name));
      const cardPaths = cards.filesForSession(actor, input.ref.key).map(row => join(policy.root, row.id, cards.codec.name));
      context = { text: [boardFileCodec.context(boardPaths), cards.codec.context(cardPaths)].filter(Boolean).join('\n\n'),
        files: [...boardPaths, ...cardPaths] };
    }
    if (context.text.length > BOARD_CONTEXT_MAX_CHARS) throw Error('connector_storage_unavailable');
    const result = { runtime: input.runtime, ref: { ...input.ref }, context };
    if (!validConnectorSdkContextOutput(result)) throw Error('connector_storage_unavailable');
    return result;
  };
}
