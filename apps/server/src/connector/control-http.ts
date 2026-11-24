import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AsyncConnectorControl } from './async-connector-control.js';
import { registerConnectorUsersHttp } from './users-http.js';
import { registerExecutionGrantHttp } from './execution-grant-http.js';
import { registerStorageDiagnostics } from '../storage/diagnostics-http.js';
import { ReadRequestError } from '../lifecycle/read-request-owner.js';
import type { ConnectorStorageCommands, ConnectorStorageKind } from './connector-storage-domain.js';

export type ConnectorControlHttp = Pick<AsyncConnectorControl, 'identity' | 'users' | 'grants' | 'storage' | 'close'>;

/** Mount after protocol/node gates, before every legacy authority middleware.
 * Operator token provisioning is deliberately NOT part of this bearer port. */
export function registerConnectorControlHttp(app: Hono, nodeId: string, control: ConnectorControlHttp) {
  const base = '/api/connector/v1';
  app.get(`${base}/identity`, async c => {
    c.header('Cache-Control', 'no-store');
    try {
      return await control.identity(c.req.raw) ? c.json({ nodeId, protocol: 1 }) : c.json({ error: 'unauthorized' }, 401);
    } catch (error) {
      return c.json({ error: 'Connector identity unavailable' }, error instanceof ReadRequestError ? error.status : 503);
    }
  });
  registerConnectorUsersHttp(app, base, control.users);
  registerExecutionGrantHttp(app, nodeId, control.grants);
  const storage = registerStorageDiagnostics(app, `${base}/maintenance/storage`, {
    access: async c => {
      const execute = async <K extends ConnectorStorageKind>(kind: K): Promise<Extract<ConnectorStorageCommands[K]['output'], { status: 200 }>['value']> => {
        const result = await control.storage.execute(kind, c.req.raw);
        if (result.status !== 200) throw new HTTPException(result.status);
        return result.value;
      };
      await execute('authorizedStorageRecovery');
      return {
        check: async () => { await execute('authorizedStorageRecovery'); },
        stats: () => execute('authorizedStorageStats'),
        recovery: () => execute('authorizedStorageRecovery'),
        checkpoint: () => execute('authorizedStorageCheckpoint'),
      };
    },
  });
  let closing: Promise<void> | undefined;
  return { close() {
    // Freeze both layers synchronously before waiting on either physical drain.
    return closing ??= Promise.all([control.close(), storage.close()]).then(() => {});
  } };
}
