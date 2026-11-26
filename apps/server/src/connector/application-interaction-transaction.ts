import { createHash } from 'node:crypto';
import type { ApplicationTransactionClient, ApplicationTransactionEvidence } from '../auth/application-transaction-gate.js';
import { applicationControlTransaction } from './application-stop-transaction.js';

type Runtime = 'codex' | 'claude-code' | 'ghcp' | 'antigravity';
export type ApplicationInteractionInput = { key: string; mode?: string; requestId?: string; submission?: unknown };
const payload = (input: ApplicationInteractionInput) => JSON.stringify(input.mode === undefined
  ? { requestId: input.requestId, submission: input.submission } : { mode: input.mode });
/** Same original body semantics at the application scope and physical SQL gate.
 * Native bindings and transport credentials are deliberately not payload. */
export function applicationInteractionIntent(runtime: Runtime, input: ApplicationInteractionInput) {
  const payloadJson = payload(input);
  const payloadDigest = createHash('sha256').update(payloadJson).digest('hex');
  return { action: 'interaction' as const, runtime, resource: input.key, commandKey: `interaction-${payloadDigest}`, payloadDigest };
}
type Bound = { sessionKey?: string; commandId?: string; connectionId?: string; bindingId: string; runId?: string;
  ref?: { key: string; id: string; epoch: string; nativeSessionId: string } };
type Input = ApplicationInteractionInput & Partial<Bound> & { runtime?: Runtime; application?: ApplicationTransactionEvidence;
  binding?: Bound };
type Control = NonNullable<ReturnType<typeof applicationControlTransaction>>;

/** Worker-private continuation of the ORIGINAL application identity. The sync
 * domains remain the sole SQL kernels. Nothing here grants native execution. */
export function createApplicationInteractionTransactions(client?: ApplicationTransactionClient) {
  const retained = new Map<string, { control: Control; bindingId: string; runId: string }>();
  let disposed = false;
  const identity = (runtime: Runtime, bound: Bound, requestId: string) => JSON.stringify([runtime, bound.bindingId,
    bound.ref ? [bound.ref.key, bound.ref.id, bound.ref.epoch, bound.ref.nativeSessionId]
      : [bound.sessionKey, bound.commandId, bound.connectionId, bound.runId], requestId]);
  return {
    async run<T>(kind: string, runtime: Runtime, raw: unknown, execute: () => T): Promise<T> {
      const input = raw as Input;
      const original = () => { if (disposed) throw Error('application_transaction_unavailable'); return execute(); };
      if (kind.endsWith('Mode')) {
        const intent = applicationInteractionIntent(runtime, input);
        const control = applicationControlTransaction(runtime, { key: input.key, commandKey: intent.commandKey,
          payloadJson: payload(input), ...(Object.hasOwn(input, 'application') ? { application: input.application } : {}) }, client);
        return control ? control.ready(original) : original();
      }
      if (kind.endsWith('Answer') && input.binding) {
        const id = identity(runtime, input.binding, input.requestId!);
        let record = retained.get(id);
        if (!record && Object.hasOwn(input, 'application')) {
          if (retained.size >= 128) throw Error('application_transaction_capacity');
          const intent = applicationInteractionIntent(runtime, input);
          const control = applicationControlTransaction(runtime, { key: input.key, commandKey: intent.commandKey,
            payloadJson: payload(input), application: input.application! }, client)!;
          record = { control, bindingId: input.binding.bindingId, runId: input.binding.runId ?? input.binding.ref!.id };
          // Reserve before awaiting Auth: concurrent commands may not replace
          // the original identity, or bypass it by omitting application evidence.
          retained.set(id, record);
        }
        return record ? record.control.claim(original) : original();
      }
      if (kind.endsWith('Claim') || kind.endsWith('Deliverable')) {
        const record = retained.get(identity(runtime, input as Bound, input.requestId!));
        return record ? record.control.ready(original) : original();
      }
      // No new authorization at Settle: an original ACK remains a fact after
      // logout. Cleanup is only after original SQL succeeds, not on a waiter.
      const result = original();
      if ((result as { ok?: boolean })?.ok === true && (kind.endsWith('Settle') || kind.endsWith('Close') || kind.endsWith('Retire') || kind.endsWith('Release'))) {
        if (kind.endsWith('Settle') || kind.endsWith('Close') && input.requestId) retained.delete(identity(runtime, input as Bound, input.requestId!));
        else for (const [id, record] of retained) if (record.bindingId === input.bindingId
          && (kind.endsWith('Release') || record.runId === (input.runId ?? input.ref?.id))) retained.delete(id);
      }
      return result;
    },
    dispose() { disposed = true; retained.clear(); },
  };
}
