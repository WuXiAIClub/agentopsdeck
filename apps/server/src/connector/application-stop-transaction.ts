import { createHash } from 'node:crypto';
import { validApplicationTransactionEvidence, type ApplicationTransactionBinding, type ApplicationTransactionClient,
  type ApplicationTransactionEvidence, type OriginalTransactionWrite } from '../auth/application-transaction-gate.js';

/** Worker-private original evidence, retained with the exact control binding.
 * Ready cannot downgrade the claim to transport-token-only authority. Only
 * synchronous original SQL/local checks may run inside either physical fence;
 * native interrupt and ACK settlement stay outside this authorization lane. */
export function applicationControlTransaction(runtime: ApplicationTransactionBinding['runtime'],
  input: { key: string; commandKey: string; payloadJson: string; application?: ApplicationTransactionEvidence },
  client?: ApplicationTransactionClient): { claim: OriginalTransactionWrite; ready: OriginalTransactionWrite } | undefined {
  if (!Object.hasOwn(input, 'application')) return undefined;
  if (!client || !validApplicationTransactionEvidence(input.application)) throw Error('application_transaction_unavailable');
  const evidence = Object.freeze(structuredClone(input.application));
  const binding = { runtime, resource: input.key, commandKey: input.commandKey,
    payloadDigest: createHash('sha256').update(input.payloadJson).digest('hex'), evidence };
  return Object.freeze({
    claim: <T>(write: () => T) => client.run({ ...binding, phase: 'control-claim' }, write),
    ready: <T>(write: () => T) => client.run({ ...binding, phase: 'control-ready' }, write),
  });
}

// Existing stop owners keep the same contract and private retained Ready hook.
export const applicationStopTransaction = applicationControlTransaction;
