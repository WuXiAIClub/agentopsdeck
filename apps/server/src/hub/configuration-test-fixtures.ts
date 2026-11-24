import { randomUUID } from 'node:crypto';
import type { WorkspaceFileCardWrite } from '@agentopsdeck/shared';
import type { HubConfigurationKind } from './member-configuration-domain.js';
export function configurationWrite(kind: HubConfigurationKind, revision = 0): WorkspaceFileCardWrite {
  const contents = {
    website: { title: 'Site', connectionId: 'connection', websiteId: 'site' },
    browser: { title: 'Browser', url: 'https://example.invalid/' },
    research: { title: 'Research', query: 'Private research', sources: [{ title: 'Source', url: 'https://example.invalid/', excerpt: 'Private excerpt' }] },
    terminal: { title: 'Terminal', connectionId: 'connection', targetId: 'target' },
    media: { title: 'Media', mediaId: 'media' },
    dashboard: { title: 'Dashboard', description: 'Private description', items: [{ label: 'metric', value: '42' }] },
  };
  return { kind, content: contents[kind], revision, mutationId: randomUUID() } as WorkspaceFileCardWrite;
}
