import type { SessionsState } from '@agentopsdeck/shared';
import { createLatestRequestGate, createMessageSnapshotGate } from './refresh-control.js';

export type SessionSourceState = {
  connectionId: string;
  authority: number;
  state: 'ready' | 'denied' | 'unavailable' | 'disabled' | 'changed';
  cursor?: string;
  hiddenCount: number;
  archivedCount: number;
  pinnedCount: number;
};
export type SessionListSnapshot = SessionsState & {
  sources?: Array<{ connectionId: string; cursor: string }>;
  sourceStates?: SessionSourceState[];
  viewKey?: string;
};

// A transport/read failure is not a revocation signal for an independently
// authorized detail GET. Explicit denial, removal and authority changes are.
export function invalidatedSessionNodes(previous: SessionSourceState[] | undefined, next: SessionSourceState[] | undefined, selectedKey?: string) {
  const invalid = new Set<string>();
  if (!next) return invalid; // Legacy Hub supplies no directory proof.
  const before = new Map(previous?.map(source => [source.connectionId, source]));
  const after = new Map(next.map(source => [source.connectionId, source]));
  const known = new Set(before.keys());
  if (selectedKey?.includes(':')) known.add(selectedKey.slice(0, selectedKey.indexOf(':')));
  for (const id of known) if (!after.has(id)) invalid.add(id);
  for (const source of next) {
    const prior = before.get(source.connectionId);
    if (['denied', 'disabled', 'changed'].includes(source.state) || (prior && prior.authority !== source.authority)) invalid.add(source.connectionId);
  }
  return invalid;
}

type NodeSnapshot = {
  source: SessionSourceState;
  groups: SessionListSnapshot['groups'];
  gate: ReturnType<typeof createMessageSnapshotGate>;
};

// Only the current directory's last accepted node slices; no event bodies,
// history of snapshots, extra requests or timers. One node cannot roll another
// back. A transient read failure may retain display rows under the same
// authority/view, but never supplies a current cursor or execution proof.
export function createSessionSnapshotGate(getScope: () => unknown = () => undefined) {
  const requests = createLatestRequestGate(getScope);
  let nodes = new Map<string, NodeSnapshot>();
  let scope: unknown;
  let view: string | undefined;
  let canonical = false;
  let refresh: (() => void) | undefined;
  const invalidate = (connectionId?: string) => {
    requests.invalidate();
    if (connectionId) nodes.delete(connectionId);
    else { nodes.clear(); view = undefined; canonical = false; }
  };
  return {
    invalidate,
    subscribe(callback: () => void) {
      refresh = callback;
      return () => { if (refresh === callback) refresh = undefined; };
    },
    observe(connectionId: string | undefined, cursor: unknown) {
      return !connectionId || !nodes.has(connectionId) || nodes.get(connectionId)!.gate.observe(cursor, connectionId);
    },
    begin() {
      if (scope !== getScope()) { invalidate(); scope = getScope(); }
      const current = requests.begin();
      return Object.assign(current, {
        accept<T extends SessionListSnapshot>(next: T): T | undefined {
          if (!current()) return undefined;
          if (!next.sourceStates || !next.viewKey) {
            // Compatibility snapshots cannot inherit canonical source state.
            nodes.clear(); view = undefined;
            if (!canonical) return next;
            const cleared = { ...next, groups: [], sources: [], sourceStates: [], hiddenCount: 0, archivedCount: 0, pinnedCount: 0 };
            delete cleared.revision;
            return cleared;
          }
          canonical = true;
          if (view !== next.viewKey) { nodes.clear(); view = next.viewKey; }
          const incoming = new Map<string, SessionListSnapshot['groups']>();
          for (const group of next.groups) {
            const partitions = new Map<string, typeof group.sessions>();
            for (const session of group.sessions) {
              const id = (session as typeof session & { envConnectionId?: string }).envConnectionId;
              if (!id) continue;
              const rows = partitions.get(id) ?? [];
              rows.push(session); partitions.set(id, rows);
            }
            for (const [id, sessions] of partitions) {
              const groups = incoming.get(id) ?? [];
              groups.push({ ...group, sessions }); incoming.set(id, groups);
            }
          }
          const accepted = new Map<string, NodeSnapshot>();
          const sources: SessionSourceState[] = [];
          let mixed = false;
          for (const source of next.sourceStates) {
            const prior = nodes.get(source.connectionId);
            if (source.state !== 'ready' || !Number.isSafeInteger(source.authority)) {
              if (source.state === 'unavailable' && Number.isSafeInteger(source.authority)
                && prior?.source.authority === source.authority) {
                accepted.set(source.connectionId, prior);
                // Keep the failure visible, not the old ready/cursor proof.
                const { cursor: _cursor, ...unavailable } = source;
                sources.push({ ...unavailable, hiddenCount: prior.source.hiddenCount,
                  archivedCount: prior.source.archivedCount, pinnedCount: prior.source.pinnedCount });
                mixed = true;
              } else sources.push(source);
              continue;
            }
            const gate = prior?.source.authority === source.authority ? prior.gate : createMessageSnapshotGate(getScope);
            gate.subscribe(() => refresh?.());
            if (gate.begin(source.connectionId).accept(source.cursor)) {
              accepted.set(source.connectionId, { source, groups: incoming.get(source.connectionId) ?? [], gate });
              sources.push(source);
            } else if (prior?.source.authority === source.authority) {
              accepted.set(source.connectionId, prior);
              sources.push(prior.source);
              mixed = true;
            } else {
              sources.push({ ...source, state: 'unavailable', hiddenCount: 0, archivedCount: 0, pinnedCount: 0 });
              mixed = true;
            }
          }
          nodes = accepted; // Removed/revoked nodes cannot later resurrect.
          const groups = new Map<string, SessionListSnapshot['groups'][number]>();
          for (const node of nodes.values()) for (const group of node.groups) {
            const merged = groups.get(group.agentId) ?? { agentId: group.agentId, sessions: [] };
            merged.sessions.push(...group.sessions); groups.set(group.agentId, merged);
          }
          const result = { ...next,
            groups: [...groups.values()].sort((a, b) => a.agentId.localeCompare(b.agentId)).map(group => ({ ...group,
              sessions: group.sessions.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
                || (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0) || a.sessionKey.localeCompare(b.sessionKey)),
            })),
            sourceStates: sources,
            sources: sources.flatMap(source => source.state === 'ready' && source.cursor
              ? [{ connectionId: source.connectionId, cursor: source.cursor }] : []),
            hiddenCount: sources.reduce((sum, source) => sum + source.hiddenCount, 0),
            archivedCount: sources.reduce((sum, source) => sum + source.archivedCount, 0),
            pinnedCount: sources.reduce((sum, source) => sum + source.pinnedCount, 0),
          };
          // A mixed-source state is not the server's aggregate revision.
          if (mixed) delete result.revision;
          return result;
        },
      });
    },
  };
}
