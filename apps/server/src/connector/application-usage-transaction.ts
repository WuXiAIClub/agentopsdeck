import { createHash } from 'node:crypto';
import type { ApplicationTransactionClient, ApplicationTransactionEvidence } from '../auth/application-transaction-gate.js';
import { applicationControlTransaction } from './application-stop-transaction.js';

type Runtime = 'codex' | 'claude-code' | 'ghcp' | 'antigravity';
type Selection = { key: string; requestId: string; from: number; to: number; bucketMs: number; application?: ApplicationTransactionEvidence };
const payload = (input: Selection) => JSON.stringify({ requestId: input.requestId, from: input.from, to: input.to, bucketMs: input.bucketMs });
export function applicationUsageIntent(runtime: Runtime, input: Selection) {
  const payloadDigest = createHash('sha256').update(payload(input)).digest('hex');
  return { action: 'usage' as const, runtime, resource: input.key, commandKey: `usage-${payloadDigest}`, payloadDigest };
}
/** This fence is passed into the original ledger's post-capacity synchronous
 * commit. Never wrap the async capacity wait in an Auth transaction. */
export function applicationUsageCommit(runtime: Runtime, input: Selection, client?: ApplicationTransactionClient) {
  const intent = applicationUsageIntent(runtime, input);
  return applicationControlTransaction(runtime, { key: input.key, commandKey: intent.commandKey,
    payloadJson: payload(input), ...(Object.hasOwn(input, 'application') ? { application: input.application } : {}) }, client)?.ready;
}
