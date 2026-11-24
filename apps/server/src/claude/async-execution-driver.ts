import { AsyncSdkExecutionDriver, type AsyncSdkDriverOptions } from '../connector/async-sdk-execution-driver.js';
import type { AsyncSdkProjection } from '../connector/async-sdk-projection.js';
import type { SdkExecution } from '../connector/sdk-execution-journal.js';
import type { SdkInputAttachment } from '../connector/sdk-attachment-input.js';
import type { SdkTurnContext } from '../connector/sdk-turn-context.js';
import type { WorkerInteractionContext } from '../commands/interaction-port.js';
import { ClaudeDispatchAdapter } from './dispatch-adapter.js';
import type { ClaudeOwnedTurn } from './execution-driver.js';

export class AsyncClaudeExecutionDriver extends AsyncSdkExecutionDriver<ClaudeOwnedTurn> {
  constructor(options: Omit<AsyncSdkDriverOptions<ClaudeOwnedTurn>, 'runtime' | 'start' | 'adapter'> & {
    start: (execution: SdkExecution, text: string, projection: ReturnType<AsyncSdkProjection['claude']>,
      context?: SdkTurnContext, attachments?: SdkInputAttachment[], interaction?: WorkerInteractionContext) => ClaudeOwnedTurn;
  }) {
    super({ ...options, runtime: 'claude-code', adapter: callbacks => new ClaudeDispatchAdapter(callbacks),
      start: (execution, text, projection, context, attachments, interaction) =>
        options.start(execution, text, projection.claude(execution), context, attachments, interaction) });
  }
}
