import { validBoardContent, type BoardContent, type BoardTask } from '@agentopsdeck/shared';
import type { IssuePageView } from './issue-card.js';

export type SourceTaskOutcome = 'applied' | 'exists' | 'busy' | 'too-large' | 'unavailable';
export type SourceTaskRequest = { task: BoardTask; outcome: SourceTaskOutcome };
export function issueTask(item: IssuePageView['items'][number]): BoardTask {
  if (!/^[a-f0-9]{64}$/.test(item.sourceKey)) throw Error('Invalid source identity');
  // Stable source identity, not title/state/body. Same source in the same board
  // is idempotent through the ordinary board CAS, including after reload.
  const h = item.sourceKey;
  const id = `${h.slice(0,8)}-${h.slice(8,12)}-8${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
  const metadata=JSON.stringify({ identity: item.identity, url: item.url, updatedAt: item.updatedAt });
  const prefix = `Source: ${item.sourceKey}\n${metadata.length>3500?metadata.slice(0,3500)+' [metadata truncated]':metadata}\n\n`;
  const body = item.body ?? '';
  const detail = prefix + (body.length <= 4000-prefix.length ? body : body.slice(0,3980-prefix.length)+'\n[truncated]');
  return { id, title: item.title.slice(0,240), detail, status: 'todo' };
}
export function importSourceTask(board: BoardContent, task: BoardTask): { outcome: SourceTaskOutcome; board: BoardContent } {
  if (!validBoardContent({title: 'source', tasks: [task]}) || !/^Source: [a-f0-9]{64}\n/.test(task.detail)) return { outcome: 'unavailable', board };
  const old = board.tasks.find(t=>t.id===task.id);
  if (old) return { outcome: old.detail.split('\n')[0]===task.detail.split('\n')[0] ? 'exists' : 'unavailable', board };
  const next={...board,tasks:[task,...board.tasks]};
  return validBoardContent(next) ? {outcome:'applied',board:next} : {outcome:'too-large',board};
}
export function placeSourceTask(host: HTMLElement, task: BoardTask): SourceTaskOutcome {
  const element=host.querySelector<HTMLElement>('.workspace-taskboard');
  if(!element?.isConnected)return 'unavailable';
  const detail: SourceTaskRequest={task,outcome:'unavailable'};
  element.dispatchEvent(new CustomEvent('agentopsdeck:source-task',{detail}));return detail.outcome;
}
