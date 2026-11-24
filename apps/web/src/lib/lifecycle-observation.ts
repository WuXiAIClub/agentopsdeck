import type { ConnectorLifecycleJob, ConnectorLifecycleReceipt, ConnectorLifecycleStatus } from '@agentopsdeck/shared';
import type { LifecycleTarget } from './command-recovery.js';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const operation = (value: unknown) => value === 'restart' || value === 'upgrade';
const stages = new Set(['prepare', 'drain', 'fence', 'recheck', 'unfence', 'stop', 'stopped', 'backup', 'activate', 'start', 'ready', 'release', 'succeeded', 'attention', 'cancelled']);
const reasons = new Set(['deadline', 'interrupted', 'invalid_evidence', 'operation_failed', 'authorization_changed']);

function validJob(value: unknown): value is ConnectorLifecycleJob {
  return object(value) && identifier(value.id) && identifier(value.nodeId) && operation(value.operation)
    && typeof value.stage === 'string' && stages.has(value.stage) && natural(value.createdAt)
    && natural(value.deadline) && value.deadline > value.createdAt && natural(value.revision)
    && (value.reason === undefined || typeof value.reason === 'string' && reasons.has(value.reason));
}

export function readLifecycleStatus(value: unknown): ConnectorLifecycleStatus {
  if (!object(value)) throw new Error('Invalid maintenance status');
  if (value.configured === false) return { configured: false };
  if (value.configured !== true || !identifier(value.nodeId) || !Array.isArray(value.operations)
    || !value.operations.length || value.operations.length > 2 || !value.operations.every(operation) || new Set(value.operations).size !== value.operations.length
    || typeof value.blocked !== 'boolean' || value.automaticUpdates !== false
    || !['running', 'halted', 'stopping'].includes(value.workerState as string)
    || value.job !== undefined && (!validJob(value.job) || value.job.nodeId !== value.nodeId || !value.blocked)) throw new Error('Invalid maintenance status');
  return value as ConnectorLifecycleStatus;
}

export function readLifecycleReceipt(value: unknown, key: string, target: LifecycleTarget): ConnectorLifecycleReceipt {
  if (!object(value) || !object(value.command)) throw new Error('Original receipt unavailable');
  const command = value.command;
  if (command.key !== key || !identifier(command.id) || !['accepted', 'outcome_unknown', 'rejected'].includes(command.state as string)
    || !natural(command.createdAt) || !natural(command.updatedAt) || command.updatedAt < command.createdAt
    || typeof value.observationUnavailable !== 'boolean') throw new Error('Original receipt unavailable');
  // Admission proof is immutable. Never treat its embedded job as current progress.
  const admitted = object(command.result) && command.result.status === 202 && object(command.result.body)
    ? command.result.body.lifecycle : undefined;
  if (command.state === 'accepted' && (!validJob(admitted) || admitted.operation !== target.operation)) throw new Error('Original receipt unavailable');
  if (value.job !== undefined && (!validJob(value.job) || value.job.operation !== target.operation
    || command.state !== 'accepted' || !validJob(admitted) || admitted.id !== value.job.id
    || admitted.nodeId !== value.job.nodeId || admitted.createdAt !== value.job.createdAt || admitted.deadline !== value.job.deadline
    || admitted.revision > value.job.revision)) throw new Error('Original receipt unavailable');
  if (value.observationUnavailable !== (value.job === undefined)) throw new Error('Original receipt unavailable');
  return value as ConnectorLifecycleReceipt;
}

/** A lost observation must not erase the last known stage. It is labelled stale;
 * only a fresh terminal observation permits dismissal. */
export function mergeLifecycleObservation(previous: ConnectorLifecycleReceipt | undefined, next: ConnectorLifecycleReceipt): ConnectorLifecycleReceipt {
  if (previous && (previous.command.id !== next.command.id || previous.command.key !== next.command.key
    || previous.command.createdAt !== next.command.createdAt)) throw new Error('Original receipt unavailable');
  if (!previous?.job) return next;
  if (!next.job) return { ...previous, observationUnavailable: true };
  if (previous.job.id !== next.job.id || previous.job.nodeId !== next.job.nodeId
    || previous.job.operation !== next.job.operation || previous.job.createdAt !== next.job.createdAt
    || previous.job.deadline !== next.job.deadline || previous.job.revision > next.job.revision) throw new Error('Original receipt unavailable');
  if (previous.job.revision === next.job.revision && (previous.job.stage !== next.job.stage
    || previous.job.reason !== next.job.reason)) throw new Error('Original receipt unavailable');
  return next;
}

/** Failed/unavailable reads back off to one minute; successful progress resets it. */
export function lifecyclePollDelay(failures: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.min(4, Math.max(0, failures)));
}
