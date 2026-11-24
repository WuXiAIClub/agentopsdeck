import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Bookmark, Plus, Pencil, Trash2, Save, RotateCw, MoreHorizontal, Copy, X, Monitor, Info, AlertCircle, CheckCheck } from 'lucide-react';
import { recoveryScope, subscribeRecoveryScope } from '../api';
import { parseSavedLayouts, savedLayoutKey, legacySavedLayoutKey, updateSavedLayout, layoutFingerprint, undoSavedLayoutUpdate, reorderSavedLayouts, areSavedLayoutsEquivalent, mergeSavedLayouts, type SavedLayout } from '../lib/saved-layouts';
import { emptyWorkspace, type SessionWorkspace } from '../lib/workspace-layout';
import { useI18n } from '../lib/i18n';
import { editText } from './ui/edit-text';
import { confirmAction } from './ui/confirm';
import { LayoutSyncStatus, useLayoutSync } from './LayoutSyncStatus';
import { WorkspaceContextMenu } from './WorkspaceContextMenu';
import { bindDisplay, displayKey, matchingDisplayLayout, parseDisplayBindings, type DisplayBindings } from '../lib/display-layout';
import { useDisplayProfile } from '../lib/use-display-profile';
import { useLayoutUnread } from '../lib/use-layout-unread';
import { AppBuildLabel } from './AppBuildLabel';
import { CardKindIcon } from './CardKindIcon';
import { useViewportPopover } from '../lib/layout-popover';
import type { WorkspaceTemplateId } from '../lib/layout-templates';
import type { WorkspaceUiMode } from '../lib/desktop-os-mode';
import { SESSION_HANDOFF_EVENT, applyHandoffToSavedLayouts, type SessionHandoffEventDetail } from '../lib/session-handoff';

type Props = { workspace: SessionWorkspace; collapsedKeys: ReadonlySet<string>; onRestore: (saved: SavedLayout) => boolean; onApplyTemplate?: (templateId: WorkspaceTemplateId, autoSave?: boolean) => void; quickSwitchHost?: HTMLElement | null; uiMode?: WorkspaceUiMode | undefined; onSelectOsDesktop?: (() => void) | undefined };
export function SavedLayouts(props: Props) {
  const scope = useSyncExternalStore(subscribeRecoveryScope, recoveryScope);
  // Menus, undo and named-layout association must not cross account boundaries.
  return <ScopedSavedLayouts key={scope ?? ''} {...props} scope={scope} />;
}
function ScopedSavedLayouts({ workspace, collapsedKeys, onRestore, onApplyTemplate, quickSwitchHost, uiMode, onSelectOsDesktop, scope }: Props & { scope: string | undefined }) {
  const { t } = useI18n();
  const key = savedLayoutKey(scope);
  // Device-local association only; account-synced snapshot schemas stay unchanged.
  const associationKey = key ? `${key}:selected` : undefined;
  const read = () => { try { return parseSavedLayouts(key ? localStorage.getItem(key) ?? localStorage.getItem(legacySavedLayoutKey(scope)!) : null); } catch { return []; } };
  const readAssociation = (): string | undefined => { try { return associationKey ? localStorage.getItem(associationKey) ?? undefined : undefined; } catch { return undefined; } };
  const [items, setItems] = useState(read), [error, setError] = useState('');
  const dragged = useRef<string | undefined>(undefined);
  const suppressClick = useRef(false);
  const dragType = 'application/x-agentopsdeck-layout-order';
  const unread = useLayoutUnread(scope, [workspace, ...items.map(item => item.workspace)]);
  const displayStorageKey = key ? `${key}:displays.v1` : undefined;
  const readDisplays = () => { try { return parseDisplayBindings(displayStorageKey ? localStorage.getItem(displayStorageKey) : null); } catch { return parseDisplayBindings(null); } };
  const [displayBindings, setDisplayBindings] = useState(readDisplays);
  const display = useDisplayProfile(displayBindings.enabled && displayBindings.bindings.length > 0);
  const lastDisplay = useRef<string | undefined>(undefined);
  const [selectedId, setSelectedId] = useState(readAssociation);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number }>();
  const pendingContext = useRef<typeof menu>(undefined);
  const menuTrigger = useRef<HTMLElement | null>(null);
  const [notice, setNotice] = useState<{ text: string; undo?: { before: SavedLayout; written: SavedLayout } }>();
  const [menuOpen, setMenuOpen] = useState(false);
  const summaryRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useViewportPopover(menuOpen, summaryRef, menuRef);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(current => current === notice ? undefined : current), 3800);
    return () => clearTimeout(timer);
  }, [notice]);
  const closeMenu = useCallback(() => setMenu(undefined), []);
  useEffect(() => {
    // Chromium light-dismisses an auto-popover on the opening right-button
    // release. Open after that release; keyboard context menus open directly.
    const release = (event: PointerEvent) => {
      const pending = pendingContext.current; pendingContext.current = undefined;
      if (pending && event.button === 2) setMenu(pending);
    };
    const cancel = () => { pendingContext.current = undefined; };
    document.addEventListener('pointerup', release);
    document.addEventListener('pointercancel', cancel);
    return () => { document.removeEventListener('pointerup', release); document.removeEventListener('pointercancel', cancel); };
  }, []);
  const signature = useMemo(() => layoutFingerprint(workspace, collapsedKeys), [workspace, collapsedKeys]);
  const fingerprints = useMemo(() => new Map(items.map(item => [item.id, layoutFingerprint(item.workspace, new Set(item.collapsedKeys))])), [items]);
  const selected = selectedId === undefined ? items.find(item => fingerprints.get(item.id) === signature) : items.find(item => item.id === selectedId);
  const dirty = !!selected && fingerprints.get(selected.id) !== signature;
  const associate = (id: string) => {
    if (!key || recoveryScope() !== scope) return;
    setSelectedId(id);
    try { localStorage.setItem(associationKey!, id); } catch { /* Snapshot save still works without persistent association. */ }
  };
  useEffect(() => { if (selectedId === undefined && selected) associate(selected.id); }, [selectedId, selected?.id]);
  const sync = useLayoutSync('saved', scope, JSON.stringify(items), value => {
    const parsed = parseSavedLayouts(value);
    let raw: unknown;
    try { raw = JSON.parse(value); } catch { return false; }
    if (!key || recoveryScope() !== scope || !Array.isArray(raw) || parsed.length !== raw.length) return false;
    try { localStorage.setItem(key, JSON.stringify(parsed)); setItems(parsed); return true; } catch { return false; }
  }, {
    debounceMs: 1500,
    equivalent: areSavedLayoutsEquivalent,
    merge: mergeSavedLayouts,
  });
  const syncPhase = useSyncExternalStore(sync.subscribe, sync.snapshot);
  useEffect(() => {
    const storage = (event: StorageEvent) => {
      if (event.key === key || event.key === null) setItems(read());
      if (event.key === associationKey || event.key === null) setSelectedId(readAssociation());
      if (event.key === displayStorageKey || event.key === null) setDisplayBindings(readDisplays());
      if (event.key === autoSaveActiveKey || event.key === null) setAutoSaveActive(readAutoSaveActive());
    };
    window.addEventListener('storage', storage); return () => window.removeEventListener('storage', storage);
  }, [key]);
  const save = (next: SavedLayout[]) => {
    if (!key || recoveryScope() !== scope) throw new Error(t('Layout could not be saved in this browser.'));
    try { localStorage.setItem(key, JSON.stringify(next)); setItems(next); setError(''); }
    catch { throw new Error(t('Layout could not be saved in this browser.')); }
  };
  const run = (action: () => void) => { try { action(); } catch (e) { setError(e instanceof Error ? e.message : t('Layout could not be saved in this browser.')); } };
  const restore = (item: SavedLayout) => { if (onRestore(item)) { associate(item.id); setNotice(undefined); } };
  const writeDisplays = (next: DisplayBindings) => {
    if (!displayStorageKey || recoveryScope() !== scope) throw Error(t('Layout could not be saved in this browser.'));
    localStorage.setItem(displayStorageKey, JSON.stringify(next)); setDisplayBindings(next);
  };
  const bind = async (item: SavedLayout) => {
    if (recoveryScope() !== scope) return;
    const existing = readDisplays();
    if (existing.bindings.some(b => b.layoutId === item.id)) {
      run(() => writeDisplays({ ...existing, bindings: existing.bindings.filter(b => b.layoutId !== item.id) })); return;
    }
    const screen = await display.request(); // Permission, if needed, is requested only by this click.
    if (!screen || recoveryScope() !== scope) return;
    run(() => {
      const latest = read();
      if (!latest.some(row => row.id === item.id)) throw Error(t('This saved layout no longer exists.'));
      const next = readDisplays();
      next.bindings = next.bindings.filter(b => latest.some(row => row.id === b.layoutId));
      writeDisplays(bindDisplay(next, item.id, screen));
      // Binding is metadata, not an implicit restore of another layout.
      lastDisplay.current = displayKey(screen);
      setNotice({ text: t('Display binding saved on this browser') });
    });
  };
  useEffect(() => {
    if (!display.current || !displayBindings.enabled || !scope || syncPhase === 'loading' || syncPhase === 'conflict') return;
    const token = displayKey(display.current);
    if (lastDisplay.current === token) return;
    const id = matchingDisplayLayout(displayBindings, display.current, new Set(items.map(i => i.id)));
    // Wait for the account's saved layouts to load before consuming the screen.
    if (!items.length) return;
    lastDisplay.current = token;
    if (!id || id === selected?.id) return;
    const editing = document.activeElement?.closest('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="submit"]),textarea,[contenteditable="true"],[role="dialog"]');
    if (dirty || (!selected && workspace.panes.length > 0) || editing || menu) {
      setNotice({ text: t('Display changed; current edits kept. Switch layouts manually.') }); return;
    }
    const item = items.find(i => i.id === id)!;
    if (onRestore(item)) { associate(item.id); setNotice({ text: t('Layout switched for this display') }); }
  }, [display.current, displayBindings, items, selected?.id, dirty, signature, syncPhase]);
  const update = (item: SavedLayout, snapshot = workspace, collapsed = collapsedKeys) => run(() => {
    const latest = read(), before = latest.find(row => row.id === item.id);
    if (!before) throw Error(t('This saved layout no longer exists.'));
    const next = updateSavedLayout(latest, item.id, snapshot, collapsed);
    if (next === latest) throw Error(t('Layout could not be saved in this browser.'));
    save(next);
    setNotice({ text: t('Layout updated'), undo: { before, written: next.find(row => row.id === item.id)! } });
  });
  const autoSaveActiveKey = key ? `${key}:auto-save-active` : undefined;
  const readAutoSaveActive = () => {
    try { return autoSaveActiveKey ? localStorage.getItem(autoSaveActiveKey) !== 'false' : true; } catch { return true; }
  };
  const [autoSaveActive, setAutoSaveActive] = useState<boolean>(readAutoSaveActive);
  useEffect(() => {
    if (!autoSaveActive || uiMode === 'os-desktop' || !selected || !dirty || !key || syncPhase === 'loading' || syncPhase === 'conflict') return;
    if (workspace.panes.length === 0 && selected.workspace.panes.length > 0) return;
    const targetId = selected.id;
    const snapshot = structuredClone(workspace);
    const collapsed = new Set(collapsedKeys);
    const timer = window.setTimeout(() => {
      if (recoveryScope() !== scope) return;
      const latest = read();
      const currentItem = latest.find(row => row.id === targetId);
      if (!currentItem) return;
      if (layoutFingerprint(currentItem.workspace, new Set(currentItem.collapsedKeys)) === signature) return;
      const next = updateSavedLayout(latest, targetId, snapshot, collapsed);
      if (next !== latest) {
        try { localStorage.setItem(key, JSON.stringify(next)); setItems(next); setError(''); } catch { /* ignore */ }
      }
    }, 1600);
    return () => window.clearTimeout(timer);
  }, [autoSaveActive, uiMode, selected?.id, selected?.workspace.panes.length, dirty, signature, key, scope, syncPhase]);
  const [autoSaveOnCreate, setAutoSaveOnCreate] = useState<boolean>(() => {
    try { return key ? localStorage.getItem(`${key}:auto-save-create`) !== 'false' : true; } catch { return true; }
  });
  useEffect(() => {
    const onAutoSaveTemplate = (event: Event) => {
      const detail = (event as CustomEvent<{ name?: string; workspace?: SessionWorkspace }>).detail;
      const ws = detail?.workspace;
      if (!ws || !key || recoveryScope() !== scope) return;
      run(() => {
        const latest = read();
        if (latest.length >= 50) return;
        const id = crypto.randomUUID();
        const item: SavedLayout = {
          id,
          name: (detail.name || t('Saved layouts')).slice(0, 80),
          workspace: structuredClone(ws),
          collapsedKeys: [],
        };
        save([...latest, item]);
        associate(id);
        setNotice({ text: `${t('Layout updated')}: ${item.name}` });
      });
    };
    window.addEventListener('agentopsdeck:auto-save-template-layout', onAutoSaveTemplate);
    return () => window.removeEventListener('agentopsdeck:auto-save-template-layout', onAutoSaveTemplate);
  }, [key, scope, t]);
  useEffect(() => {
    const onSessionHandoff = (event: Event) => {
      const detail = (event as CustomEvent<SessionHandoffEventDetail>).detail;
      if (!detail?.fromSessionKey || !detail?.toSessionKey || !key || recoveryScope() !== scope) return;
      const latest = read();
      const migrated = applyHandoffToSavedLayouts(
        latest,
        detail.fromSessionKey,
        detail.toSessionKey,
        detail.replaceSourcePane ?? true,
      );
      if (migrated.changedIds.length > 0) {
        try {
          const serialized = JSON.stringify(migrated.items);
          localStorage.setItem(key, serialized);
          setItems(migrated.items);
          setError('');
          sync.edit(serialized);
          sync.retry();
        } catch {
          // Keep in-memory update if storage quota exceeded
          setItems(migrated.items);
        }
        detail.claimedSavedSync = true;
      } else {
        // Storage was already migrated synchronously before this listener ran
        setItems(latest);
        const serialized = JSON.stringify(latest);
        sync.edit(serialized);
        sync.retry();
        detail.claimedSavedSync = true;
      }
    };
    window.addEventListener(SESSION_HANDOFF_EVENT, onSessionHandoff);
    return () => window.removeEventListener(SESSION_HANDOFF_EVENT, onSessionHandoff);
  }, [key, scope, sync]);
  const canCreate = !!key && items.length < 50;
  const create = (duplicate?: SavedLayout, blank = false) => {
    const snapshot = blank ? emptyWorkspace() : structuredClone(duplicate?.workspace ?? workspace), collapsed = blank ? [] : [...(duplicate?.collapsedKeys ?? collapsedKeys)];
    if (blank && autoSaveOnCreate && canCreate) {
      run(() => {
        const latest = read();
        if (latest.length >= 50) throw Error(t('Saved layout limit reached.'));
        const id = crypto.randomUUID();
        const suffix = new Date().toISOString().slice(11, 16);
        const item = { id, name: `${t('New blank canvas')} · ${suffix}`.slice(0, 80), workspace: snapshot, collapsedKeys: collapsed };
        save([...latest, item]);
        restore(item);
      });
      return;
    }
    editText({ title: t('Layout name'), initial: duplicate ? t('{name} copy', { name: duplicate.name }).slice(0, 80) : '', maxLength: 80, onSave: async name => {
      const latest = read();
      if (latest.length >= 50) throw Error(t('Saved layout limit reached.'));
      const id = crypto.randomUUID();
      const item = { id, name, workspace: snapshot, collapsedKeys: collapsed };
      save([...latest, item]);
      if (blank) restore(item);
      else if (!duplicate) associate(id);
    } });
  };
  const rename = (item: SavedLayout) => editText({ title: t('Layout name'), initial: item.name, maxLength: 80, onSave: async name => {
    const latest = read();
    if (!latest.some(row => row.id === item.id)) throw Error(t('This saved layout no longer exists.'));
    save(latest.map(row => row.id === item.id ? { ...row, name } : row));
  } });
  const remove = async (item: SavedLayout) => {
    if (await confirmAction({ title: t('Delete saved layout?'), description: `${item.name} · ${t('Sessions will not be deleted.')}`, confirmLabel: t('Delete') })) run(() => {
      save(read().filter(row => row.id !== item.id));
      const bindings = readDisplays();
      writeDisplays({ ...bindings, bindings: bindings.bindings.filter(b => b.layoutId !== item.id) });
      if (selected?.id === item.id) associate('');
      setNotice(undefined);
    });
  };
  const menuItem = items.find(item => item.id === menu?.id);
  return <>{quickSwitchHost && createPortal(<nav className="saved-layouts-strip" aria-label={t('Switch saved layout')}>
    <Bookmark size={13} aria-hidden="true" />
    {!selected && uiMode !== 'os-desktop' && <span className="saved-layout-temporary">{t('Temporary layout')}</span>}
    <div className="saved-layouts-shortcuts">
      {onSelectOsDesktop && (
        <div className="saved-layout-shortcut saved-layout-os-special" data-current={uiMode === 'os-desktop'} data-layout-id="os-desktop-special">
          <button
            className="saved-layout-name"
            type="button"
            title={t('OS Desktop Mode (Dedicated layout)')}
            aria-label={t('OS Desktop Mode')}
            aria-current={uiMode === 'os-desktop' ? 'true' : undefined}
            onClick={() => onSelectOsDesktop()}
          >
            <Monitor size={12} aria-hidden="true" />
            <span>{t('OS Desktop')}</span>
          </button>
        </div>
      )}
      {items.map(item => <div className="saved-layout-shortcut" data-current={uiMode !== 'os-desktop' && selected?.id === item.id} data-layout-id={item.id} key={item.id}
      onDragOver={event => { if (dragged.current && event.dataTransfer.types.includes(dragType)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; } }}
      onDrop={event => {
        const source = dragged.current;
        if (!source || !event.dataTransfer.types.includes(dragType)) return;
        event.preventDefault(); event.stopPropagation(); dragged.current = undefined;
        if (event.dataTransfer.getData(dragType) !== source) return;
        run(() => save(reorderSavedLayouts(read(), source, item.id)));
      }}
      onContextMenu={event => {
        event.preventDefault(); event.stopPropagation();
        menuTrigger.current = (event.target as HTMLElement).closest('button');
        const point = { id: item.id, x: event.clientX, y: event.clientY };
        if (event.buttons & 2) pendingContext.current = point; else setMenu(point);
      }}>
      <button className="saved-layout-name" type="button" draggable={!!scope} title={`${item.name} · ${t('Drag to reorder; Alt+Left/Right to move')}`} aria-label={item.name} aria-current={uiMode !== 'os-desktop' && selected?.id === item.id ? 'true' : undefined}
        onDragStart={event => { dragged.current = item.id; suppressClick.current = true; event.dataTransfer.setData(dragType, item.id); event.dataTransfer.effectAllowed = 'move'; event.stopPropagation(); }}
        onDragEnd={() => { dragged.current = undefined; }}
        onPointerDown={() => { suppressClick.current = false; }}
        onKeyDown={event => {
          if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
          event.preventDefault();
          const latest = read(), index = latest.findIndex(row => row.id === item.id), target = latest[index + (event.key === 'ArrowLeft' ? -1 : 1)];
          if (target) run(() => save(reorderSavedLayouts(latest, item.id, target.id)));
        }}
        onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } restore(item); }}>
        <span>{item.name}</span>{unread.count(item.workspace) > 0 && <small className="saved-layout-unread" aria-label={t('Observed unread completions')} title={t('Observed unread completions')}>{unread.count(item.workspace)}</small>}{displayBindings.bindings.some(b => b.layoutId === item.id) && <Monitor size={12} aria-label={t('Display-bound layout')} />}{selected?.id === item.id && dirty && <span className="saved-layout-dirty" role="img" aria-label={t('Unsaved layout changes')} title={t('Unsaved layout changes')} />}
      </button>
      {selected?.id === item.id && dirty && <button type="button" aria-label={t('Update this layout')} title={t('Update this layout')} onClick={() => update(item)}><RotateCw size={12} /></button>}
      <button className="saved-layout-more" type="button" aria-label={`${t('Layout actions')} · ${item.name}`} title={t('Layout actions')} aria-haspopup="true" aria-expanded={menu?.id === item.id} onClick={event => { menuTrigger.current = event.currentTarget; const rect = event.currentTarget.getBoundingClientRect(); setMenu({ id: item.id, x: rect.left, y: rect.bottom + 4 }); }}><MoreHorizontal size={13} /></button>
    </div>)}</div>
    <button type="button" disabled={unread.busy || !unread.canMark(workspace)} title={t(unread.canMark(workspace) ? 'Mark active session read' : 'Select a visible session with an observed unread completion')} aria-label={t('Mark active session read')} onClick={() => void unread.markActive(workspace)}><CheckCheck size={14} /></button>
    <button type="button" aria-label={t('Unread status')} title={t(unread.unavailable ? 'Unread status unavailable' : unread.loading ? 'Loading configuration…' : unread.partial ? 'Unread history is partial' : 'Observed unread completions')} onClick={() => {
      setNotice({ text: t(unread.unavailable ? 'Unread service could not be reached. Retrying; existing counts may be stale.' : 'Counts include observed completions only. Older or unobserved sessions have unknown history, not a service failure. Select a visible unread session to mark it read.') });
      void unread.refresh();
    }}>{unread.unavailable ? <AlertCircle size={14} /> : <Info size={14} />}</button>
    {[false, true].map(blank => {
      const label = t(blank ? 'New blank canvas' : 'Save as new layout'), Icon = blank ? Copy : Plus;
      return <button key={label} className="saved-layout-add" type="button" disabled={!canCreate} title={label} aria-label={label} onClick={() => create(undefined, blank)}><Icon size={14} /></button>;
    })}
    <AppBuildLabel versionLabel={t('Version')} buildLabel={t('Build number')} />
  </nav>, quickSwitchHost)}
  {menu && menuItem && <WorkspaceContextMenu point={menu} close={closeMenu}>
    <div className="saved-layout-context-actions" onKeyDown={event => { if (event.key === 'Escape') menuTrigger.current?.focus({ preventScroll: true }); }}>
    <strong className="saved-layout-menu-title">{menuItem.name}</strong>
    <button type="button" onClick={() => { setMenu(undefined); void bind(menuItem); }}><Monitor size={14} />{t(displayBindings.bindings.some(b => b.layoutId === menuItem.id) ? 'Remove display binding' : 'Bind to current display')}</button>
    <button type="button" disabled={!canCreate} onClick={() => create()}><Plus size={14} />{t('Save as new layout')}</button>
    <button type="button" onClick={() => rename(menuItem)}><Pencil size={14} />{t('Rename')}</button>
    <button type="button" disabled={!key || items.length >= 50} onClick={() => create(menuItem)}><Copy size={14} />{t('Duplicate layout')}</button>
    <button type="button" className="is-danger" onClick={() => remove(menuItem)}><Trash2 size={14} />{t('Delete')}</button>
    </div>
  </WorkspaceContextMenu>}
  {(notice || error) && createPortal(<div className="saved-layout-feedback" role={error ? 'alert' : 'status'}>
    <span>{error || notice?.text}</span>
    {!error && notice?.undo && <button type="button" onClick={() => run(() => {
      const next = undoSavedLayoutUpdate(read(), notice.undo!.before, notice.undo!.written);
      if (!next) throw Error(t('Layout changed elsewhere. Undo was not applied.'));
      save(next); setNotice({ text: t('Layout update undone') });
    })}>{t('Undo')}</button>}
    <button type="button" aria-label={t('Dismiss')} onClick={() => { setNotice(undefined); setError(''); }}><X size={13} /></button>
  </div>, document.body)}
  <details className="session-workspace-presets saved-layouts" onToggle={event => setMenuOpen(event.currentTarget.open)} onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; setMenuOpen(false); event.currentTarget.querySelector('summary')?.focus(); } }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { event.currentTarget.open = false; setMenuOpen(false); } }}>
    <summary ref={summaryRef} aria-label={t('Saved layouts')} title={t('Saved layouts')}><Bookmark size={15} /></summary>
    <div ref={menuRef} className="saved-layouts-menu">
      <div className="saved-layouts-header"><strong>{t('Saved layouts')}</strong><LayoutSyncStatus sync={sync} /></div>
      <small>{t('Sessions and arrangement · synced to your account')}</small>
      <div className="saved-layout-display-settings">
        <label><input name="savedlayouts-autosave-active" type="checkbox" checked={autoSaveActive} disabled={!key} onChange={event => {
          const next = event.target.checked;
          setAutoSaveActive(next);
          try { if (autoSaveActiveKey) localStorage.setItem(autoSaveActiveKey, String(next)); } catch { /* ignore */ }
        }} />{t('Auto-save changes to active layout')}</label>
        <label><input name="savedlayouts-input-1" type="checkbox" checked={displayBindings.enabled} disabled={!key} onChange={event => run(() => {
          lastDisplay.current = undefined; writeDisplays({ ...readDisplays(), enabled: event.target.checked });
        })} />{t('Switch layout with display')}</label>
        <small>{display.current ? `${display.current.label || t('Current display')} · ${display.current.width} × ${display.current.height}` : t('Current display')}</small>
        <small>{t(display.precise ? 'Display bindings stay in this browser and account.' : 'Size matching only; identical displays cannot be distinguished.')}</small>
      </div>
      <div className="saved-layouts-list">
        {onSelectOsDesktop && (
          <div className="saved-layout-row saved-layout-os-special-row">
            <button
              type="button"
              aria-current={uiMode === 'os-desktop' ? 'true' : undefined}
              onClick={event => {
                event.currentTarget.closest('details')?.removeAttribute('open');
                setMenuOpen(false);
                onSelectOsDesktop();
              }}
            >
              <span className="saved-layout-os-label">
                <Monitor size={13} />
                <span>{t('OS Desktop (Dedicated layout)')}</span>
              </span>
              <small>{t('Desktop')}</small>
            </button>
          </div>
        )}
        {items.map(item => <div className="saved-layout-row" key={item.id}>
          <button type="button" aria-current={uiMode !== 'os-desktop' && selected?.id === item.id ? 'true' : undefined} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); setMenuOpen(false); restore(item); }}><span>{item.name}</span>{unread.count(item.workspace) > 0 && <small className="saved-layout-unread" aria-label={t('Observed unread completions')}>{unread.count(item.workspace)}</small>}<small>{item.workspace.panes.length}</small></button>
          <button type="button" aria-pressed={displayBindings.bindings.some(b => b.layoutId === item.id)} aria-label={`${t(displayBindings.bindings.some(b => b.layoutId === item.id) ? 'Remove display binding' : 'Bind to current display')} · ${item.name}`} title={t(displayBindings.bindings.some(b => b.layoutId === item.id) ? 'Remove display binding' : 'Bind to current display')} onClick={() => void bind(item)}><Monitor size={13} /></button>
          <button type="button" aria-label={`${t('Update with current layout')} ${item.name}`} title={t('Update with current layout')} onClick={async () => {
            const snapshot = structuredClone(workspace), collapsed = new Set(collapsedKeys);
            if (selected?.id === item.id || await confirmAction({ title: t('Update saved layout?'), description: item.name, confirmLabel: t('Update with current layout') })) update(item, snapshot, collapsed);
          }}><Save size={13} /></button>
          <button type="button" aria-label={`${t('Rename')} ${item.name}`} onClick={() => rename(item)}><Pencil size={13} /></button>
          <button type="button" aria-label={`${t('Delete')} ${item.name}`} onClick={() => remove(item)}><Trash2 size={13} /></button>
        </div>)}
      </div>
      <div className="saved-layouts-actions">
        <button type="button" className="saved-layout-new" disabled={!canCreate} onClick={() => create()}><Plus size={15} /><span>{t('Save current layout')}</span></button>
        <button type="button" className="saved-layout-new" disabled={!canCreate} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); setMenuOpen(false); create(undefined, true); }}><Copy size={15} /><span>{t('New blank canvas')}</span></button>
      </div>
      {onApplyTemplate && <div className="saved-layout-templates-section">
        <div className="saved-layout-templates-head">
          <strong>{t('Layout templates')}</strong>
          <label className="saved-layout-autosave-label">
            <input
              name="savedlayouts-autosave-template"
              type="checkbox"
              checked={autoSaveOnCreate}
              onChange={event => {
                const next = event.target.checked;
                setAutoSaveOnCreate(next);
                try { if (key) localStorage.setItem(`${key}:auto-save-create`, String(next)); } catch { /* ignore */ }
              }}
            />
            <span>{t('Auto-save layout on creation')}</span>
          </label>
        </div>
        {([
          ['moderator-mode', 'Apply template: Moderator Mode', 'moderator'],
          ['collab-pair', 'Apply template: Dual Session + Notes & Taskboard', 'taskboard'],
          ['research-triage', 'Apply template: Research & Triage Deck', 'research'],
        ] as const).map(([tplId, tplLabel, tplKind]) => (
          <button
            key={tplId}
            type="button"
            className="saved-layout-new saved-layout-template-btn"
            disabled={!canCreate && autoSaveOnCreate}
            onClick={event => {
              event.currentTarget.closest('details')?.removeAttribute('open');
              setMenuOpen(false);
              onApplyTemplate(tplId, autoSaveOnCreate);
            }}
          >
            <CardKindIcon kind={tplKind} />
            <span>{t(tplLabel)}</span>
          </button>
        ))}
      </div>}
    </div>
  </details></>;
}
