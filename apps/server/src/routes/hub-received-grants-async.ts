import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AsyncHubReceivedGrants } from '../hub/async-received-grants.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';

export function registerAsyncHubReceivedGrantRoute(app: Hono, port: Pick<AsyncHubReceivedGrants,'received'>) {
  app.get('/api/hub/v1/shared/grants',async c=>{
    c.header('Cache-Control','no-store');
    try {
      // Request authority remains original. No principal/authorized DTO is transported.
      return c.json(await port.received(c.req.raw,c.req.query('after')??'',c.req.query('limit')===undefined?50:Number(c.req.query('limit'))));
    } catch (error) {
      if (error instanceof HubMemberRequestError && error.status !== 503) {
        if (error.status === 499) return new Response(null,{status:499});
        throw new HTTPException(error.status);
      }
      return c.json({error:'Shared permissions are unavailable. Reload to check the saved state before continuing.'},503);
    }
  });
}
