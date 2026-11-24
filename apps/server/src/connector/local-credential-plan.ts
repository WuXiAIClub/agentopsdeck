import { DEFAULT_SCOPES, type ConnectorScope } from '../auth/connector-token.js';
import type { ServerConfig } from '../config.js';
import { LOCAL_FILE_BOARD_OWNER } from './workspace-board-file-policy.js';

export const LOCAL_CREDENTIAL_IDENTITIES = Object.freeze({
  daily: 'local:daily', maintenance: 'local:maintenance', boards: 'local:boards', files: LOCAL_FILE_BOARD_OWNER,
  sourceApproval: 'local:source-approval',
} as const);
export type LocalCredentialRole = keyof typeof LOCAL_CREDENTIAL_IDENTITIES;
export type LocalCredentialSpec = { role: LocalCredentialRole; identity: string; scopes: ConnectorScope[] };
export function localFileBrowserScopes(config: Pick<ServerConfig, 'fileBrowserRoots' | 'fileBrowserLocalWrite'>): Array<'files:read' | 'files:write'> {
  if (!Object.keys(config.fileBrowserRoots ?? {}).length) return [];
  return config.fileBrowserLocalWrite === true ? ['files:read', 'files:write'] : ['files:read'];
}

/** Shared by both startup assemblies. No filesystem, token store or native effects. */
export function localCredentialPlan(config: ServerConfig): LocalCredentialSpec[] {
  return [
    { role: 'daily', identity: LOCAL_CREDENTIAL_IDENTITIES.daily, scopes: [...DEFAULT_SCOPES, 'models:read', ...localFileBrowserScopes(config),
      ...(config.automationLocalManage ? ['automation:manage' as const] : []),
      ...(config.issueLocalRead && config.issueSources?.length ? ['issues:read' as const] : []),
      ...(config.websiteLocalAccess && config.websiteServices?.length ? ['websites:read' as const] : []),
      ...(config.websiteLocalBrowse && config.websiteServices?.some(s => s.browse) ? ['websites:browse' as const] : []),
      ...(config.websiteLocalActions && config.websiteServices?.some(s => s.actions?.length) ? ['websites:act' as const] : []),
      ...(config.websiteLocalConnect && config.websiteServices?.some(s => s.sockets?.length) ? ['websites:connect' as const] : []),
      ...(config.terminalLocalAccess && config.terminalTargets?.some(s => s.local) ? ['terminals:use' as const] : [])] },
    { role: 'maintenance', identity: LOCAL_CREDENTIAL_IDENTITIES.maintenance,
      scopes: ['sessions:read', 'models:read', 'models:write', 'connector:update', 'queue:manage'] },
    ...(config.serverRole === 'all' && config.boardLocalBinding
      ? [{ role: 'boards' as const, identity: LOCAL_CREDENTIAL_IDENTITIES.boards, scopes: ['boards:bind' as const] }] : []),
    ...(config.serverRole === 'all' && config.boardFiles?.policies.some(p => p.owner === LOCAL_CREDENTIAL_IDENTITIES.files)
      ? [{ role: 'files' as const, identity: LOCAL_CREDENTIAL_IDENTITIES.files, scopes: ['boards:files' as const] }] : []),
    ...(config.serverRole === 'all'
      ? [{ role: 'sourceApproval' as const, identity: LOCAL_CREDENTIAL_IDENTITIES.sourceApproval,
        scopes: ['messages:read' as const, 'media:read' as const, 'source:approve' as const, 'source:approve:admin' as const] }] : []),
  ];
}
