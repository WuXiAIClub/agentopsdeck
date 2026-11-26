import { FolderOpen, FileCode2, Image, MessageSquare, Search, Terminal, Globe, ChartNoAxesCombined, FileChartColumn, PanelsTopLeft, LayoutDashboard, Film, StickyNote, Network, PenTool, Radio, Container, GitFork, GitPullRequest } from 'lucide-react';
import type { Pane } from '../lib/workspace-layout';

export function CardKindIcon({ kind }: { kind: Pane['kind'] }) {
  const Icon = kind === 'file-browser' ? FolderOpen : kind === 'file-editor' ? FileCode2 : kind === 'image-viewer' ? Image
    : kind === 'git-tree' ? Network : kind === 'git-repo-status' ? GitPullRequest : kind === 'issue-source' ? PanelsTopLeft : kind === 'research' ? Search : kind === 'terminal' ? Terminal : kind === 'browser' || kind === 'website' ? Globe
    : kind === 'metric-card' || kind === 'statuscard' || kind === 'antigravity-quota' ? ChartNoAxesCombined : kind === 'report' ? FileChartColumn
    : kind === 'taskboard' ? PanelsTopLeft : kind === 'drawing' ? PenTool : kind === 'native-drawio' ? Network
    : kind === 'moderator' ? Radio : kind === 'docker' ? Container : kind === 'subagents' ? GitFork : kind === 'dashboard' ? LayoutDashboard : kind === 'media' ? Film : kind === 'notebook' ? StickyNote : MessageSquare;
  return <Icon size={15} strokeWidth={1.75} aria-hidden="true" />;
}
