import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createProcessApplication } from './application-process.js';
import type { Server } from 'node:http';
import { attachWebsiteSocketUpgrade } from './hub/website-socket-gateway.js';
import { startEventLoopWatchdog } from './diagnostics/event-loop-watchdog.js';
import { bootstrapAsyncProcess } from './lifecycle/async-process-bootstrap.js';
import { startupApplicationCleanup } from './lifecycle/startup-cleanup.js';

// Observe synchronous startup and shutdown too, without owning any business
// resource. Tests constructing applications do not launch a process watchdog.
const eventLoopWatchdog = startEventLoopWatchdog();
const { lifetime } = bootstrapAsyncProcess({
  loadConfig,
  createApplication: createProcessApplication,
  applicationOwner: application => ({ close: application.close,
    canRetry: () => application.close.snapshot().state === 'cleanup-required' }),
  mainListener: (application, config) => serve({ fetch: application.app.fetch, port: config.port,
    ...(config.listenHost !== undefined ? { hostname: config.listenHost } : {}) }, info => {
    const address = info.address.includes(':') ? `[${info.address}]` : info.address;
    console.log(`AgentOpsDeck server listening on http://${address}:${info.port}`);
  }),
  // The preview listener has no Hub routes or authentication cookies.
  websiteListener: application => application.websiteGateway ? serve({ fetch: application.websiteGateway.fetch,
    port: application.websiteGateway.config.port, hostname: '127.0.0.1' }) : undefined,
  // HTTP/1 upgrade handling is installed only on the isolated website listener.
  websiteSockets: (listener, application) => ({ close: attachWebsiteSocketUpgrade(listener as Server,
    application.websiteGateway!).close, canRetry: () => true }),
  failedApplicationOwner: { close: () => startupApplicationCleanup.closeRetainedOwners(),
    canRetry: () => startupApplicationCleanup.snapshot().retryable > 0 },
  onFailure: () => { process.exitCode = 1; },
  onClosed: exitCode => { eventLoopWatchdog.stop(); process.exit(exitCode); },
});
process.on('SIGINT', () => { void lifetime.shutdown(); });
process.on('SIGTERM', () => { void lifetime.shutdown(); });
