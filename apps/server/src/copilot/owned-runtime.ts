import type { ConnectorUserStore } from '../connector/connector-user-store.js';
import { workerTurnContext } from '../connector/sdk-turn-context.js';
import { SdkOwnedRuntime, type SdkPreflight } from '../connector/sdk-owned-runtime.js';
import type { CopilotConfig } from './config.js';
import { CopilotExecutionDriver, type CopilotOwnedTurn } from './execution-driver.js';
import type { CopilotWorkerStart } from './worker-protocol.js';
import { CopilotWorkerTurn, type CopilotWorkerProjection } from './worker-turn.js';
import type { DeckStore } from '../projection/deck-store.js';
import { CopilotSessionProjection } from './session-projection.js';
import { CopilotWorkerPreflight, CopilotWorkerDeletion } from './worker-preflight.js';
import { sdkModelAllowed } from '../connector/sdk-models.js';
import type { PrivateWorkerDeletion } from '../connector/private-worker-preflight.js';
import { SdkCompactWorker, type CompactWorkerRequest, type SdkOwnedCompactWorker } from '../connector/sdk-compact-worker.js';
import { copilotWorkerEnvironment } from './worker-environment.js';
import { copilotWorkerLaunch } from './worker-turn.js';
import type { InteractionRuntime } from '../commands/interaction-runtime.js';
import { sdkInteractionContext } from '../connector/sdk-interaction.js';

type DriverOptions = ConstructorParameters<typeof CopilotExecutionDriver>[0];
type OwnedOptions = { store: ConnectorUserStore; config: CopilotConfig;
  interactions?: InteractionRuntime;
  authorize: DriverOptions['authorize']; changed?: DriverOptions['changed'];
  turnContext?: DriverOptions['turnContext'];
  projection?: Pick<DeckStore, 'upsertSession' | 'replaceMessages' | 'removeSession'> };
type Starter = (request: CopilotWorkerStart, projection: CopilotWorkerProjection) => CopilotOwnedTurn;

export class CopilotOwnedRuntime extends SdkOwnedRuntime<'ghcp', CopilotConfig, CopilotExecutionDriver> {
  constructor(options: OwnedOptions,
    start: Starter = (request, projection) => new CopilotWorkerTurn(request, undefined, projection),
    check: (config: CopilotConfig) => SdkPreflight = config => new CopilotWorkerPreflight(config),
    deleteNative: (config: CopilotConfig, request: PrivateWorkerDeletion) => SdkPreflight = (config, request) => new CopilotWorkerDeletion(config, request),
    compact: (request: CompactWorkerRequest<CopilotConfig>) => SdkOwnedCompactWorker = request => new SdkCompactWorker(request, {
      runtime: 'ghcp', workspace: request.config.workspace, env: copilotWorkerEnvironment(request.config),
      timeoutMs: request.config.compactTimeoutMs ?? 600_000, launch: copilotWorkerLaunch(),
    })) {
    const config = structuredClone(options.config);
    super({ ...options, config, runtime: 'ghcp', journal: options.store.copilotJournal, check,
      deleteNative,
      projection: options.projection ? new CopilotSessionProjection(options.store, options.projection, config.model) : undefined,
      driver: hooks => new CopilotExecutionDriver({ store: options.store, deadlineMs: config.startupTimeoutMs,
        ...(options.turnContext ? { turnContext: options.turnContext } : {}),
        authorize: (key, actor, action) => (action === 'runs:interrupt'
          || sdkModelAllowed(config, options.store.copilotJournal.session(key)?.model)) && options.authorize(key, actor, action),
        admissionReady: hooks.admissionReady, changed: hooks.changed,
        compactTimeoutMs: config.compactTimeoutMs ?? 600_000,
        startCompact: execution => {
          hooks.assertOwnership();
          return compact({ kind: 'compact', config: { ...structuredClone(config), model: execution.model ?? config.model }, execution });
        },
        start: (execution, text, projection, context) => {
          hooks.assertOwnership();
          const interaction = sdkInteractionContext(options.store, options.interactions, 'ghcp', execution, options.authorize);
          return start({ kind: 'start', config: { ...structuredClone(config), model: execution.model ?? config.model }, execution, text,
            ...(interaction ? { interactionMode: 'interactive' } : {}),
            ...workerTurnContext(context), attachments: options.store.sdkAttachments.forExecution(execution) }, { ...projection, ...(interaction ? { interaction } : {}) });
        },
      }),
    });
  }
}
