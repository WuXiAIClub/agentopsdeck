import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER, acceptsConnectorProtocolHeader } from '@agentopsdeck/shared';
import type { Hono } from 'hono';
import { EXPECTED_NODE_HEADER, NODE_ID_HEADER } from './node-identity.js';

/** Register before feature routes in both composition roots. Installation
 * identity is obtained from the already-open owner, not a second SQL store. */
export function registerConnectorProtocol(app: Hono, base: string, nodeId: string) {
  app.use(`${base}/*`, async (c, next) => {
    c.header(NODE_ID_HEADER, nodeId);
    c.header(CONNECTOR_PROTOCOL_HEADER, String(CONNECTOR_PROTOCOL.max));
    if (!acceptsConnectorProtocolHeader(c.req.header(CONNECTOR_PROTOCOL_HEADER))) {
      return c.json({ error: 'Incompatible Connector protocol', supported: CONNECTOR_PROTOCOL }, 426);
    }
    const expected = c.req.header(EXPECTED_NODE_HEADER);
    if (expected !== undefined && expected !== nodeId) return c.json({ error: 'Connector identity mismatch' }, 409);
    await next();
    // Raw streaming responses do not inherit Hono's prepared headers.
    c.header(NODE_ID_HEADER, nodeId);
    c.header(CONNECTOR_PROTOCOL_HEADER, String(CONNECTOR_PROTOCOL.max));
  });
}
