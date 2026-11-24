import { fileURLToPath } from 'node:url';
import { PrivateWorkerPreflight, type PrivateWorkerDeletion } from '../connector/private-worker-preflight.js';
import type { ClaudeConfig } from './config.js';
import { claudeWorkerEnvironment } from './worker-environment.js';

/** No native session or inference. This handshake does not prove provider authentication. */
export class ClaudeWorkerPreflight extends PrivateWorkerPreflight {
  constructor(config: ClaudeConfig,
    launch: { entry: string; execArgv: string[]; beforeStart?: (pid: number) => Promise<void> } = {
      entry: fileURLToPath(new URL('./worker-main.js', import.meta.url)), execArgv: [] }) {
    super({ kind: 'preflight', config }, { workspace: config.workspace, env: claudeWorkerEnvironment(config),
      timeoutMs: config.startupTimeoutMs, launch });
  }
}

export class ClaudeWorkerDeletion extends PrivateWorkerPreflight {
  constructor(config: ClaudeConfig, request: PrivateWorkerDeletion,
    launch = { entry: fileURLToPath(new URL('./worker-main.js', import.meta.url)), execArgv: [] as string[] }) {
    super({ ...request, config }, { workspace: config.workspace, env: claudeWorkerEnvironment(config),
      timeoutMs: config.startupTimeoutMs,
      launch });
  }
}
