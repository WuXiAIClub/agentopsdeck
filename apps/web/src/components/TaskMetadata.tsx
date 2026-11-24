import { BOARD_PRIORITIES, type BoardTask, type BoardPriority } from '@agentopsdeck/shared';
import { useLayoutEffect, useRef } from 'react';
import { useI18n } from '../lib/i18n';

const priorities = { low: 'Low priority', normal: 'Normal priority', high: 'High priority', urgent: 'Urgent priority' } as const;

export function TaskMetadataSummary({ task }: { task: BoardTask }) {
  const { t } = useI18n();
  if (!task.tags?.length && !task.priority && !task.dueDate) return null;
  return <div className="workspace-task-metadata" aria-label={t('Task attributes')}>
    {task.priority && <span data-priority={task.priority}>{t(priorities[task.priority])}</span>}
    {task.dueDate && <time dateTime={task.dueDate}>{t('Due date')}: {task.dueDate}</time>}
    {task.tags?.map((tag, index) => <span key={index}>{tag}</span>)}
  </div>;
}

export function TaskMetadataEditor({ task, disabled, readOnly, onChange }: {
  task: BoardTask; disabled: boolean; readOnly: boolean; onChange(task: BoardTask): void;
}) {
  const { t } = useI18n();
  const tagGroup = useRef<HTMLDivElement>(null);
  const removedTag = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const index = removedTag.current;
    if (index === undefined) return;
    removedTag.current = undefined;
    const inputs = tagGroup.current?.querySelectorAll<HTMLInputElement>('input');
    (inputs?.[Math.min(index, inputs.length - 1)] ?? tagGroup.current?.querySelector<HTMLButtonElement>('button'))?.focus();
  }, [task.tags]);
  const setTags = (tags: string[]) => {
    const { tags: _, ...rest } = task;
    onChange(tags.length ? { ...rest, tags } : rest);
  };
  return <div className="workspace-task-attributes">
    <label>{t('Task priority')}<select name="taskmetadata-select-1" aria-label={t('Task priority')} disabled={disabled || readOnly} value={task.priority ?? ''} onChange={event => {
      const { priority: _, ...rest } = task;
      onChange(event.target.value ? { ...rest, priority: event.target.value as BoardPriority } : rest);
    }}><option value="">{t('No priority')}</option>{BOARD_PRIORITIES.map(priority => <option key={priority} value={priority}>{t(priorities[priority])}</option>)}</select></label>
    <label>{t('Due date')}<input name="taskmetadata-input-2" aria-label={t('Due date')} type="date" min="0001-01-01" max="9999-12-31" disabled={disabled} readOnly={readOnly} value={task.dueDate ?? ''} onChange={event => {
      const { dueDate: _, ...rest } = task;
      onChange(event.target.value ? { ...rest, dueDate: event.target.value } : rest);
    }} /></label>
    <div ref={tagGroup} tabIndex={-1} className="workspace-task-tags" role="group" aria-label={t('Task tags')}>
      {task.tags?.map((tag, index) => <label key={index}>{t('Task tag')} {index + 1}<span>
        <input name="taskmetadata-input-3" aria-label={`${t('Task tag')} ${index + 1}`} value={tag} maxLength={32} disabled={disabled} readOnly={readOnly}
          onChange={event => setTags(task.tags!.map((value, i) => i === index ? event.target.value : value))} />
        <button type="button" aria-label={`${t('Remove tag')} ${index + 1}`} disabled={disabled || readOnly} onClick={() => {
          // Move focus before removing its node; TaskCard closes on outside blur.
          tagGroup.current?.focus(); removedTag.current = index;
          setTags(task.tags!.filter((_, i) => i !== index));
        }}>×</button>
      </span></label>)}
      <button type="button" disabled={disabled || readOnly || (task.tags?.length ?? 0) >= 8} onClick={() => setTags([...(task.tags ?? []), ''])}>{t('Add tag')}</button>
    </div>
  </div>;
}
