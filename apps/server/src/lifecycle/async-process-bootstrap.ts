import { performanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { ProcessLifetime } from './process-lifetime.js';
import type { ProcessBootstrapOptions, ProcessCloseOwner, ProcessListener } from './process-bootstrap.js';

export type AsyncProcessBootstrapOptions<Config, Application> =
  Omit<ProcessBootstrapOptions<Config, Application>, 'createApplication'> & {
    /** A rejected factory must retain its partial resources through
     * failedApplicationOwner, just like the original synchronous factory. */
    createApplication: (config: Config) => Application | Promise<Application>;
  };

/** Production startup may now await original owner readiness before admitting
 * requests. This does NOT make synchronous database constructors asynchronous.
 * All shutdown slots are registered before invoking any factory. A signal
 * during construction fences listener creation, waits the ORIGINAL factory,
 * then drains its exact returned/partial resources. Never replay startup,
 * release a lock on a timeout, or treat an unresolved factory as closed.
 * ready describes assembly, not native listen() or business acceptance. */
export function bootstrapAsyncProcess<Config, Application>(options: AsyncProcessBootstrapOptions<Config, Application>) {
  const diagnostics = options.diagnostics ?? performanceDiagnostics;
  const lifetime = new ProcessLifetime({ ...options, diagnostics });
  let stopped = false, assemblyComplete = false, step = 1;
  let applicationOwner: ProcessCloseOwner | undefined;
  let mainOwner: ProcessCloseOwner | undefined;
  let websiteOwner: ProcessCloseOwner | undefined;
  let socketsOwner: ProcessCloseOwner | undefined;
  let settleAssembly!: () => void;
  const assemblySettled = new Promise<void>(resolve => { settleAssembly = resolve; });
  const retain = (owner: () => ProcessCloseOwner | undefined) => {
    lifetime.own(() => {
      stopped = true; // Synchronous fence, before waiting for the original factory.
      // Once assembly is complete, preserve the original synchronous ingress
      // fence. Only a genuinely pending constructor needs the readiness wait.
      return assemblyComplete ? owner()?.close() : assemblySettled.then(() => owner()?.close());
    }, () => owner()?.canRetry?.() === true);
  };
  // Reverse shutdown invocation order remains sockets/listeners/app/partials.
  // In particular, partial cleanup cannot ACK an empty registry before a late
  // factory rejection registers its original resources in that registry.
  retain(() => options.failedApplicationOwner);
  retain(() => applicationOwner);
  retain(() => mainOwner);
  retain(() => websiteOwner);
  retain(() => socketsOwner);
  const observeFailure = (failedStep: number) => {
    const trace = guardedTrace(diagnostics, 'process-startup');
    trace.add('step', failedStep); trace.add('unknown', 1); trace.finish(true);
  };
  const retainListener = (listener: ProcessListener, listenerStep: number,
    remember: (owner: ProcessCloseOwner) => void) => {
    const failed = () => { observeFailure(listenerStep); void lifetime.shutdown(1); };
    remember({ close: () => new Promise<void>((resolve, reject) => {
      listener.close(error => {
        if (error && !((error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING' && !listener.listening)) {
          reject(error); return;
        }
        try { listener.removeListener('error', failed); resolve(); } catch (error) { reject(error); }
      });
      try { listener.closeIdleConnections?.(); } catch {
        const trace = guardedTrace(diagnostics, 'process-shutdown-owner');
        trace.add('step', listenerStep); trace.add('unknown', 1); trace.finish(true);
      }
    }), canRetry: () => true });
    // Retain close BEFORE invoking even the listener's registration hook.
    listener.on('error', failed);
  };
  // Defer factories until the caller can install its SIGINT/SIGTERM handlers.
  const ready = Promise.resolve().then(async () => {
    const trace = guardedTrace(diagnostics, 'process-startup');
    const warning = setInterval(() => trace.reportPending({ step, pending: 1 }), options.warningMs ?? 30_000);
    if (options.keepAlive === false) warning.unref();
    try {
      if (stopped) { trace.add('cancelled', 1); return false; }
      const config = options.loadConfig(); step = 2;
      if (stopped) { trace.add('cancelled', 1); return false; }
      const application = await options.createApplication(config);
      // Even if shutdown began while awaiting, ownership must transfer first.
      applicationOwner = options.applicationOwner(application); step = 3;
      if (stopped) { trace.add('cancelled', 1); return false; }
      retainListener(options.mainListener(application, config), step, owner => { mainOwner = owner; }); step = 4;
      if (stopped) { trace.add('cancelled', 1); return false; }
      const website = options.websiteListener(application, config);
      if (website) {
        retainListener(website, step, owner => { websiteOwner = owner; }); step = 5;
        if (stopped) { trace.add('cancelled', 1); return false; }
        socketsOwner = options.websiteSockets(website, application);
      }
      if (stopped) { trace.add('cancelled', 1); return false; }
      trace.add('settled', 1);
      return true;
    } catch {
      trace.add('step', step); trace.add('unknown', 1);
      void lifetime.shutdown(1); // Do not await our own assembly barrier.
      return false;
    } finally {
      clearInterval(warning);
      assemblyComplete = true;
      trace.finish(lifetime.snapshot().exitCode !== 0);
      settleAssembly();
    }
  });
  return { lifetime, ready };
}
