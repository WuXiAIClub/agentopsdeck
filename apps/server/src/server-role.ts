import type { ServerConfig } from './config.js';

export function shouldRegisterHubRoutes(config: ServerConfig) {
  return config.hub.enabled && (config.serverRole === 'all' || config.serverRole === 'hub');
}

export function shouldRegisterConnectorRoutes(config: ServerConfig) {
  return config.serverRole === 'all' || config.serverRole === 'connector';
}

export function usesInProcessConnector(config: ServerConfig) {
  return shouldRegisterConnectorRoutes(config);
}
