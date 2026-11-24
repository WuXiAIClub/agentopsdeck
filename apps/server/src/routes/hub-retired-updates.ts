import type { Hono } from 'hono';

/** Keep the old wire rejection, never translate uncertain legacy writes into
 * commands with a newly invented receipt. The parent owns authentication. */
export function registerRetiredHubUpdates(app: Hono) {
  for (const operation of ['apply', 'rollback']) {
    app.post(`/api/hub/v1/connections/:connectionId/update/${operation}`, c => {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'Legacy update writes retired; reload the client. Uncertain earlier updates must be reconciled, not resent.' }, 410);
    });
  }
}
