import { fileURLToPath } from 'node:url';
import { AsyncSdkOwnedRuntime, type AsyncSdkOwnedOptions } from '../connector/async-sdk-owned-runtime.js';
import type { AsyncSdkDriverOptions } from '../connector/async-sdk-execution-driver.js';
import { workerTurnContext } from '../connector/sdk-turn-context.js';
import { SdkCompactWorker, type CompactWorkerRequest, type SdkOwnedCompactWorker } from '../connector/sdk-compact-worker.js';
import { AsyncClaudeExecutionDriver } from './async-execution-driver.js';
import type { ClaudeConfig } from './config.js';
import type { ClaudeOwnedTurn } from './execution-driver.js';
import { ClaudeWorkerTurn } from './worker-turn.js';
import { ClaudeWorkerPreflight, ClaudeWorkerDeletion } from './worker-preflight.js';
import { claudeWorkerEnvironment } from './worker-environment.js';
import { AsyncSdkConnectorRuntime } from '../connector/async-sdk-connector-runtime.js';

type Lifecycle = AsyncSdkOwnedOptions<'claude-code', ClaudeConfig, AsyncClaudeExecutionDriver>;
export type AsyncClaudeOwnedOptions = Pick<Lifecycle, 'owner' | 'config' | 'projection' | 'changed' | 'diagnostics'>
  & Pick<AsyncSdkDriverOptions<ClaudeOwnedTurn>, 'interactions' | 'turnContext'>;
export type AsyncClaudeOwnedPorts = Partial<Pick<Lifecycle, 'check' | 'deleteNative'>> & {
  start?: ConstructorParameters<typeof AsyncClaudeExecutionDriver>[0]['start'];
  compact?: (request: CompactWorkerRequest<ClaudeConfig>) => SdkOwnedCompactWorker;
};

export function createAsyncClaudeConnectorRuntime(options: AsyncClaudeOwnedOptions, ports: AsyncClaudeOwnedPorts = {}) {
  return new AsyncSdkConnectorRuntime('claude-code', () => createAsyncClaudeOwnedRuntime(options, ports), options.diagnostics);
}

/** Original native worker/protocol and sole DB owner. No sync-store lookup,
 * detached identity or alternative projection/interaction implementation. */
export async function createAsyncClaudeOwnedRuntime(options: AsyncClaudeOwnedOptions, ports: AsyncClaudeOwnedPorts = {}) {
  const config = structuredClone(options.config);
  return AsyncSdkOwnedRuntime.create({ ...options, config, runtime: 'claude-code',
    check: ports.check ?? (value => new ClaudeWorkerPreflight(value)),
    deleteNative: ports.deleteNative ?? ((value, request) => new ClaudeWorkerDeletion(value, request)),
    driver: hooks => new AsyncClaudeExecutionDriver({ owner: options.owner, deadlineMs: config.startupTimeoutMs,
      ...(options.interactions ? { interactions: options.interactions } : {}),
      ...(options.turnContext ? { turnContext: options.turnContext } : {}),
      ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
      admissionReady: hooks.admissionReady, changed: hooks.changed,
      compact: { models: config, timeoutMs: config.compactTimeoutMs ?? 600_000, start: execution => {
        hooks.assertOwnership();
        const request: CompactWorkerRequest<ClaudeConfig> = { kind: 'compact', config: { ...structuredClone(config), model: execution.model ?? config.model }, execution };
        return ports.compact ? ports.compact(request) : new SdkCompactWorker(request, {
          runtime: 'claude-code', workspace: config.workspace, env: claudeWorkerEnvironment(config),
          timeoutMs: config.compactTimeoutMs ?? 600_000,
          launch: { entry: fileURLToPath(new URL('./worker-main.js', import.meta.url)), execArgv: [] },
        });
      } },
      start: (execution, text, projection, context, attachments, interaction) => {
        hooks.assertOwnership();
        if (ports.start) return ports.start(execution, text, projection, context, attachments, interaction);
        return new ClaudeWorkerTurn({ kind: 'start', config: { ...structuredClone(config), model: execution.model ?? config.model },
          execution, text, ...workerTurnContext(context), ...(interaction ? { interactionMode: 'interactive' } : {}),
          attachments: attachments ?? [] }, undefined, projection.project, projection.stream, projection.metrics, interaction);
      },
    }),
  });
}
