import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import { createTaskDrain } from '../lifecycle/task-drain.js';
import { readJsonBody } from '../utils/http-body.js';
import { originalJsonEvidenceFromRequest } from './original-json-command-domain.js';
import { sqliteAuthEvidenceFromRequest } from './sqlite-owner-domain.js';
import { validLocalPreferenceOutput, type AcceptedLocalPreference, type LocalPreferenceInput, type LocalPreferenceResult } from './local-preference-domain.js';

export type LocalPreferenceProjection = {
  project(result: AcceptedLocalPreference): void;
  assertAvailable(): void;
};

/** Original standalone HTTP contract. Observation authorization is never a
 * mutation capability: the sole owner checks raw evidence at the file effect. */
export function registerAsyncLocalPreferences(app: Hono, deps: LocalPreferenceProjection & {
  originalJson: boolean;
  change(input: LocalPreferenceInput): Promise<LocalPreferenceResult>;
}) {
  return registerOriginalLocalPreferences(app, { ...deps,
    evidence: deps.originalJson ? originalJsonEvidenceFromRequest : sqliteAuthEvidenceFromRequest });
}

/** Shared original wire/parser, with each parent retaining its OWN evidence
 * extractor and sole writer. A Hub member proof is never standalone evidence. */
export function registerOriginalLocalPreferences<Evidence>(app: Hono, deps: LocalPreferenceProjection & {
  evidence(request: Request): Evidence;
  change(input: Omit<LocalPreferenceInput, 'evidence'> & { evidence: Evidence }): Promise<LocalPreferenceResult>;
}) {
  const { evidence: copyEvidence, change, project, assertAvailable: available } = deps;
  const drain = createTaskDrain();
  let frozen = false;
  const assertAvailable = () => {
    if (frozen) throw new HTTPException(503);
    available();
  };
  const routes = [ ['visibility', 'hidden'], ['archive', 'archived'], ['pin', 'pinned'] ] as const;
  routes.forEach(([route, field], index) => {
    app.patch(`/api/sessions/:sessionKey/${route}`, async c => {
      if (frozen) return c.json({ error: 'Session preference unavailable' }, 503);
      return drain.run(async () => {
        const request = c.req.raw;
        const trace = performanceDiagnostics.start('session-preference-change');
        trace.add('step', index + 1);
        const timer = setTimeout(() => trace.reportPending({ pending: 1 }), 1000);
        timer.unref();
        let submitted = false;
        try {
          assertAvailable();
          // Retain the original credential before body I/O yields. A mutable
          // Request must not replace the authority of an accepted operation.
          const evidence = copyEvidence(request);
          let body: unknown;
          try { body = await readJsonBody(request, 64 * 1024); }
          catch (error) {
            if (error instanceof HTTPException && error.status === 400) body = {};
            else throw error;
          }
          // Original null JSON was not a default-true write either.
          if (body === null) throw new HTTPException(400);
          const enabled = (body as Record<string, unknown>)[field] !== false;
          const key = c.req.param('sessionKey');
          assertAvailable();
          if (request.signal.aborted) throw new HTTPException(408);
          submitted = true;
          const result = await change({ field, key, enabled, evidence });
          if (!validLocalPreferenceOutput(result)) throw new Error('Invalid preference acknowledgement');
          if ('denied' in result) { submitted = false; throw new HTTPException(403); }
          if (result.field !== field || result.key !== key || result.enabled !== enabled) throw new Error('Mismatched preference acknowledgement');
          // Even during shutdown a committed ACK must reach the projection.
          // No retry/rollback on a failed projection, cancellation or lost ACK.
          project(result);
          trace.add('settled', 1);
          return c.json({ ok: true, sessionKey: key, [field]: enabled, updatedAt: Date.now() });
        } catch (error) {
          trace.add(submitted ? 'unknown' : 'deferred', 1);
          if (request.signal.aborted) trace.add('cancelled', 1);
          const status = error instanceof HTTPException ? error.status : 503;
          return Response.json({ error: status === 403 ? 'Session authorization changed' : 'Session preference unavailable' }, { status });
        } finally { clearTimeout(timer); trace.finish(); }
      });
    });
  });
  return { close() { frozen = true; return drain.close(); } };
}
