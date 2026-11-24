import type { ServerConfig } from './config.js';
import { createAsyncHubApplication } from './application-hub-async.js';
import { createAsyncConnectorApplication } from './application-connector-async.js';
import { shouldRegisterConnectorRoutes, shouldRegisterHubRoutes } from './server-role.js';

/** All process roles use owned asynchronous roots. Startup refusal propagates;
 * never open a synchronous second writer or silently fall back after failure. */
export function createProcessApplication(config: ServerConfig) {
  return shouldRegisterHubRoutes(config) && !shouldRegisterConnectorRoutes(config)
    ? createAsyncHubApplication(config) : createAsyncConnectorApplication(config);
}
