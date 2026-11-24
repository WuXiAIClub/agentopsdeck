import { createTaskDrain } from '../lifecycle/task-drain.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { connectorMaintenanceSteps, validConnectorMaintenanceInput, validConnectorMaintenanceOutput,
  type ConnectorMaintenanceCommands, type ConnectorMaintenanceKind } from './connector-maintenance-domain.js';
import { checkMaintenanceLocal } from './maintenance-local-guard.js';

export type RuntimeMaintenanceCommandPort = { command<K extends ConnectorMaintenanceKind>(kind: K,
  input: ConnectorMaintenanceCommands[K]['input'], check?: () => void):
  ConnectorMaintenanceCommands[K]['output'] | Promise<ConnectorMaintenanceCommands[K]['output']> };
const unavailable = () => Error('Maintenance persistence unavailable; no idle proof');

/** Same consumer for original and worker owners. Never owns/closes the shared
 * database. Lifecycle shutdown must drain this before closing that owner. */
export class RuntimeMaintenancePersistence {
  private readonly tasks = createTaskDrain();
  constructor(private readonly commands: RuntimeMaintenanceCommandPort, private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {}
  command<K extends ConnectorMaintenanceKind>(kind: K, input: ConnectorMaintenanceCommands[K]['input'], check: () => void):
    Promise<ConnectorMaintenanceCommands[K]['output']> {
    // Freeze caller data before yielding; callbacks cannot mutate the queued command.
    if (!validConnectorMaintenanceInput(kind, input)) return Promise.reject(unavailable());
    const original = structuredClone(input);
    return this.tasks.run(async () => {
      const trace = guardedTrace(this.diagnostics, 'connector-sqlite-command');
      trace.add('step', connectorMaintenanceSteps[kind]);
      let failed = true;
      try {
        checkMaintenanceLocal(check);
        const value = await this.commands.command(kind, original, check);
        checkMaintenanceLocal(check);
        if (!validConnectorMaintenanceOutput(kind, value)
          || kind === 'runtimeMaintenancePreservation' && (value as { sessionKey: string }).sessionKey !== (original as { key: string }).key)
          throw unavailable();
        failed = false; return value;
      } catch { throw unavailable(); }
      finally { trace.finish(failed); }
    });
  }
  close(): Promise<void> { return this.tasks.close(); }
}
