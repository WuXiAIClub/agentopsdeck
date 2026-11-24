import { AsyncSdkOwnedRuntime, type AsyncSdkOwnedOptions } from '../connector/async-sdk-owned-runtime.js';
import type { AsyncSdkDriverOptions } from '../connector/async-sdk-execution-driver.js';
import { workerTurnContext } from '../connector/sdk-turn-context.js';
import { SdkCompactWorker, type CompactWorkerRequest, type SdkOwnedCompactWorker } from '../connector/sdk-compact-worker.js';
import { AsyncCopilotExecutionDriver } from './async-execution-driver.js';
import type { CopilotConfig } from './config.js';
import type { CopilotOwnedTurn } from './execution-driver.js';
import { CopilotWorkerTurn, copilotWorkerLaunch } from './worker-turn.js';
import { CopilotWorkerPreflight, CopilotWorkerDeletion } from './worker-preflight.js';
import { copilotWorkerEnvironment } from './worker-environment.js';
import { AsyncSdkConnectorRuntime } from '../connector/async-sdk-connector-runtime.js';

type Lifecycle = AsyncSdkOwnedOptions<'ghcp', CopilotConfig, AsyncCopilotExecutionDriver>;
export type AsyncCopilotOwnedOptions = Pick<Lifecycle, 'owner' | 'config' | 'projection' | 'changed' | 'diagnostics'>
  & Pick<AsyncSdkDriverOptions<CopilotOwnedTurn>, 'interactions' | 'turnContext'>;
export type AsyncCopilotOwnedPorts = Partial<Pick<Lifecycle, 'check' | 'deleteNative'>> & {
  start?: ConstructorParameters<typeof AsyncCopilotExecutionDriver>[0]['start'];
  compact?: (request: CompactWorkerRequest<CopilotConfig>) => SdkOwnedCompactWorker;
};

export function createAsyncCopilotConnectorRuntime(options: AsyncCopilotOwnedOptions, ports: AsyncCopilotOwnedPorts = {}) {
  return new AsyncSdkConnectorRuntime('ghcp', () => createAsyncCopilotOwnedRuntime(options, ports), options.diagnostics);
}

export async function createAsyncCopilotOwnedRuntime(options: AsyncCopilotOwnedOptions, ports: AsyncCopilotOwnedPorts = {}) {
  const config = structuredClone(options.config);
  return AsyncSdkOwnedRuntime.create({ ...options, config, runtime: 'ghcp',
    check: ports.check ?? (value => new CopilotWorkerPreflight(value)),
    deleteNative: ports.deleteNative ?? ((value, request) => new CopilotWorkerDeletion(value, request)),
    driver: hooks => new AsyncCopilotExecutionDriver({ owner: options.owner, deadlineMs: config.startupTimeoutMs,
      ...(options.interactions ? { interactions: options.interactions } : {}),
      ...(options.turnContext ? { turnContext: options.turnContext } : {}),
      ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
      admissionReady: hooks.admissionReady, changed: hooks.changed,
      compact: { models: config, timeoutMs: config.compactTimeoutMs ?? 600_000, start: execution => {
        hooks.assertOwnership();
        const request: CompactWorkerRequest<CopilotConfig> = { kind: 'compact', config: { ...structuredClone(config), model: execution.model ?? config.model }, execution };
        return ports.compact ? ports.compact(request) : new SdkCompactWorker(request, {
          runtime: 'ghcp', workspace: config.workspace, env: copilotWorkerEnvironment(config),
          timeoutMs: config.compactTimeoutMs ?? 600_000, launch: copilotWorkerLaunch(),
        });
      } },
      start: (execution, text, projection, context, attachments, interaction) => {
        hooks.assertOwnership();
        if (ports.start) return ports.start(execution, text, projection, context, attachments, interaction);
        return new CopilotWorkerTurn({ kind: 'start', config: { ...structuredClone(config), model: execution.model ?? config.model },
          execution, text, ...workerTurnContext(context), ...(interaction ? { interactionMode: 'interactive' } : {}),
          attachments: attachments ?? [] }, undefined, { ...projection, ...(interaction ? { interaction } : {}) });
      },
    }),
  });
}
