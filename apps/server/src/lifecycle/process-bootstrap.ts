import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ProcessLifetime } from './process-lifetime.js';

export type ProcessListener = { readonly listening: boolean;
  on: (event: 'error', listener: () => void) => unknown;
  removeListener: (event: 'error', listener: () => void) => unknown;
  close: (callback: (error?: Error) => void) => unknown; closeIdleConnections?: () => void };
export type ProcessCloseOwner = { close: () => void | Promise<void>; canRetry?: () => boolean };
export type ProcessBootstrapOptions<Config, Application> = {
  loadConfig: () => Config; createApplication: (config: Config) => Application;
  applicationOwner: (application: Application) => ProcessCloseOwner;
  mainListener: (application: Application, config: Config) => ProcessListener;
  websiteListener: (application: Application, config: Config) => ProcessListener | undefined;
  websiteSockets: (listener: ProcessListener, application: Application) => ProcessCloseOwner;
  failedApplicationOwner: ProcessCloseOwner;
  onClosed: (exitCode: number) => void; onFailure?: () => void;
  diagnostics?: PerformanceDiagnostics; warningMs?: number; retryMs?: number; keepAlive?: boolean;
};

/** Factories are called once, in order. Every returned resource is registered
 * before the next constructor; a later synchronous failure retains and closes
 * the partial assembly, without replaying startup or exposing raw errors. */
export function bootstrapProcess<Config, Application>(options: ProcessBootstrapOptions<Config, Application>) {
  const diagnostics = options.diagnostics ?? performanceDiagnostics;
  const lifetime = new ProcessLifetime({ ...options, diagnostics });
  lifetime.own(options.failedApplicationOwner.close, options.failedApplicationOwner.canRetry);
  const observeFailure = (step: number) => {
    const trace = diagnostics.start('process-startup'); trace.add('step', step); trace.add('unknown', 1); trace.finish(true);
  };
  const registerListener = (listener: ProcessListener, step: number) => {
    const failed = () => { observeFailure(step); void lifetime.shutdown(1); };
    lifetime.own(() => new Promise<void>((resolve, reject) => {
      // close() invalidates an in-flight listen, too. A not-running callback is
      // an ACK only when this same listener is no longer listening.
      listener.close(error => {
        if (error && !((error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING' && !listener.listening)) {
          reject(error); return;
        }
        listener.removeListener('error', failed); resolve();
      });
      try { listener.closeIdleConnections?.(); } catch {
        // Optional idle pruning is not the close ACK; keep waiting for it.
        const trace = diagnostics.start('process-shutdown-owner'); trace.add('step', step); trace.add('unknown', 1); trace.finish(true);
      }
    }), () => true); // Same native close only: never listen(), replace, or admit.
    listener.on('error', failed); // Retain handler until the close ACK, not once.
  };
  let step = 1;
  try {
    const config = options.loadConfig(); step = 2;
    const application = options.createApplication(config);
    const owner = options.applicationOwner(application); lifetime.own(owner.close, owner.canRetry); step = 3;
    registerListener(options.mainListener(application, config), step); step = 4;
    const website = options.websiteListener(application, config);
    if (website) {
      registerListener(website, step); step = 5;
      const sockets = options.websiteSockets(website, application); lifetime.own(sockets.close, sockets.canRetry);
    }
  } catch { observeFailure(step); void lifetime.shutdown(1); }
  return lifetime;
}
