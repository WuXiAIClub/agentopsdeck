import type { ChatMessage } from '@agentopsdeck/shared';
import type { HermesHistorySnapshot, HermesHistoryPage, HermesHistoryPart } from '../hermes/journal.js';
import type { HermesHistoryRow } from '../hermes/history.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { validHermesHistoryRows } from './connector-hermes-execution-domain.js';

type Fence = { key: string; digest: string };
export type ConnectorHermesHistoryCommands = {
  hermesHistorySnapshot: { input: { key: string }; output: HermesHistorySnapshot | null };
  hermesHistoryAttach: { input: Fence & { stored: string }; output: HermesHistorySnapshot | null };
  hermesHistoryCommit: { input: Fence & { rows: HermesHistoryRow[] }; output: HermesHistorySnapshot | null };
  hermesHistoryProjection: { input: Fence & { offset: number; limit: number }; output: HermesHistoryPage | null };
  hermesHistoryMessagePart: { input: Fence & { index: number; offset: number }; output: HermesHistoryPart | null };
};
export type ConnectorHermesHistoryKind = keyof ConnectorHermesHistoryCommands;
export const connectorHermesHistorySteps = Object.freeze({ hermesHistorySnapshot: 155, hermesHistoryAttach: 156,
  hermesHistoryCommit: 157, hermesHistoryProjection: 158, hermesHistoryMessagePart: 159 });
export const isConnectorHermesHistoryKind = (kind: string): kind is ConnectorHermesHistoryKind => Object.hasOwn(connectorHermesHistorySteps, kind);
const fields = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object'
  && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const id = (v: unknown, max = 512): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= max && !/[\x00-\x1f\x7f]/.test(v);
const key = (v: unknown): v is string => id(v) && v.startsWith('hermes:') && v.length > 7;
const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
export function validHermesHistorySnapshot(v: unknown): v is HermesHistorySnapshot {
  const allocated = !!v && typeof v === 'object' && Object.hasOwn(v, 'nativeAllocated');
  return fields(v, ['key', 'digest', 'stored', 'title', 'started', 'unknown', ...(allocated ? ['nativeAllocated'] : [])])
    && (!allocated || v.nativeAllocated === true) && key(v.key) && digest(v.digest)
    && id(v.stored, 1024) && typeof v.title === 'string' && v.title.length <= 120 && !/[\x00-\x1f\x7f]/.test(v.title)
    && typeof v.started === 'boolean' && typeof v.unknown === 'boolean';
}
export function validHermesHistoryMessage(v: unknown, sessionKey: unknown): v is ChatMessage {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const m = v as Record<string, unknown>;
  return m.sessionKey === sessionKey && typeof m.id === 'string' && !!m.id && typeof m.text === 'string'
    && ['user', 'assistant', 'system', 'tool'].includes(String(m.role)) && typeof m.createdAt === 'number' && Number.isFinite(m.createdAt);
}
export function validConnectorHermesHistoryInput(kind: ConnectorHermesHistoryKind, v: unknown): boolean {
  if (kind === 'hermesHistorySnapshot') return fields(v, ['key']) && key(v.key);
  const extra = kind === 'hermesHistoryAttach' ? ['stored'] : kind === 'hermesHistoryCommit' ? ['rows']
    : kind === 'hermesHistoryMessagePart' ? ['index', 'offset'] : ['offset', 'limit'];
  return fields(v, ['key', 'digest', ...extra]) && key(v.key) && digest(v.digest)
    && (kind === 'hermesHistoryAttach' ? id(v.stored, 1024) : kind === 'hermesHistoryCommit' ? validHermesHistoryRows(v.rows)
      : kind === 'hermesHistoryMessagePart' ? count(v.index) && count(v.offset) && v.offset < 64 * 1024 * 1024
      : count(v.offset) && count(v.limit) && v.limit >= 1 && v.limit <= 64);
}
export function validConnectorHermesHistoryOutput(kind: ConnectorHermesHistoryKind, v: unknown): boolean {
  if (v === null) return true;
  if (kind === 'hermesHistoryMessagePart') return fields(v, ['key', 'digest', 'index', 'offset', 'data', 'total', 'next'])
    && key(v.key) && digest(v.digest) && count(v.index) && count(v.offset) && count(v.total)
    && v.total > 512 * 1024 && v.total <= 64 * 1024 * 1024 && v.offset < v.total
    && typeof v.data === 'string' && v.data.length > 0 && v.data.length <= 4 * Math.ceil(262144 / 3)
    && Buffer.from(v.data, 'base64').toString('base64') === v.data && Buffer.from(v.data, 'base64').length <= 262144
    && (v.next === null || count(v.next));
  if (kind !== 'hermesHistoryProjection') return validHermesHistorySnapshot(v);
  return fields(v, ['key', 'digest', 'messages', 'large', 'next']) && key(v.key) && digest(v.digest)
    && Array.isArray(v.messages) && v.messages.length <= 64 && v.messages.every(m => validHermesHistoryMessage(m, v.key))
    && (v.large === null || fields(v.large, ['index', 'bytes']) && count(v.large.index) && count(v.large.bytes)
      && v.large.bytes > 512 * 1024 && v.large.bytes <= 64 * 1024 * 1024)
    && (v.next === null || count(v.next));
}
export function connectorHermesHistoryReplyMatches(kind: ConnectorHermesHistoryKind,
  input: ConnectorHermesHistoryCommands[ConnectorHermesHistoryKind]['input'], value: unknown): boolean {
  if (value === null) return true;
  const v = value as HermesHistorySnapshot & HermesHistoryPage & HermesHistoryPart;
  if (v.key !== input.key) return false;
  if (kind === 'hermesHistoryAttach') return v.stored === (input as ConnectorHermesHistoryCommands['hermesHistoryAttach']['input']).stored && v.unknown === false;
  if (kind === 'hermesHistoryMessagePart') {
    const part = input as ConnectorHermesHistoryCommands['hermesHistoryMessagePart']['input'];
    const end = part.offset + Buffer.from(v.data, 'base64').length;
    return v.digest === part.digest && v.index === part.index && v.offset === part.offset && end <= v.total
      && (v.next === null ? end === v.total : end < v.total && v.next === end);
  }
  if (kind !== 'hermesHistoryProjection') return true;
  const page = input as ConnectorHermesHistoryCommands['hermesHistoryProjection']['input'];
  const consumed = v.messages.length + (v.large ? 1 : 0);
  return v.digest === page.digest && consumed <= page.limit
    && (!v.large || v.large.index === page.offset + v.messages.length)
    && (v.next === null || consumed > 0 && v.next === page.offset + consumed);
}
/** Internal original-native evidence only, never public authorization or a
 * general store mutation. The owner recomputes row bindings and projection. */
export function executeConnectorHermesHistory<K extends ConnectorHermesHistoryKind>(kind: K,
  input: ConnectorHermesHistoryCommands[K]['input'], owner: Pick<ConnectorUserStore, 'hermesJournal'>): ConnectorHermesHistoryCommands[K]['output'] {
  if (!validConnectorHermesHistoryInput(kind, input)) throw Error('connector_storage_unavailable');
  const v = input as ConnectorHermesHistoryCommands['hermesHistoryAttach']['input']
    & ConnectorHermesHistoryCommands['hermesHistoryCommit']['input'] & ConnectorHermesHistoryCommands['hermesHistoryProjection']['input']
    & ConnectorHermesHistoryCommands['hermesHistoryMessagePart']['input'];
  const journal = owner.hermesJournal;
  const result = kind === 'hermesHistorySnapshot' ? journal.historySnapshot(v.key)
    : kind === 'hermesHistoryAttach' ? journal.attachSnapshot(v.key, v.digest, v.stored)
    : kind === 'hermesHistoryCommit' ? journal.commitHistory(v.key, v.digest, v.rows)
    : kind === 'hermesHistoryMessagePart' ? journal.historyMessagePart(v.key, v.digest, v.index, v.offset)
    : journal.historyProjection(v.key, v.digest, v.offset, v.limit);
  if (!validConnectorHermesHistoryOutput(kind, result) || !connectorHermesHistoryReplyMatches(kind, input, result)) throw Error('connector_storage_unavailable');
  return result as ConnectorHermesHistoryCommands[K]['output'];
}
