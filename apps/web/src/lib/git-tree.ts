export type GitFileState = { indexStatus: 'unknown'|'unchanged'|'added'|'modified'|'conflicted'; worktreeStatus: 'unknown'|'matches-index'|'differs-from-index'|'not-in-index' };
const validState = (v: GitFileState) => ['unknown','unchanged','added','modified','conflicted'].includes(v.indexStatus)
  && ['unknown','matches-index','differs-from-index','not-in-index'].includes(v.worktreeStatus);
export type GitTreePage = { repositoryRef: string; snapshotId: string; observedAt: number;
  entries: ({ name: string; kind: 'directory' | 'file' | 'symlink' | 'unsupported'; pathToken: string; previewCapability: boolean } & GitFileState)[];
  nextCursor: string | null; consistency: 'best_effort'; truncationReason: 'scan-budget' | null; gitStatus: 'unsupported'|'raw-bytes'; branch?: string };
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
export function validGitTreePage(value: unknown, repositoryRef: string): value is GitTreePage {
  if (!value || typeof value !== 'object') return false;
  const v = value as GitTreePage;
  return v.repositoryRef === repositoryRef && typeof v.snapshotId === 'string' && /^[a-f0-9]{64}$/.test(v.snapshotId)
    && Number.isSafeInteger(v.observedAt) && v.observedAt >= 0 && v.consistency === 'best_effort' && ['unsupported','raw-bytes'].includes(v.gitStatus)
    && (v.branch === undefined || (typeof v.branch === 'string' && v.branch.length <= 1024 && !/[\x00-\x1f\x7f]/.test(v.branch)))
    && (v.truncationReason === null || v.truncationReason === 'scan-budget') && (v.nextCursor === null || uuid(v.nextCursor))
    && Array.isArray(v.entries) && v.entries.length <= 200 && new Set(v.entries.map(e => e?.name)).size === v.entries.length
    && new Set(v.entries.map(e => e?.pathToken)).size === v.entries.length
    && v.entries.every(e => e && typeof e.name === 'string' && e.name.length > 0 && e.name.length <= 1024
      && !/[\u0000-\u001f\u007f/]/.test(e.name) && !['.', '..'].includes(e.name)
      && ['directory', 'file', 'symlink', 'unsupported'].includes(e.kind) && (e.name !== '.git' || e.kind === 'unsupported')
      && uuid(e.pathToken) && typeof e.previewCapability==='boolean' && (!e.previewCapability || e.kind==='file') && validState(e)
      && ((v.gitStatus === 'raw-bytes' && e.kind === 'file') || (e.indexStatus === 'unknown' && e.worktreeStatus === 'unknown')));
}
export type GitFilePreview = {repositoryRef:string;pathToken:string;name:string;text:string;bytes:number;contentHash:string;observedAt:number;consistency:'best_effort';comparison?:GitFileState & {diff:string|null}};
export function validGitFilePreview(raw:unknown, repositoryRef:string, pathToken:string):raw is GitFilePreview {
  if(!raw||typeof raw!=='object')return false;const v=raw as GitFilePreview;
  return v.repositoryRef===repositoryRef&&v.pathToken===pathToken&&uuid(pathToken)&&typeof v.name==='string'&&v.name.length>0&&v.name.length<=1024
    && !/[\x00-\x1f\x7f/]/.test(v.name)&&!['.','..','.git'].includes(v.name)&&typeof v.text==='string'&&v.text.length<=131072
    && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v.text)&&Number.isSafeInteger(v.bytes)&&v.bytes>=0&&v.bytes<=131072
    && typeof v.contentHash==='string'&&/^[a-f0-9]{64}$/.test(v.contentHash)&&Number.isSafeInteger(v.observedAt)&&v.observedAt>=0&&v.consistency==='best_effort'
    && (v.comparison===undefined || (!!v.comparison && validState(v.comparison) && (v.comparison.diff===null || (typeof v.comparison.diff==='string' && v.comparison.diff.length<=131072))));
}
