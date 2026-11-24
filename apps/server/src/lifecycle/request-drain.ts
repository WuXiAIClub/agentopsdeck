import type { Hono, MiddlewareHandler } from 'hono';

export type AdmissionPause = { drained: Promise<void>; resume: () => boolean };

// Transport admission only. An aborted client does not end its handler. Keep
// stores alive until the handler exits, including its catch/finally writes.
// Streaming response bodies and native/queue workers have their own owners;
// this barrier is not evidence of native quiescence or data compatibility.
export function registerRequestDrain(app: Hono, options: {
  isControl?: (request: Request) => boolean;
  writesOnRead?: boolean;
} = {}) {
  let active = 0;
  let writers = 0;
  let pause: AdmissionPause | undefined;
  let finishWriters: (() => void) | undefined;
  let drained: Promise<void> | undefined;
  let finish: (() => void) | undefined;
  const admission: MiddlewareHandler = async (c, next) => {
    if (drained) {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'server_draining' }, 503);
    }
    const writer = (options.writesOnRead || !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method))
      && !options.isControl?.(c.req.raw);
    if (pause && writer) {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'connector_maintenance' }, 503);
    }
    active++;
    if (writer) writers++;
    try { await next(); }
    finally {
      if (writer && --writers === 0) finishWriters?.();
      if (--active === 0) finish?.();
    }
  };
  const register = (target: Hono) => { target.use('*', admission); };
  register(app);
  const close = () => drained ??= new Promise<void>(resolve => {
    finish = resolve;
    if (active === 0) resolve();
  });
  return Object.assign(close, {
    register,
    isStopping: () => drained !== undefined,
    activeWrites: () => writers,
    isPaused: () => pause !== undefined,
    pauseWrites: (): AdmissionPause => {
      if (pause) return pause;
      let settled = false;
      const pending = new Promise<void>(resolve => {
        finishWriters = () => { settled = true; resolve(); };
        if (writers === 0) finishWriters();
      });
      const lease: AdmissionPause = {
        drained: pending,
        resume: () => {
          if (pause !== lease || !settled || drained) return false;
          pause = undefined;
          finishWriters = undefined;
          return true;
        },
      };
      pause = lease;
      return lease;
    },
  });
}
