import type { ConnectorUserStore } from '../connector/connector-user-store.js';
import { workerTurnContext } from '../connector/sdk-turn-context.js';
import { SdkOwnedRuntime, type SdkPreflight } from '../connector/sdk-owned-runtime.js';
import type { ClaudeConfig } from './config.js';
import { ClaudeExecutionDriver, type ClaudeOwnedTurn } from './execution-driver.js';
import type { ClaudeProjectedMessage } from './message-projection.js';
import type { ClaudeTextStream, ClaudeStreamFinal } from './stream-projection.js';
import type { ClaudeToolDetail } from './tool-details.js';
import type { ClaudeWorkerStart } from './worker-protocol.js';
import { ClaudeWorkerTurn } from './worker-turn.js';
import type { SdkMetricSample } from '../connector/sdk-metrics.js';
import type { DeckStore } from '../projection/deck-store.js';
import { ClaudeSessionProjection } from './session-projection.js';
import { ClaudeWorkerPreflight, ClaudeWorkerDeletion } from './worker-preflight.js';
import { sdkModelAllowed } from '../connector/sdk-models.js';
import type { PrivateWorkerDeletion } from '../connector/private-worker-preflight.js';
import { SdkCompactWorker, type CompactWorkerRequest, type SdkOwnedCompactWorker } from '../connector/sdk-compact-worker.js';
import { claudeWorkerEnvironment } from './worker-environment.js';
import { fileURLToPath } from 'node:url';
import type { InteractionRuntime } from '../commands/interaction-runtime.js';
import type { WorkerInteractionContext } from '../commands/interaction-port.js';
import { sdkInteractionContext } from '../connector/sdk-interaction.js';

type DriverOptions = ConstructorParameters<typeof ClaudeExecutionDriver>[0];
type OwnedOptions = { store: ConnectorUserStore; config: ClaudeConfig;
  interactions?: InteractionRuntime;
  authorize: DriverOptions['authorize']; changed?: DriverOptions['changed'];
  turnContext?: DriverOptions['turnContext'];
  projection?: Pick<DeckStore, 'upsertSession' | 'replaceMessages' | 'removeSession'> };
type Starter = (request: ClaudeWorkerStart, project: (rows: ClaudeProjectedMessage[], stream?: ClaudeStreamFinal, details?: ClaudeToolDetail[]) => void,
  stream: (snapshot: ClaudeTextStream) => void, metrics: (sample: SdkMetricSample) => void, interaction?: WorkerInteractionContext) => ClaudeOwnedTurn;

export class ClaudeOwnedRuntime extends SdkOwnedRuntime<'claude-code', ClaudeConfig, ClaudeExecutionDriver> {
  constructor(options: OwnedOptions,
    start: Starter = (request, project, stream, metrics, interaction) => new ClaudeWorkerTurn(request, undefined, project, stream, metrics, interaction),
    check: (config: ClaudeConfig) => SdkPreflight = config => new ClaudeWorkerPreflight(config),
    deleteNative: (config: ClaudeConfig, request: PrivateWorkerDeletion) => SdkPreflight = (config, request) => new ClaudeWorkerDeletion(config, request),
    compact: (request: CompactWorkerRequest<ClaudeConfig>) => SdkOwnedCompactWorker = request => new SdkCompactWorker(request, {
      runtime: 'claude-code', workspace: request.config.workspace, env: claudeWorkerEnvironment(request.config),
      timeoutMs: request.config.compactTimeoutMs ?? 600_000,
      launch: { entry: fileURLToPath(new URL('./worker-main.js', import.meta.url)), execArgv: [] },
    })) {
    const config = structuredClone(options.config);
    super({ ...options, config, runtime: 'claude-code', journal: options.store.claudeJournal, check,
      deleteNative,
      projection: options.projection ? new ClaudeSessionProjection(options.store, options.projection, config.model) : undefined,
      driver: hooks => new ClaudeExecutionDriver({ store: options.store, deadlineMs: config.startupTimeoutMs,
        ...(options.turnContext ? { turnContext: options.turnContext } : {}),
        authorize: (key, actor, action) => (action === 'runs:interrupt'
          || sdkModelAllowed(config, options.store.claudeJournal.session(key)?.model)) && options.authorize(key, actor, action),
        admissionReady: hooks.admissionReady, changed: hooks.changed,
        compactTimeoutMs: config.compactTimeoutMs ?? 600_000,
        startCompact: execution => {
          hooks.assertOwnership();
          return compact({ kind: 'compact', config: { ...structuredClone(config), model: execution.model ?? config.model }, execution });
        },
        start: (execution, text, project, stream, metrics, context) => {
          hooks.assertOwnership();
          const interaction = sdkInteractionContext(options.store, options.interactions, 'claude-code', execution, options.authorize);
          return start({ kind: 'start', config: { ...structuredClone(config), model: execution.model ?? config.model }, execution, text,
            ...(interaction ? { interactionMode: 'interactive' } : {}),
            ...workerTurnContext(context), attachments: options.store.sdkAttachments.forExecution(execution) }, project, stream, metrics, interaction);
        },
      }),
    });
  }
}
