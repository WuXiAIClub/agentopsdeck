import { AsyncSdkExecutionDriver, type AsyncSdkDriverOptions } from '../connector/async-sdk-execution-driver.js';
import type { AsyncSdkProjection } from '../connector/async-sdk-projection.js';
import type { SdkExecution } from '../connector/sdk-execution-journal.js';
import type { SdkInputAttachment } from '../connector/sdk-attachment-input.js';
import type { SdkTurnContext } from '../connector/sdk-turn-context.js';
import type { WorkerInteractionContext } from '../commands/interaction-port.js';
import { CopilotDispatchAdapter } from './dispatch-adapter.js';
import type { CopilotOwnedTurn } from './execution-driver.js';

export class AsyncCopilotExecutionDriver extends AsyncSdkExecutionDriver<CopilotOwnedTurn> {
  constructor(options: Omit<AsyncSdkDriverOptions<CopilotOwnedTurn>, 'runtime' | 'start' | 'adapter'> & {
    start: (execution: SdkExecution, text: string, projection: ReturnType<AsyncSdkProjection['copilot']>,
      context?: SdkTurnContext, attachments?: SdkInputAttachment[], interaction?: WorkerInteractionContext) => CopilotOwnedTurn;
  }) {
    super({ ...options, runtime: 'ghcp', adapter: callbacks => new CopilotDispatchAdapter(callbacks),
      start: (execution, text, projection, context, attachments, interaction) =>
        options.start(execution, text, projection.copilot(execution, text), context, attachments, interaction) });
  }
}
