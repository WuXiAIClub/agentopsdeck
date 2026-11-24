import type { DatabaseSync } from 'node:sqlite';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { reportHubReadFailure } from './read-failure-diagnostics.js';
import { validWorkspaceRevisionRead, validWorkspaceRevisions, DeliverySnapshotReadRejected,
  WORKSPACE_REVISION_TYPES, WORKSPACE_REVISION_ROW_LIMIT, WORKSPACE_REVISION_BYTE_LIMIT,
  type WorkspaceRevisions } from './delivery-reader-protocol.js';

/** Bounded display metadata rejection, not an SQL/identity/owner failure. */
const completedRevisionRefusals = new WeakSet<object>();
export class WorkspaceRevisionReadRejected extends DeliverySnapshotReadRejected {
  constructor() { super(); completedRevisionRefusals.add(this); }
}
export function isWorkspaceRevisionReadRejected(error: unknown): boolean {
  return typeof error === 'object' && error !== null && completedRevisionRefusals.has(error);
}

const tables = ['hub_workspace_boards', 'hub_workspace_board_file_versions', 'hub_workspace_drawings',
  'hub_workspace_native_drawio', 'hub_workspace_cards', 'hub_workspace_card_file_versions',
  'hub_workspace_card_configurations', 'hub_workspace_reports'] as const;
const text = (column: string) => `CASE WHEN typeof(${column})='text'
  AND length(CAST(${column} AS BLOB))<=16384 THEN CAST(${column} AS BLOB) ELSE NULL END`;
// A fixed statement, not caller-provided SQL. One statement means all eight
// domains share the same committed snapshot, with no BEGIN/COMMIT or parent
// transaction ownership. Bodies, credentials and filenames are never selected.
const query = tables.map((table, index) => `SELECT ${index} AS source, ${text('resource_id')} AS resource_id,
  ${index === 6 ? text('kind') : 'NULL'} AS kind, revision FROM ${table} WHERE user_id=?`).join(' UNION ALL ')
  + ' ORDER BY source, kind, resource_id LIMIT ?';
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const decode = (value: unknown) => {
  if (!(value instanceof Uint8Array)) throw new WorkspaceRevisionReadRejected();
  let result: string;
  try { result = decoder.decode(value); } catch { throw new WorkspaceRevisionReadRejected(); }
  if (!result || result.length > 4096 || /[\0\r\n]/.test(result)) throw new WorkspaceRevisionReadRejected();
  return result;
};

export function readWorkspaceRevisions(db: DatabaseSync, owner: string,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics): WorkspaceRevisions {
  try {
    if (!validWorkspaceRevisionRead({ owner })) throw new WorkspaceRevisionReadRejected();
    const result: WorkspaceRevisions = { taskboard: [], 'taskboard-binding': [], drawing: [], 'native-drawio': [],
      'metric-card': [], 'card-file-binding': [], 'card-configuration': [], report: [] };
    let count = 0, bytes = Buffer.byteLength(JSON.stringify(result));
    for (const raw of db.prepare(query).iterate(...tables.map(() => owner), WORKSPACE_REVISION_ROW_LIMIT + 1)) {
      const index = raw.source;
      if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= WORKSPACE_REVISION_TYPES.length)
        throw new WorkspaceRevisionReadRejected();
      const type = WORKSPACE_REVISION_TYPES[index as number]!, id = decode(raw.resource_id);
      const row = { resourceId: type === 'card-configuration' ? JSON.stringify([decode(raw.kind), id]) : id,
        revision: raw.revision as number };
      if (!Number.isSafeInteger(row.revision) || row.revision < 0) throw new WorkspaceRevisionReadRejected();
      bytes += Buffer.byteLength(JSON.stringify(row)) + (result[type].length ? 1 : 0);
      if (++count > WORKSPACE_REVISION_ROW_LIMIT || bytes > WORKSPACE_REVISION_BYTE_LIMIT) throw new WorkspaceRevisionReadRejected();
      result[type].push(row);
    }
    if (!validWorkspaceRevisions(result)) throw new WorkspaceRevisionReadRejected();
    return result;
  } catch (error) { reportHubReadFailure('hub-workspace-revisions-read', error, diagnostics); throw error; }
}
