import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { recordCardVersionSnapshot } from '../lib/card-version-history';
import { EditorContent, Extension, useEditor } from '@tiptap/react';
import { Plugin } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import { Bold, Italic, Strikethrough, List, ListTodo, Heading2, Code, Undo2, Redo2, Type, X, ListTree, Clock3, Copy, Scissors } from 'lucide-react';
const CardVersionHistoryModal = lazy(() => import('./CardVersionHistoryModal'));
import { handleContextMenuKeyDown, useContextMenuPosition } from '../lib/context-menu-position';
import { NOTEBOOK_MAX_CHARS } from '../lib/session-notebook';
import { createNotebookMarkdownParser, NotebookStyleHtmlBlock, NotebookTextStyleMark, NOTE_TEXT_SIZES, NOTE_TEXT_COLORS, NOTE_HIGHLIGHTS, NOTE_TEXT_FONTS, type NotebookTextStyle } from '../lib/notebook-text-style';
import { notebookSelectionRange, type NotebookArchiveSelection } from '../lib/notebook-selection';
import { useI18n } from '../lib/i18n';
import type { RemoteDraft } from '../lib/remote-draft';
import { NotebookPopover } from './NotebookPopover';
import { recoveryScope, recoveryEpoch } from '../api';
import { notebookFolding, notebookFoldKey, readNotebookFolds } from '../lib/notebook-folding';

// Preserve image Markdown without fetching remote URLs from private notes.
const PrivateImage = Image.extend({
  renderHTML({ node }) { return ['span', { class: 'notebook-image-reference', contenteditable: 'false' }, `▧ ${node.attrs.alt || node.attrs.src || 'Image'}`]; },
});

/** Markdown stays the wire/storage format. Loading never rewrites the source;
 * normalization only happens on a user edit. Remote echoes do not reset selection. */
export default function NotebookEditor({ text, disabled, label, onChange, onSave, onReady, onArchive, foldKey: resourceId }: {
  text: string; disabled: boolean; label: string; onChange: (text: string) => void; onSave: () => void; onReady: (focus: (() => void) | undefined) => void; foldKey?: string | undefined;
  onArchive?: ((selection: NotebookArchiveSelection) => void) | undefined;
}) {
  const { t } = useI18n();
  const foldKey = resourceId && recoveryScope() ? JSON.stringify([recoveryScope(), resourceId]) : undefined;
  const [reading, setReading] = useState(() => readNotebookFolds(foldKey).reading);
  const [folding] = useState(() => notebookFolding(foldKey, { expand: t('Expand section'), collapse: t('Collapse section') }));
  const styleTrigger = useRef<HTMLButtonElement>(null);
  const outlineTrigger = useRef<HTMLButtonElement>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [outline, setOutline] = useState<{ position: number; title: string; level: number }[]>([]);
  const callbacks = useRef({ onChange, onSave, onReady }); callbacks.current = { onChange, onSave, onReady };
  const last = useRef(text);
  const [limited, setLimited] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; hasSelection: boolean; selectedText: string; isDark: boolean;
    from: number; to: number; doc: ProseMirrorNode; source: string; scope: string | undefined; epoch: number; resourceId: string | undefined } | null>(null);
  const [contextMessage, setContextMessage] = useState('');
  const liveSelection = useRef({ contextMenu, text, disabled, reading, resourceId });
  liveSelection.current = { contextMenu, text, disabled, reading, resourceId };
  const contextMenuRef = useRef<HTMLDivElement>(null);
  useContextMenuPosition(Boolean(contextMenu && !disabled && !reading), contextMenu, contextMenuRef, { autoFocus: false });
  const scope = recoveryScope() ?? 'default';
  const versionResourceId = resourceId || label || 'notebook';
  useEffect(() => {
    if (text && text.trim()) {
      const firstLine = text.trim().split(/\r?\n/)[0]?.replace(/^#+\s*/, '') || label || 'Notebook';
      recordCardVersionSnapshot({
        scope,
        kind: 'notebook',
        resourceId: versionResourceId,
        payload: text,
        summary: `${firstLine.slice(0, 60)} (${text.length} chars)`,
      });
    }
  }, [scope, versionResourceId]);
  useEffect(() => { if (disabled) { setStyleOpen(false); setOutlineOpen(false); setContextMenu(null); } }, [disabled]);
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onPointerDown = (e: PointerEvent) => {
      if (contextMenuRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onScroll = (e: Event) => {
      if (contextMenuRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu(null);
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [contextMenu]);
  useEffect(() => { setOutlineOpen(false); }, [text]);
  const [markdown] = useState(() => Markdown.configure({ marked: createNotebookMarkdownParser() }));
  // Reject oversized changes before they enter the document/undo history.
  // Undoing after onUpdate would also undo earlier typing in the same group.
  const boundedMarkdown = Extension.create({
    name: 'boundedMarkdown',
    addProseMirrorPlugins() {
      return [new Plugin({ filterTransaction: transaction => {
        if (!transaction.docChanged || transaction.getMeta('preventUpdate')) return true;
        const next = this.editor.markdown?.serialize(transaction.doc.toJSON());
        const exceeds = next !== undefined && next.length > NOTEBOOK_MAX_CHARS;
        queueMicrotask(() => setLimited(exceeds));
        return !exceeds;
      } })];
    },
  });
  const editor = useEditor({
    // Create after React commits. A lazy/concurrent initial render can be
    // abandoned before effects run, leaving the eager instance destroyed.
    immediatelyRender: false,
    extensions: [StarterKit.configure({ link: { openOnClick: false, autolink: false } }), markdown, TaskList,
      TaskItem.configure({ nested: true, HTMLAttributes: { 'data-type': 'taskItem' }, a11y: { checkboxLabel: node => `${t('To-do list')}: ${node.textContent}` } }),
      TableKit, PrivateImage, NotebookTextStyleMark, NotebookStyleHtmlBlock, boundedMarkdown, folding],
    content: text, contentType: 'markdown', editable: !disabled && !reading,
    shouldRerenderOnTransaction: true,
    editorProps: {
      handleDOMEvents: { keydown: (view, event) => {
        if (!view.editable && (event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); return true; }
        return false;
      } },
      attributes: { role: 'textbox', tabindex: '0', 'aria-multiline': 'true', 'aria-label': label, class: 'notebook-rich-content' },
      handleKeyDown: (view, event) => {
        if ((event.ctrlKey || event.metaKey) && !view.editable && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); return true; }
        if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); callbacks.current.onSave(); return true; } return false;
      },
      // Pasted content never imports hidden HTML or remote assets. Markdown
      // syntax can still be pasted as formatted content with the same schema.
      handlePaste: (_view, event) => {
        const plain = event.clipboardData?.getData('text/plain');
        if (plain === undefined) return false;
        event.preventDefault(); editor?.commands.insertContent(plain, { contentType: 'markdown' }); return true;
      },
      handleDrop: () => true,
    },
    onUpdate: ({ editor: current, transaction }) => {
      // Focusing a loaded list/table may append an empty trailing paragraph.
      // That editor-only normalization is not a user edit: don't rewrite the
      // saved Markdown (or echo it through other views of this resource).
      if (!transaction.docChanged) return;
      const next = current.getMarkdown();
      setLimited(false); last.current = next; callbacks.current.onChange(next);
    },
    onBlur: () => {
      const currentText = last.current;
      if (currentText && currentText.trim()) {
        const firstLine = currentText.trim().split(/\r?\n/)[0]?.replace(/^#+\s*/, '') || label || 'Notebook';
        recordCardVersionSnapshot({
          scope,
          kind: 'notebook',
          resourceId: versionResourceId,
          payload: currentText,
          summary: `${firstLine.slice(0, 60)} (${currentText.length} chars)`,
        });
      }
      callbacks.current.onSave();
    },
  });
  useEffect(() => { if (editor && !editor.isDestroyed) editor.setEditable(!disabled && !reading, false); }, [editor, disabled, reading]);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const element = editor.view.dom;
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<RemoteDraft>).detail;
      if (disabled || !editor.isEditable || editor.getMarkdown().length + detail.text.length + 16 > NOTEBOOK_MAX_CHARS) return;
      const before = editor.getJSON();
      // Explicit text nodes: a phone draft cannot inject HTML, remote images or commands.
      editor.chain().focus('end').insertContent(detail.text.split(/\r?\n/).map(text => ({ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) }))).run();
      detail.result = JSON.stringify(before) !== JSON.stringify(editor.getJSON()) ? 'applied' : 'unavailable';
    };
    element.addEventListener('agentopsdeck:remote-draft', receive);
    return () => element.removeEventListener('agentopsdeck:remote-draft', receive);
  }, [editor, disabled]);
  useEffect(() => {
    if (!editor || editor.isDestroyed || text === last.current) return;
    last.current = text;
    editor.commands.setContent(text, { contentType: 'markdown', emitUpdate: false });
  }, [editor, text]);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    callbacks.current.onReady(() => { if (!editor.isDestroyed) editor.commands.focus(); });
    return () => callbacks.current.onReady(undefined);
  }, [editor]);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const element = editor.view.dom;
    const open = (event: MouseEvent) => {
      if (disabled || reading || editor.isDestroyed) return;
      event.preventDefault(); event.stopPropagation();
      const { from, to, empty } = editor.state.selection;
      setStyleOpen(false); setContextMessage('');
      setContextMenu({ x: event.clientX, y: event.clientY, hasSelection: !empty,
        selectedText: empty ? '' : editor.state.doc.textBetween(from, to, '\n'),
        isDark: Boolean(element.closest('.notebook-dark')), from, to, doc: editor.state.doc, source: text,
        scope: recoveryScope(), epoch: recoveryEpoch(), resourceId });
    };
    element.addEventListener('contextmenu', open, true);
    return () => element.removeEventListener('contextmenu', open, true);
  }, [editor, disabled, reading, text, resourceId]);
  if (!editor) return null;
  const restoreSelection = () => {
    const context = contextMenu;
    const live = liveSelection.current;
    if (!context || live.contextMenu !== context || live.disabled || live.reading || editor.isDestroyed
      || live.text !== context.source || live.resourceId !== context.resourceId) return false;
    if (context.doc !== editor.state.doc || context.source !== text
      || context.scope !== recoveryScope() || context.epoch !== recoveryEpoch() || context.resourceId !== resourceId) {
      setContextMenu(null); return false;
    }
    editor.commands.setTextSelection({ from: context.from, to: context.to });
    return true;
  };
  const archiveRange = contextMenu ? notebookSelectionRange(contextMenu.doc, contextMenu.from, contextMenu.to,
    doc => editor.markdown!.serialize(doc.toJSON()), contextMenu.source) : undefined;
  const copySelection = async (cut = false) => {
    const context = contextMenu;
    if (!context?.hasSelection || !restoreSelection()) return;
    try {
      let copied = false;
      if (navigator.clipboard?.writeText) {
        try { await navigator.clipboard.writeText(context.selectedText); copied = true; } catch {}
      }
      if (!copied) {
        if (!restoreSelection()) return;
        editor.view.focus();
        const plainCopy = (event: ClipboardEvent) => {
          if (!event.clipboardData) return;
          event.clipboardData.setData('text/plain', context.selectedText); event.preventDefault();
        };
        document.addEventListener('copy', plainCopy);
        try { copied = document.execCommand('copy'); }
        finally { document.removeEventListener('copy', plainCopy); }
      }
      if (!copied) throw new Error('Clipboard unavailable');
      if (cut && restoreSelection()) editor.chain().focus().deleteSelection().run();
      if (!editor.isDestroyed) setContextMessage(t('Copied'));
    } catch { if (!editor.isDestroyed) setContextMessage(t('Copy unavailable. Use Ctrl/Cmd+C.')); }
    if (!editor.isDestroyed && liveSelection.current.contextMenu === context) setContextMenu(null);
  };
  const style = editor.getAttributes('notebookTextStyle') as NotebookTextStyle;
  const applyStyle = (attrs: Partial<NotebookTextStyle>) => { if (!disabled && !reading && (!contextMenu || restoreSelection())) editor.chain().focus().setMark('notebookTextStyle', attrs).run(); };
  const actions = [
    { label: 'Bold', Icon: Bold, active: editor.isActive('bold'), run: () => editor.chain().focus().toggleBold().run() },
    { label: 'Italic', Icon: Italic, active: editor.isActive('italic'), run: () => editor.chain().focus().toggleItalic().run() },
    { label: 'Strikethrough', Icon: Strikethrough, active: editor.isActive('strike'), run: () => editor.chain().focus().toggleStrike().run() },
    { label: 'Heading', Icon: Heading2, active: editor.isActive('heading'), run: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: 'Bullet list', Icon: List, active: editor.isActive('bulletList'), run: () => editor.chain().focus().toggleBulletList().run() },
    { label: 'To-do list', Icon: ListTodo, active: editor.isActive('taskList'), run: () => editor.chain().focus().toggleTaskList().run() },
    { label: 'Code block', Icon: Code, active: editor.isActive('codeBlock'), run: () => editor.chain().focus().toggleCodeBlock().run() },
  ] as const;
  const currentBlock = editor.isActive('heading', { level: 1 }) ? 'h1' : editor.isActive('heading', { level: 2 }) ? 'h2' : editor.isActive('heading', { level: 3 }) ? 'h3' : editor.isActive('blockquote') ? 'quote' : 'p';
  const collectHeadings = () => {
    const headings: typeof outline = [];
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === 'heading' && headings.length < 200) headings.push({ position, title: node.textContent.slice(0, 160), level: Number(node.attrs.level) });
    });
    setOutline(headings);
    return headings;
  };
  const jumpToHeading = (position: number) => {
    setOutlineOpen(false);
    editor.view.dispatch(editor.state.tr.setMeta(notebookFoldKey, { reveal: position }));
    editor.chain().focus().setTextSelection(position + 1).scrollIntoView().run();
  };
  return <div className="notebook-rich-editor">
    <div className="notebook-format-bar" role="toolbar" aria-label={t('Note formatting')}>
      <button type="button" aria-label={t('Foldable reading mode')} title={t('Foldable reading mode')} aria-pressed={reading} disabled={disabled} onClick={() => {
        const next = !reading; setReading(next); setStyleOpen(false);
        editor.view.dispatch(editor.state.tr.setMeta(notebookFoldKey, { reading: next }));
      }}><ListTree size={15} /></button>
      {!reading && actions.map(({ label: name, Icon, active, run }) => <button key={name} type="button" aria-label={t(name)} title={t(name)} aria-pressed={active} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={run}><Icon size={15} /></button>)}
      <button ref={styleTrigger} type="button" aria-label={t('Text appearance')} title={t('Text appearance')} aria-expanded={styleOpen && !disabled} disabled={disabled || reading}
        onMouseDown={event => event.preventDefault()} onClick={() => setStyleOpen(value => !value)}><Type size={15} /></button>
      {!reading && <select className="notebook-block-select" name="notebookeditor-block-style" aria-label={t('Paragraph style')} disabled={disabled} value={currentBlock}
        onChange={event => {
          const value = event.target.value;
          if (value === 'h1') editor.chain().focus().setHeading({ level: 1 }).run();
          else if (value === 'h2') editor.chain().focus().setHeading({ level: 2 }).run();
          else if (value === 'h3') editor.chain().focus().setHeading({ level: 3 }).run();
          else if (value === 'quote') editor.chain().focus().toggleBlockquote().run();
          else editor.chain().focus().setParagraph().run();
        }}>
        <option value="p">{t('Paragraph')}</option><option value="h1">{t('Heading 1')}</option><option value="h2">{t('Heading 2')}</option>
        <option value="h3">{t('Heading 3')}</option><option value="quote">{t('Quote')}</option>
      </select>}
      <span />
      <button className="notebook-outline-trigger" ref={outlineTrigger} type="button" aria-label={t('Notebook contents')} title={t('Notebook contents')} aria-expanded={outlineOpen} disabled={disabled}
        onClick={() => {
          if (outlineOpen) { setOutlineOpen(false); return; }
          collectHeadings(); setOutlineOpen(true);
        }}><ListTree size={15} /></button>
      <button type="button" aria-label={t('Undo')} disabled={disabled || reading || !editor.can().undo()} onMouseDown={event => event.preventDefault()} onClick={() => editor.chain().focus().undo().run()}><Undo2 size={14} /></button>
      <button type="button" aria-label={t('Version history')} title={t('Version history')} disabled={disabled} onClick={() => setHistoryOpen(true)}><Clock3 size={14} /></button>
      <button type="button" aria-label={t('Redo')} disabled={disabled || reading || !editor.can().redo()} onMouseDown={event => event.preventDefault()} onClick={() => editor.chain().focus().redo().run()}><Redo2 size={14} /></button>
    </div>
    {outlineOpen && <NotebookPopover anchor={outlineTrigger} onClose={() => setOutlineOpen(false)} className="notebook-outline" label={t('Notebook contents')}>
      {!outline.length && <p>{t('Add headings to navigate this notebook.')}</p>}
      {outline.map(item => <button type="button" key={item.position} style={{ paddingInlineStart: `${Math.min(item.level, 6) * 8}px` }} onClick={() => jumpToHeading(item.position)}>{item.title || t('Heading')}</button>)}
      {outline.length === 200 && <p>{t('Showing the first 200 headings.')}</p>}
    </NotebookPopover>}
    <aside className={`notebook-hover-minimap ${outlineOpen ? 'is-open' : ''}`} aria-label={t('Quick outline minimap')} onMouseEnter={collectHeadings} onFocus={collectHeadings} onTouchStart={collectHeadings}>
      <div className="notebook-hover-minimap-rail" aria-hidden="true"><span style={{ width: '16px' }} /><span style={{ width: '11px' }} /><span style={{ width: '14px' }} /></div>
      <div className="notebook-hover-minimap-panel">
        {!outline.length && <small>{t('Add headings to navigate this notebook.')}</small>}
        {outline.map(item => <button type="button" key={item.position} style={{ paddingInlineStart: `${Math.min(item.level, 6) * 6}px` }} onClick={() => jumpToHeading(item.position)}>{item.title || t('Heading')}</button>)}
      </div>
    </aside>
    {styleOpen && !disabled && !reading && <NotebookPopover anchor={styleTrigger} onClose={() => setStyleOpen(false)} className="notebook-text-appearance" label={t('Text appearance')}>
      <div className="notebook-text-size-row"><label>{t('Text size')} <select name="notebookeditor-select-1" aria-label={t('Text size')} disabled={disabled} value={style.size ?? 100}
        onChange={event => applyStyle({ size: Number(event.target.value) === 100 ? null : Number(event.target.value) })}>
        {NOTE_TEXT_SIZES.map(size => <option key={size} value={size}>{size}%</option>)}
      </select></label>
        <button type="button" disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => editor.chain().focus().unsetMark('notebookTextStyle').run()}>{t('Reset text appearance')}</button>
        <button type="button" aria-label={t('Close text appearance')} onMouseDown={event => event.preventDefault()} onClick={() => setStyleOpen(false)}><X size={14} /></button>
      </div>
      <div className="notebook-text-size-row"><label>{t('Font family')} <select name="notebookeditor-font-family" aria-label={t('Font family')} value={style.font ?? ''}
        onChange={event => applyStyle({ font: event.target.value || null })}>
        <option value="">{t('Default font')}</option>
        {Object.keys(NOTE_TEXT_FONTS).map(font => <option key={font} value={font}>{t(font === 'sans' ? 'Sans serif' : font === 'serif' ? 'Serif' : 'Monospace')}</option>)}
      </select></label></div>
      {(['color', 'highlight'] as const).map(field => <div className="notebook-text-palette" key={field} role="group" aria-label={t(field === 'color' ? 'Text color' : 'Text highlight')}>
        <span>{t(field === 'color' ? 'Text color' : 'Text highlight')}</span>
        <button type="button" className="notebook-text-swatch notebook-text-default" disabled={disabled} aria-label={t(field === 'color' ? 'Default text color' : 'No highlight')}
          aria-pressed={!style[field]} onMouseDown={event => event.preventDefault()} onClick={() => applyStyle({ [field]: null })}>∅</button>
        {(field === 'color' ? NOTE_TEXT_COLORS : NOTE_HIGHLIGHTS).map(color => <button key={color} type="button" className="notebook-text-swatch" disabled={disabled}
          style={{ backgroundColor: color }} aria-label={t(field === 'color' ? 'Text color: {color}' : 'Highlight: {color}', { color })}
          title={color} aria-pressed={style[field] === color} onMouseDown={event => event.preventDefault()} onClick={() => applyStyle({ [field]: color })} />)}
      </div>)}
    </NotebookPopover>}
    <EditorContent editor={editor} />
    {contextMenu && !disabled && !reading && typeof document !== 'undefined' ? createPortal(
      <div
        ref={contextMenuRef}
        className="notebook-context-menu"
        data-testid="notebook-context-menu"
        data-notebook-dark={contextMenu.isDark ? 'true' : undefined}
        role="menu"
        aria-label={t('Note formatting')}
        style={{ left: contextMenu.x, top: contextMenu.y }}
        onPointerDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onKeyDown={(e) => handleContextMenuKeyDown(e, () => setContextMenu(null))}
      >
        <div className="notebook-ctx-row notebook-ctx-inline-actions">
          {actions.map(({ label: name, Icon, active, run }) => (
            <button
              key={name}
              type="button"
              role="menuitem"
              className={`notebook-ctx-icon-btn${active ? ' is-active' : ''}`}
              aria-label={t(name)}
              title={t(name)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { if (restoreSelection()) run(); setContextMenu(null); }}
            >
              <Icon size={14} />
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className="notebook-ctx-icon-btn"
            title={t('Reset text appearance')}
            aria-label={t('Reset text appearance')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (restoreSelection()) editor.chain().focus().unsetAllMarks().clearNodes().run();
              setContextMenu(null);
            }}
          >
            <X size={13} />
          </button>
        </div>

        <div className="notebook-ctx-row notebook-ctx-block-pills">
          {([
            { id: 'p', label: t('Paragraph'), run: () => editor.chain().focus().setParagraph().run() },
            { id: 'h1', label: 'H1', run: () => editor.chain().focus().toggleHeading({ level: 1 }).run() },
            { id: 'h2', label: 'H2', run: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
            { id: 'h3', label: 'H3', run: () => editor.chain().focus().toggleHeading({ level: 3 }).run() },
            { id: 'quote', label: t('Quote'), run: () => editor.chain().focus().toggleBlockquote().run() },
          ] as const).map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={`notebook-ctx-pill${currentBlock === item.id ? ' is-active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { if (restoreSelection()) item.run(); setContextMenu(null); }}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="notebook-ctx-row notebook-ctx-size-pills">
          <span className="notebook-ctx-label">{t('Text size')}</span>
          {NOTE_TEXT_SIZES.map((sz) => (
            <button
              key={sz}
              type="button"
              role="menuitem"
              className={`notebook-ctx-pill${(style.size ?? 100) === sz ? ' is-active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                applyStyle({ size: sz === 100 ? null : sz });
                setContextMenu(null);
              }}
            >
              {sz}%
            </button>
          ))}
        </div>

        <div className="notebook-ctx-row notebook-ctx-block-pills" aria-label={t('Font family')}>
          {(['', ...Object.keys(NOTE_TEXT_FONTS)]).map(font => <button key={font} type="button" role="menuitem"
            className={`notebook-ctx-pill${(style.font ?? '') === font ? ' is-active' : ''}`} onMouseDown={event => event.preventDefault()}
            onClick={() => { applyStyle({ font: font || null }); setContextMenu(null); }}>
            {t(!font ? 'Default font' : font === 'sans' ? 'Sans serif' : font === 'serif' ? 'Serif' : 'Monospace')}
          </button>)}
        </div>
        <div className="notebook-ctx-palette">
          <span className="notebook-ctx-label">{t('Text color')}</span>
          <div className="notebook-ctx-swatches">
            <button
              type="button"
              className={`notebook-text-swatch notebook-text-default${!style.color ? ' is-active' : ''}`}
              title={t('Default text color')}
              aria-label={t('Default text color')}
              aria-pressed={!style.color}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { applyStyle({ color: null }); setContextMenu(null); }}
            >
              ∅
            </button>
            {NOTE_TEXT_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={`notebook-text-swatch${style.color === color ? ' is-active' : ''}`}
                style={{ backgroundColor: color }}
                title={color}
                aria-label={t('Text color: {color}', { color })}
                aria-pressed={style.color === color}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { applyStyle({ color }); setContextMenu(null); }}
              />
            ))}
          </div>
        </div>

        <div className="notebook-ctx-palette">
          <span className="notebook-ctx-label">{t('Text highlight')}</span>
          <div className="notebook-ctx-swatches">
            <button
              type="button"
              className={`notebook-text-swatch notebook-text-default${!style.highlight ? ' is-active' : ''}`}
              title={t('No highlight')}
              aria-label={t('No highlight')}
              aria-pressed={!style.highlight}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { applyStyle({ highlight: null }); setContextMenu(null); }}
            >
              ∅
            </button>
            {NOTE_HIGHLIGHTS.map((color) => (
              <button
                key={color}
                type="button"
                className={`notebook-text-swatch${style.highlight === color ? ' is-active' : ''}`}
                style={{ backgroundColor: color }}
                title={color}
                aria-label={t('Highlight: {color}', { color })}
                aria-pressed={style.highlight === color}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { applyStyle({ highlight: color }); setContextMenu(null); }}
              />
            ))}
          </div>
        </div>

        {contextMenu.hasSelection && contextMenu.selectedText ? (
          <div className="notebook-ctx-row notebook-ctx-clipboard">
            <button
              type="button"
              role="menuitem"
              className="notebook-ctx-action-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void copySelection()}
            >
              <Copy size={13} aria-hidden="true" />
              <span>{t('Copy')}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="notebook-ctx-action-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void copySelection(true)}
            >
              <Scissors size={13} aria-hidden="true" />
              <span>{t('Cut')}</span>
            </button>
            {onArchive && <button type="button" role="menuitem" className="notebook-ctx-action-btn"
              disabled={disabled || reading || !archiveRange} title={!archiveRange ? t('This selection cannot be moved safely. Use the archive text selector.') : undefined}
              onMouseDown={event => event.preventDefault()} onClick={() => {
                const context = contextMenu;
                if (archiveRange && restoreSelection()) {
                  onArchive({ source: context.source, ...archiveRange, requestId: crypto.randomUUID(), scope: context.scope, epoch: context.epoch, resourceId: context.resourceId });
                  setContextMenu(null);
                }
              }}>{t('Archive selected text')}</button>}
          </div>
        ) : null}
      </div>,
      document.body,
    ) : null}
    {contextMessage && <p role="status">{contextMessage}</p>}
    {limited && <p role="alert">{t('Note is too long. Shorten it before adding more.')}</p>}
    {historyOpen ? (
      <Suspense fallback={null}>
        <CardVersionHistoryModal
          scope={scope}
          kind="notebook"
          resourceId={versionResourceId}
          currentPayload={last.current}
          disabled={disabled || reading}
          onRestore={(payload) => {
            last.current = payload;
            editor.commands.setContent(payload, { contentType: 'markdown', emitUpdate: false });
            callbacks.current.onChange(payload);
            callbacks.current.onSave();
          }}
          onClose={() => setHistoryOpen(false)}
        />
      </Suspense>
    ) : null}
  </div>;
}
