import { createHash } from 'node:crypto';
import type { ApplicationTransactionClient, ApplicationTransactionEvidence } from '../auth/application-transaction-gate.js';
import { applicationControlTransaction } from './application-stop-transaction.js';

type Runtime = 'codex' | 'claude-code' | 'ghcp';
type Operation = 'start' | 'step' | 'cancel';
type Input = { key: string; jobId?: string; step?: number; application?: ApplicationTransactionEvidence };
const payload = (operation: Operation, input: Input) => JSON.stringify({ operation,
  ...(input.jobId === undefined ? {} : { jobId: input.jobId }), ...(input.step === undefined ? {} : { step: input.step }) });
/** Exact application scope DTO. The original body is private worker input,
 * never extra authority fields added to the application intent. */
export function applicationFilesIntent(runtime: Runtime, operation: Operation, input: Input) {
  const payloadDigest = createHash('sha256').update(payload(operation, input)).digest('hex');
  return { action: 'files' as const, runtime, resource: input.key, commandKey: `files-${payloadDigest}`, payloadDigest };
}
/** Original complete bounded state machine executes only inside the original
 * identity's current Auth fence. No scan or external effect is introduced. */
export function applicationFilesTransaction<T>(kind: string, runtime: Runtime, input: Input,
  client: ApplicationTransactionClient | undefined, execute: () => T): T | Promise<T> {
  if (kind.endsWith('Page') || kind.endsWith('Deliver')) return execute();
  const operation: Operation = kind.endsWith('Start') ? 'start' : kind.endsWith('Step') ? 'step' : 'cancel';
  const intent = applicationFilesIntent(runtime, operation, input);
  const control = applicationControlTransaction(runtime, { key: input.key, commandKey: intent.commandKey,
    payloadJson: payload(operation, input), ...(Object.hasOwn(input, 'application') ? { application: input.application } : {}) }, client);
  return control ? control.ready(execute) : execute();
}
