import type { ConnectorUserStore } from '../connector/connector-user-store.js';
import type { SdkTurnContext } from '../connector/sdk-turn-context.js';
import { SdkExecutionDriver, type SdkDriverOptions } from '../connector/sdk-execution-driver.js';
import type { SdkExecution } from '../connector/sdk-execution-journal.js';
import { ClaudeDispatchAdapter, type ClaudeNativeTurn } from './dispatch-adapter.js';
import type { ClaudeProjectedMessage } from './message-projection.js';
import type { ClaudeTextStream, ClaudeStreamFinal } from './stream-projection.js';
import type { ClaudeToolDetail } from './tool-details.js';
import type { SdkMetricSample } from '../connector/sdk-metrics.js';

export type ClaudeOwnedTurn = ClaudeNativeTurn & { finished: Promise<void> };
/** Native protocol and projection stay vendor-specific; queue scheduling,
 * exact-run stop, maintenance pause and cleanup fencing are shared. */
export class ClaudeExecutionDriver extends SdkExecutionDriver<ClaudeOwnedTurn> {
  constructor(options: Pick<SdkDriverOptions<ClaudeOwnedTurn>, 'deadlineMs' | 'admissionReady' | 'authorize' | 'changed' | 'startCompact' | 'compactTimeoutMs' | 'turnContext'> & {
    store: Pick<ConnectorUserStore, 'turns' | 'claudeJournal' | 'claudeTranscript'>;
    start: (execution: SdkExecution, text: string, project: (rows: ClaudeProjectedMessage[], stream?: ClaudeStreamFinal, details?: ClaudeToolDetail[]) => void,
      stream: (snapshot: ClaudeTextStream) => void, metrics: (sample: SdkMetricSample) => void, context?: SdkTurnContext) => ClaudeOwnedTurn;
  }) {
    const { store } = options;
    super({ ...options, journal: store.claudeJournal, turns: store.turns,
      adapter: callbacks => new ClaudeDispatchAdapter(callbacks),
      endStreams: ref => store.claudeTranscript.endStreams(ref),
      start: (execution, text, changed, context) => options.start(execution, text, (rows, stream, details) => {
        store.claudeTranscript.append(execution, rows, stream, details); changed();
      }, snapshot => { if (store.claudeTranscript.updateStream(execution, snapshot)) changed(); },
      sample => { if (store.claudeJournal.recordMetrics(execution, sample)) changed(); }, context),
    });
  }
}
