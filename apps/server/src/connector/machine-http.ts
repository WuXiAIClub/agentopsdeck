import type { Hono } from 'hono';
import type { ServerConfig } from '../config.js';
import type { ConnectorMachineAuthority } from './machine-authority.js';
import { closeMachineServices } from './machine-authority.js';
import { registerConnectorFileRoutes } from './files-http.js';
import { registerConnectorIssueRoutes } from './issues-http.js';
import { registerConnectorWebsiteRoutes } from './websites-http.js';
import { registerConnectorWebsiteAccess } from './website-access-http.js';
import { registerConnectorWebsiteActions } from './website-actions-http.js';
import { registerConnectorTerminals } from './terminals-http.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';

type MachineConfig = Pick<ServerConfig, 'fileBrowserRoots' | 'issueSources' | 'websiteServices' | 'terminalTargets'>;

/** Original opt-in machine effects, shared by both Connector roots. Construction
 * neither fetches remote content nor starts a PTY. Authority is supplied by the
 * root: the worker variant retains the original caller's evidence per request.
 * No session grant or internal local credential confers machine authority. */
export function registerConnectorMachineHttp(app: Hono, tokens: ConnectorMachineAuthority, config: MachineConfig) {
  const services: { close(): Promise<void> }[] = [];
  let closed = false, closing: Promise<void> | undefined;
  const base = '/api/connector/v1';
  const paths = ['files', 'issues', 'websites', 'website-access', 'website-actions', 'terminals'];
  app.use(`${base}/*`, async (c, next) => {
    const path = c.req.path.slice(base.length + 1).split('/')[0];
    if (closed && paths.includes(path!)) return c.json({ error: 'Machine service unavailable' }, 503);
    await next();
  });
  const close = (): Promise<void> => {
    if (closing) return closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    closed = true;
    // Start every physical drain in this tick even if a peer throws. Retain a
    // shared promise before callbacks so reentrant cleanup cannot close twice.
    void closeMachineServices(services.map(service => () => service.close())).then(resolve, () => reject(new ConnectorOwnerUnavailable()));
    return closing;
  };
  let ready: Promise<void>;
  try {
    services.push(registerConnectorFileRoutes(app, tokens, config.fileBrowserRoots));
    services.push(registerConnectorIssueRoutes(app, tokens, config.issueSources));
    services.push(registerConnectorWebsiteRoutes(app, tokens, config.websiteServices));
    services.push(registerConnectorWebsiteAccess(app, tokens, config.websiteServices));
    services.push(registerConnectorWebsiteActions(app, tokens, config.websiteServices));
    services.push(registerConnectorTerminals(app, tokens, config.terminalTargets));
    ready = Promise.resolve();
  } catch {
    // Preserve partial construction cleanup in startup's readiness promise.
    // Neither root may announce ready with a partially registered machine API.
    closed = true;
    ready = close().then(() => { throw new ConnectorOwnerUnavailable(); });
    void ready.catch(() => {});
  }
  return { ready, close };
}
