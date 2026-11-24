import { PrivateWorkerPreflight, type PrivateWorkerDeletion } from '../connector/private-worker-preflight.js';
import type { CopilotConfig } from './config.js';
import { copilotWorkerEnvironment } from './worker-environment.js';
import { copilotWorkerLaunch, type CopilotWorkerLaunch } from './worker-turn.js';

/** Control-only handshake; no session, inference or provider-authentication claim. */
export class CopilotWorkerPreflight extends PrivateWorkerPreflight {
  constructor(config: CopilotConfig, launch: CopilotWorkerLaunch = copilotWorkerLaunch()) {
    super({ kind: 'preflight', config }, { workspace: config.workspace, env: copilotWorkerEnvironment(config),
      timeoutMs: config.startupTimeoutMs, launch });
  }
}

export class CopilotWorkerDeletion extends PrivateWorkerPreflight {
  constructor(config: CopilotConfig, request: PrivateWorkerDeletion, launch: CopilotWorkerLaunch = copilotWorkerLaunch()) {
    super({ ...request, config }, { workspace: config.workspace, env: copilotWorkerEnvironment(config),
      timeoutMs: config.startupTimeoutMs, launch });
  }
}
