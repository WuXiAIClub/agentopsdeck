import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight, Pin, RotateCcw, MoreHorizontal, Pencil, ArrowUp, ArrowDown, Trash2 } from 'lucide-react';
import { ActionMenu } from './ui/action-menu';
import { validSessionTags, type SessionSummary } from '@agentopsdeck/shared';
import { useWorkspacePreferences, updateSessionStyle, WorkspacePreferenceNotice } from './WorkspacePreferences';
import { moveWorkspaceSession, reorderWorkspaceSession, moveWorkspaceGroup, removeWorkspaceGroup } from '../lib/workspace-organization';
import { useI18n } from '../lib/i18n';
import { editText } from './ui/edit-text';
import { confirmAction } from './ui/confirm';
const LazySessionHoverPreview = React.lazy(() => import('./SessionPeek').then(module => ({ default: module.SessionHoverPreview })));
function SessionHoverPreview({ session, children }: { session: SessionSummary; children: React.ReactNode }) {
  const canHover = typeof window !== 'undefined' && window.innerWidth >= 700 && typeof matchMedia === 'function' && matchMedia('(hover: hover)').matches;
  if (!canHover) return <>{children}</>;
  return <React.Suspense fallback={children}><LazySessionHoverPreview session={session}>{children}</LazySessionHoverPreview></React.Suspense>;
}
import { beginSessionCardDrag, endSessionCardDrag, sessionCardDragType } from '../lib/session-card-drag';

const colors = ['#2563eb', '#eab308', '#dc2626', '#7c3aed', '#059669', '#f97316'];
const dragType = sessionCardDragType;
const groupDragType = 'application/x-agentopsdeck-group';

export function SessionOrganizationActions({ sessionKey }: { sessionKey: string }) {
  const { value, ready, saving, change } = useWorkspacePreferences();
  const { t } = useI18n();
  const style = value.sessions[sessionKey];
  const [customColor, setCustomColor] = useState(style?.color ?? '#2563eb');
  const [tagDraft, setTagDraft] = useState((style?.tags ?? []).join(', '));
  const savedTags = JSON.stringify(style?.tags ?? []);
  useEffect(() => { setTagDraft((JSON.parse(savedTags) as string[]).join(', ')); }, [sessionKey, savedTags]);
  const tags = tagDraft.trim() ? tagDraft.split(/[,，]/).map(tag => tag.trim()) : [];
  const tagsValid = validSessionTags(tags);
  useEffect(() => { setCustomColor(style?.color ?? '#2563eb'); }, [sessionKey, style?.color]);
  return <div className="session-organization-actions">
    <fieldset disabled={!ready || saving}>
      <legend>{t('Session color')}</legend>
      <div className="session-color-swatches">{colors.map(color => <button key={color} type="button" style={{ background: color }} aria-label={`${t('Session color')} ${color}`} aria-pressed={style?.color === color} onClick={() => void change(current => updateSessionStyle(current, sessionKey, { color }))} />)}
        <label className="session-custom-color" title={t('Custom color')}><span>+</span><input name="sessionorganization-input-1" type="color" aria-label={t('Custom color')} value={customColor} onChange={event => { const color = event.target.value; setCustomColor(color); void change(current => updateSessionStyle(current, sessionKey, { color })); }} /></label>
        <button type="button" className="session-color-auto" title={t('Automatic color')} aria-label={t('Automatic color')} aria-pressed={!style?.color} onClick={() => void change(current => { if (current.sessions[sessionKey]) delete current.sessions[sessionKey]!.color; return current; })}><RotateCcw size={12} /></button>
      </div>
      <label className="session-group-select">{t('Move to group')}
        <select name="sessionorganization-select-2" value={style?.groupId ?? ''} onChange={event => { const id = event.target.value || undefined; void change(current => moveWorkspaceSession(current, sessionKey, id)); }}>
          <option value="">{t('Ungrouped')}</option>{value.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select>
      </label>
      <label className="session-tag-editor">{t('Session tags')}
        <input name="sessionorganization-input-3" value={tagDraft} maxLength={272} aria-invalid={!tagsValid} onChange={event => setTagDraft(event.target.value)} />
      </label>
      <small>{t('Up to 8 tags, 32 characters each, separated by commas. Tags do not grant access.')}</small>
      <button type="button" disabled={!tagsValid || JSON.stringify(tags) === savedTags} onClick={() => void change(current => updateSessionStyle(current, sessionKey, { tags }))}>{t('Save tags')}</button>
    </fieldset>
    <WorkspacePreferenceNotice />
  </div>;
}

/** Optional organization across all Connectors; grouping never filters authority. */
export function OrganizedSessions({ sessions, children }: { sessions: SessionSummary[]; children: (session: SessionSummary) => React.ReactNode }) {
  const { value, ready, saving, change } = useWorkspacePreferences();
  const { t } = useI18n();
  const [flat, setFlat] = useState(false);
  const [tagFilter, setTagFilter] = useState('');
  const availableTags = [...new Set(sessions.flatMap(session => value.sessions[session.sessionKey]?.tags ?? []))].sort();
  const [dragTarget, setDragTarget] = useState<{ group: string; card?: string; after?: boolean }>();
  const draggedSession = useRef<string | undefined>(undefined);
  function clearDrag() { setDragTarget(undefined); }
  useEffect(() => {
    const end = () => { endSessionCardDrag(); draggedSession.current = undefined; clearDrag(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') end(); };
    window.addEventListener('dragend', end); window.addEventListener('drop', end);
    window.addEventListener('blur', end); window.addEventListener('keydown', escape);
    return () => { end(); window.removeEventListener('dragend', end); window.removeEventListener('drop', end);
      window.removeEventListener('blur', end); window.removeEventListener('keydown', escape); };
  }, []);
  function acceptsDrag(event: React.DragEvent) {
    return ready && !saving && event.dataTransfer.types.some(type => type === dragType || !flat && type === groupDragType);
  }
  function nameGroup(id?: string) {
    editText({ title: t(id ? 'Rename group' : 'New group'), initial: value.groups.find(group => group.id === id)?.name ?? '', maxLength: 80, onSave: async name => {
      const saved = await change(current => {
        if (id) { const group = current.groups.find(group => group.id === id); if (group) group.name = name; }
        else current.groups.push({ id: crypto.randomUUID(), name });
        return current;
      });
      if (!saved) throw new Error(t('Could not save. Close this dialog and reload preferences.'));
    } });
  }
  function drop(event: React.DragEvent, groupId?: string, beforeKey?: string, pinned = false) {
    endSessionCardDrag();
    clearDrag();
    // Pinning is explicit; dropping onto the pinned area only reorders pins.
    if (pinned && !sessions.some(session => session.pinned && session.sessionKey === event.dataTransfer.getData(dragType))) return;
    if (!flat && ready && !saving && event.dataTransfer.types.includes(groupDragType)) {
      event.preventDefault(); event.stopPropagation();
      if (groupId) void change(current => moveWorkspaceGroup(current, event.dataTransfer.getData(groupDragType), groupId));
      return;
    }
    if (!ready || saving || !event.dataTransfer.types.includes(dragType)) return;
    event.preventDefault(); event.stopPropagation();
    const key = event.dataTransfer.getData(dragType);
    if (key === beforeKey || !sessions.some(session => session.sessionKey === key)) return;
    void change(current => {
      // Seed visible cards to preserve their current order on the first drag.
      sessions.forEach((session, order) => { const style = current.sessions[session.sessionKey] ??= {}; style.order ??= order; });
      return flat || pinned ? reorderWorkspaceSession(current, key, beforeKey) : moveWorkspaceSession(current, key, groupId, beforeKey);
    });
  }
  const groups: { id?: string; name: string; collapsed?: boolean; pinned?: boolean }[] = [
    ...(sessions.some(session => session.pinned) ? [{ name: t('Pinned sessions'), pinned: true }] : []),
    ...(flat ? [{ name: '', collapsed: false }] : [{ name: t('Ungrouped'), collapsed: value.ungroupedCollapsed ?? false }, ...value.groups]),
  ];
  return <>
    <div className="session-organization-toolbar"><button type="button" disabled={!ready || saving || value.groups.length >= 100} onClick={() => nameGroup()}>{t('New group')}</button>{value.groups.length ? <button type="button" aria-pressed={flat} onClick={() => setFlat(current => !current)}>{t(flat ? 'Show groups' : 'Flat view')}</button> : null}</div>
    <WorkspacePreferenceNotice />
    {(availableTags.length > 0 || tagFilter) && <label className="session-tag-filter">{t('Filter by tag')}
      <select name="sessionorganization-select-4" aria-label={t('Filter by tag')} value={tagFilter} onChange={event => setTagFilter(event.target.value)}><option value="">{t('All tags')}</option>
        {tagFilter && !availableTags.includes(tagFilter) && <option value={tagFilter}>{tagFilter}</option>}
        {availableTags.map(tag => <option key={tag} value={tag}>{tag}</option>)}
      </select>
    </label>}
    {groups.map(group => {
      const rows = sessions.filter(session => (!tagFilter || value.sessions[session.sessionKey]?.tags?.includes(tagFilter))
        && (group.pinned ? session.pinned : !session.pinned && (flat || value.sessions[session.sessionKey]?.groupId === group.id)))
        .sort((a, b) => (value.sessions[a.sessionKey]?.order ?? 1_000_000) - (value.sessions[b.sessionKey]?.order ?? 1_000_000));
      const groupKey = group.pinned ? 'pinned' : `group:${group.id ?? 'ungrouped'}`;
      const acceptsGroupDrag = (event: React.DragEvent) => acceptsDrag(event) && (!group.pinned || event.dataTransfer.types.includes(dragType)
        && sessions.some(session => session.pinned && session.sessionKey === draggedSession.current));
      if (!rows.length && !group.id && !value.groups.length) return null;
      return <section className={`session-workspace-group${group.pinned ? ' session-pinned-group' : ''}${dragTarget?.group === groupKey ? ' session-workspace-group--drop' : ''}`} key={group.pinned ? 'pinned' : `group:${group.id ?? 'ungrouped'}`} aria-label={group.name || t('Sessions')}
        onDragEnd={() => { draggedSession.current = undefined; clearDrag(); }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) clearDrag(); }}
        onDragOver={event => { if (acceptsGroupDrag(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragTarget({ group: groupKey }); } }} onDrop={event => drop(event, group.id, undefined, group.pinned)}>
        {group.pinned ? <header className="session-group-header"><div className="session-pinned-header"><Pin size={14} aria-hidden="true" /><span>{t('Pinned sessions')}</span><small>{rows.length}</small></div></header> : !flat ? <header className="session-group-header" draggable={!!group.id && ready && !saving} onDragStart={event => { if (group.id) { event.stopPropagation(); event.dataTransfer.setData(groupDragType, group.id); event.dataTransfer.effectAllowed = 'move'; } }}>
          <button type="button" className="session-group-toggle" disabled={!ready || saving} aria-expanded={!group.collapsed} title={t(group.collapsed ? 'Expand group' : 'Collapse group')} onClick={() => void change(current => {
            if (!group.id) current.ungroupedCollapsed = !current.ungroupedCollapsed;
            else { const target = current.groups.find(item => item.id === group.id); if (target) target.collapsed = !target.collapsed; }
            return current;
          })}><ChevronRight size={16} className={group.collapsed ? '' : 'is-expanded'} aria-hidden="true" /><span>{group.name}</span><small>{rows.length}</small></button>
          {group.id ? <ActionMenu label={t('Group actions')} items={[
            { label: t('Rename group'), icon: <Pencil size={14} />, disabled: !ready || saving, run: () => nameGroup(group.id) },
            { label: t('Move up'), icon: <ArrowUp size={14} />, disabled: !ready || saving || value.groups[0]?.id === group.id, run: () => { void change(current => { const index = current.groups.findIndex(item => item.id === group.id); if (index > 0) [current.groups[index - 1], current.groups[index]] = [current.groups[index]!, current.groups[index - 1]!]; return current; }); } },
            { label: t('Move down'), icon: <ArrowDown size={14} />, disabled: !ready || saving || value.groups.at(-1)?.id === group.id, run: () => { void change(current => { const index = current.groups.findIndex(item => item.id === group.id); return moveWorkspaceGroup(current, group.id!, current.groups[index + 2]?.id); }); } },
            { label: t('Remove group'), icon: <Trash2 size={14} />, destructive: true, disabled: !ready || saving, run: async () => { if (await confirmAction({ title: t('Remove group?'), description: t('Sessions will remain available in Ungrouped.'), confirmLabel: t('Remove group') })) void change(current => removeWorkspaceGroup(current, group.id!)); } },
          ]}><MoreHorizontal size={16} /></ActionMenu> : null}
        </header> : null}
        {!group.collapsed ? rows.map((session, index) => <div key={session.sessionKey} draggable
          className={dragTarget?.card === session.sessionKey ? `session-drop-${dragTarget.after ? 'after' : 'before'}` : undefined}
          onDragStart={event => { draggedSession.current = session.sessionKey; beginSessionCardDrag(session.sessionKey); event.dataTransfer.setData(dragType, session.sessionKey); event.dataTransfer.effectAllowed = 'move'; }}
          onDragOver={event => { if (acceptsGroupDrag(event) && event.dataTransfer.types.includes(dragType)) {
            event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
            const rect = event.currentTarget.getBoundingClientRect();
            setDragTarget({ group: groupKey, card: session.sessionKey, after: event.clientY > rect.top + rect.height / 2 });
          } }}
          onDrop={event => { const rect = event.currentTarget.getBoundingClientRect();
            if (event.dataTransfer.getData(dragType) === session.sessionKey) { event.preventDefault(); event.stopPropagation(); endSessionCardDrag(); draggedSession.current = undefined; clearDrag(); return; }
            drop(event, group.id, event.clientY > rect.top + rect.height / 2 ? rows[index + 1]?.sessionKey : session.sessionKey, group.pinned);
          }}><SessionHoverPreview session={session}>{children(session)}</SessionHoverPreview></div>) : null}
        {!group.collapsed && !rows.length ? <span className="session-group-empty">{t('Drop sessions here')}</span> : null}
      </section>;
    })}
  </>;
}
