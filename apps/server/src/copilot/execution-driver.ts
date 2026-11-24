import type { ConnectorUserStore } from '../connector/connector-user-store.js';
import type { SdkTurnContext } from '../connector/sdk-turn-context.js';
import { SdkExecutionDriver, type SdkDriverOptions } from '../connector/sdk-execution-driver.js';
import type { SdkExecution } from '../connector/sdk-execution-journal.js';
import { CopilotDispatchAdapter, type CopilotNativeTurn } from './dispatch-adapter.js';
import type { CopilotWorkerProjection } from './worker-turn.js';

export type CopilotOwnedTurn = CopilotNativeTurn & { finished: Promise<void> };
export class CopilotExecutionDriver extends SdkExecutionDriver<CopilotOwnedTurn> {
  constructor(options: Pick<SdkDriverOptions<CopilotOwnedTurn>, 'deadlineMs' | 'admissionReady' | 'authorize' | 'changed' | 'startCompact' | 'compactTimeoutMs' | 'turnContext'> & {
    store: Pick<ConnectorUserStore, 'turns' | 'copilotJournal' | 'copilotTranscript'>;
    start: (execution: SdkExecution, text: string, projection: CopilotWorkerProjection, context?: SdkTurnContext) => CopilotOwnedTurn;
  }) {
    const { store } = options;
    super({ ...options, journal: store.copilotJournal, turns: store.turns,
      adapter: callbacks => new CopilotDispatchAdapter(callbacks),
      endStreams: ref => store.copilotTranscript.endStreams(ref),
      start: (execution, text, changed, context) => options.start(execution, text, {
        project: (row, detail) => { store.copilotTranscript.append(execution, row, text, detail); changed(); },
        stream: snapshot => { if (store.copilotTranscript.updateStream(execution, snapshot)) changed(); },
        metrics: sample => { if (store.copilotJournal.recordMetrics(execution, sample)) changed(); },
      }, context),
    });
  }
}
