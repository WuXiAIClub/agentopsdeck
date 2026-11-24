import { lazy, Suspense, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { recordCardVersionSnapshot } from '../lib/card-version-history';
const CardVersionHistoryModal = lazy(() => import('./CardVersionHistoryModal'));
import { Plus, Minus, Save, RefreshCw, Trash2, Undo2, Download, Upload, FolderOpen, GitBranch, Network, Clock3 } from 'lucide-react';
import { DRAWING_CANVAS, DRAWING_MAX_BODY_BYTES, DRAWING_MAX_DOCUMENTS, DRAWING_MAX_NODES, DRAWING_MAX_STROKES, drawingContent, validDrawingContent, type DrawingContent, type DrawingWrite, type DrawingDocument, type DrawingSummary, type DrawingPoint } from '@agentopsdeck/shared';
import { api, ApiResponseError, recoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import { usePageRefreshGuard } from '../lib/use-page-refresh-guard';
import { drawingDraftKey, drawingEqual, parseDrawingDraft, reconcileDrawing, importDrawing, removeDrawingNode, drawingTextColor } from '../lib/workspace-drawing';
import { addMindmapTopic, arrangeMindmap, type MindmapResult } from '../lib/workspace-mindmap';
import { exportDrawio, importDrawio } from '../lib/workspace-drawio';
import { useWorkspaceBoardRevision } from '../lib/use-workspace-board-revision';
import { appendInkPoint, inkBudget, inkPath } from '../lib/workspace-ink';
import { ResourceTitle, ResourceToolbar } from './ResourceToolbar';

/** Pure SVG/text: no foreignObject, remote embeds, render loop or chat polling. */
export default function WorkspaceDrawing({ scope, resourceId, onOpen }: { scope: string; resourceId: string; onOpen: (kind: 'drawing', id: string) => void }) {
  const { t } = useI18n();
  const [document, setDocument] = useState<DrawingDocument>();
  const [draft, setDraft] = useState<DrawingWrite>();
  const [busy, setBusy] = useState(false), lock = useRef(false), alive = useRef(true);
  const [error, setError] = useState<'' | 'load' | 'conflict' | 'uncertain'>('');
  const [storageError, setStorageError] = useState(false), [invalid, setInvalid] = useState(false);
  const [drawingError, setDrawingError] = useState<'' | 'not-tree' | 'too-large' | 'drawio'>('');
  const [discard, setDiscard] = useState(false), [generation, setGeneration] = useState(0);
  const [selected, setSelected] = useState<string>(), [target, setTarget] = useState('');
  const [undo, setUndo] = useState<DrawingContent[]>([]);
  const [zoom, setZoom] = useState(.8);
  const nodesById = useMemo(() => new Map(draft?.nodes.map(node => [node.id, node])), [draft?.nodes]);
  const [catalog, setCatalog] = useState<DrawingSummary[]>(), [catalogError, setCatalogError] = useState(false), [catalogOpen, setCatalogOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const catalogDialog = useRef<HTMLDialogElement>(null);
  const file = useRef<HTMLInputElement>(null), canvas = useRef<SVGSVGElement>(null);
  const [moving, setMoving] = useState<{ id: string; x: number; y: number }>();
  const drag = useRef<{ id: string; pointer: number; x: number; y: number; originalX: number; originalY: number } | undefined>(undefined);
  const [pen, setPen] = useState(false), [penColor, setPenColor] = useState('#60a5fa'), [penWidth, setPenWidth] = useState(4);
  const [inking, setInking] = useState(false), [inkLimit, setInkLimit] = useState(false), [inkExport, setInkExport] = useState(false);
  const [selectedStroke, setSelectedStroke] = useState<string>();
  const ink = useRef<{ pointer: number; points: DrawingPoint[]; limit: number } | undefined>(undefined);
  const inkPreview = useRef<SVGPathElement>(null), inkFrame = useRef<number | undefined>(undefined);
  const strokePaths = useMemo(() => (draft?.strokes ?? []).map(stroke => inkPath(stroke.points)), [draft?.strokes]);
  useEffect(() => () => { if (inkFrame.current !== undefined) cancelAnimationFrame(inkFrame.current); ink.current = undefined; }, []);
  const key = drawingDraftKey(scope, resourceId);
  const observed = useWorkspaceBoardRevision(scope, resourceId, 'drawing');
  const attemptedRemote = useRef('');
  const validIdentity = () => alive.current && scope === recoveryScope();
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController(); let live = true;
    lock.current = true; setBusy(true);
    void api.workspaceDrawing(resourceId, controller.signal).then(remote => {
      if (!live || scope !== recoveryScope()) return;
      let local: DrawingWrite | undefined;
      try { local = parseDrawingDraft(sessionStorage.getItem(key)); } catch { setStorageError(true); }
      recordCardVersionSnapshot({ scope, kind: 'drawing', resourceId, revision: remote.revision, payload: JSON.stringify(drawingContent(remote)), summary: `${remote.title || 'Whiteboard'} (${remote.nodes.length} cards)` });
      const restored = reconcileDrawing(remote, local, crypto.randomUUID());
      setDocument(remote); setDraft(restored.draft); setError(restored.conflict ? 'conflict' : ''); setUndo([]); setSelected(undefined); setSelectedStroke(undefined);
    }).catch(() => { if (live) setError('load'); }).finally(() => { if (live) { lock.current = false; setBusy(false); } });
    return () => { live = false; controller.abort(); };
  }, [scope, resourceId, key, generation]);
  useEffect(() => {
    if (!catalogOpen) return;
    catalogDialog.current?.showModal();
    const controller = new AbortController(); let live = true;
    setCatalog(undefined); setCatalogError(false);
    void api.workspaceDrawings(controller.signal).then(result => { if (live && scope === recoveryScope()) setCatalog(result.drawings); })
      .catch(() => { if (live) setCatalogError(true); });
    return () => { live = false; controller.abort(); };
  }, [catalogOpen, scope]);
  const persist = (value: DrawingWrite) => {
    try { sessionStorage.setItem(key, JSON.stringify(value)); setStorageError(false); } catch { setStorageError(true); }
  };
  const edit = (value: DrawingContent, remember = true) => {
    if (!draft || lock.current || !validIdentity() || error === 'uncertain' || error === 'load') return;
    if (!validDrawingContent(drawingContent(value), true)) { setInvalid(true); return; }
    if (drawingEqual(draft, value)) return;
    if ((value.strokes ?? []).reduce((n, s) => n + s.points.length, 0) < (draft.strokes ?? []).reduce((n, s) => n + s.points.length, 0)) setInkLimit(false);
    if (!value.strokes?.some(s => s.id === selectedStroke)) setSelectedStroke(undefined);
    if (!value.strokes?.length) setInkExport(false);
    if (remember) setUndo(history => [...history.slice(-19), drawingContent(draft)]);
    const next = { ...drawingContent(value), revision: draft.revision, mutationId: crypto.randomUUID() };
    setDraft(next); persist(next); setInvalid(false); setDrawingError('');
  };
  const save = async () => {
    if (!draft || ink.current || !validDrawingContent(drawingContent(draft)) || lock.current || !validIdentity() || error === 'conflict' || error === 'load') return;
    lock.current = true; setBusy(true); persist(draft);
    try {
      const saved = await api.saveWorkspaceDrawing(resourceId, draft);
      if (!validIdentity()) return;
      setDocument(saved); setDraft({ ...drawingContent(saved), revision: saved.revision, mutationId: crypto.randomUUID() }); setError('');
      recordCardVersionSnapshot({ scope, kind: 'drawing', resourceId, revision: saved.revision, payload: JSON.stringify(drawingContent(saved)), summary: `${saved.title || 'Whiteboard'} (${saved.nodes.length} cards)` });
      try { sessionStorage.removeItem(key); setStorageError(false); } catch { setStorageError(true); }
    } catch (cause) { if (validIdentity()) setError(cause instanceof ApiResponseError && cause.status === 409 ? 'conflict' : 'uncertain'); }
    finally { lock.current = false; if (validIdentity()) setBusy(false); }
  };
  const dirty = !!draft && !!document && !drawingEqual(draft, document);
  usePageRefreshGuard(() => !dirty && !busy && !lock.current && !storageError && !drag.current && !ink.current && !inking);
  useEffect(() => {
    if (busy || lock.current || drag.current || moving || ink.current || inking || scope !== recoveryScope() || !observed.revision
      || (document && observed.revision <= document.revision) || error === 'uncertain') return;
    if (dirty) { setError('conflict'); return; }
    const attempt = JSON.stringify([key, observed.revision, observed.notice]);
    if (attemptedRemote.current === attempt) return;
    attemptedRemote.current = attempt;
    if (document) try { sessionStorage.removeItem(key); } catch { setStorageError(true); return; }
    setGeneration(value => value + 1);
  }, [observed.revision, observed.notice, document, busy, moving, inking, dirty, error, scope, key]);
  const disabled = busy || inking || error === 'uncertain' || error === 'load';
  const chosen = draft?.nodes.find(node => node.id === selected);
  const point = (event: PointerEvent<SVGSVGElement | SVGGElement>) => {
    const matrix = canvas.current?.getScreenCTM();
    return matrix ? new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()) : null;
  };
  const cancelInk = () => {
    if (inkFrame.current !== undefined) cancelAnimationFrame(inkFrame.current);
    inkFrame.current = undefined; ink.current = undefined;
    inkPreview.current?.setAttribute('d', ''); setInking(false);
  };
  const sampleInk = (event: PointerEvent<SVGSVGElement>) => {
    const stroke = ink.current, p = point(event);
    if (!stroke || event.pointerId !== stroke.pointer || !p) return;
    const changed = appendInkPoint(stroke.points, p.x, p.y, stroke.limit);
    if (stroke.points.length >= stroke.limit) setInkLimit(true);
    if (changed && inkFrame.current === undefined) inkFrame.current = requestAnimationFrame(() => {
      inkFrame.current = undefined;
      if (ink.current) inkPreview.current?.setAttribute('d', inkPath(ink.current.points));
    });
  };
  const exportFile = (format: 'json' | 'drawio' = 'json') => {
    if (!draft || ink.current || !validIdentity()) return;
    if (format === 'drawio' && draft.strokes?.length) { setInkExport(true); return; }
    let text: string;
    try { text = format === 'drawio' ? exportDrawio(draft) : JSON.stringify(drawingContent(draft)); }
    catch { setDrawingError('drawio'); return; }
    const url = URL.createObjectURL(new Blob([text], { type: format === 'drawio' ? 'application/xml' : 'application/json' }));
    const anchor = window.document.createElement('a'); anchor.href = url; anchor.download = `agentopsdeck-whiteboard.${format}`; anchor.click();
    // Download consumes the URL asynchronously in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const applyMindmap = (result: MindmapResult) => {
    if (!result.ok) { setDrawingError(result.reason); return false; }
    edit(result.content); setDrawingError(''); return true;
  };
  const addTopic = (kind: 'child' | 'sibling') => {
    if (!draft || disabled || !validIdentity()) return;
    const id = crypto.randomUUID();
    if (applyMindmap(addMindmapTopic(draft, selected, kind, t(draft.nodes.length ? 'New topic' : 'Main topic'), id, crypto.randomUUID()))) setSelected(id);
  };
  const titleControl = <input name="workspacedrawing-input-1" className="workspace-drawing-title" aria-label={t('Drawing title')} maxLength={160} value={draft?.title ?? ''} disabled={!draft || disabled} onChange={e => draft && edit({ ...draft, title: e.target.value })} />;
  const fileControls = <>
      <button type="button" title={t('Version history')} aria-label={t('Version history')} disabled={!draft || inking} onClick={() => setHistoryOpen(true)}><Clock3 size={15} /></button>
      <button type="button" title={t('Open drawing')} aria-label={t('Open drawing')} disabled={inking} onClick={() => setCatalogOpen(true)}><FolderOpen size={15} /></button>
      <button type="button" title={t('Refresh drawing')} aria-label={t('Refresh drawing')} disabled={busy || inking} onClick={() => dirty || error === 'uncertain' ? setDiscard(true) : setGeneration(n => n + 1)}><RefreshCw size={15} /></button>
      <button type="button" title={t(error === 'uncertain' ? 'Retry same save' : 'Save')} aria-label={t(error === 'uncertain' ? 'Retry same save' : 'Save')} disabled={!draft || !draft.title.trim() || busy || inking || error === 'conflict' || error === 'load' || (!dirty && error !== 'uncertain' && document?.revision !== 0)} onClick={() => void save()}><Save size={15} /></button>
    </>;
  return <section className="workspace-drawing" aria-label={t('Whiteboard')}>
    <ResourceTitle>{titleControl}</ResourceTitle><ResourceToolbar>{fileControls}</ResourceToolbar>
    <div className="workspace-drawing-state" role="status">{t(busy ? 'Loading…' : dirty ? 'Unsaved changes' : document?.revision ? 'Saved' : 'Whiteboard · Preview')}</div>
    {storageError && <p role="alert">{t('Local draft storage unavailable. Keep this panel open until saved.')}</p>}
    {error && <p role="alert">{t(error === 'conflict' ? 'Drawing changed elsewhere. Export your draft before discarding and reloading.' : error === 'uncertain' ? 'Save outcome unconfirmed. Retry the same save safely, or check by reloading.' : 'Unable to load drawing. Retry refresh.')}</p>}
    {invalid && <p role="alert">{t('Invalid drawing or drawing size limit reached.')}</p>}
    {inkLimit && <p role="status">{t('Stroke limit reached. Only the visible ink will be kept. Start a new stroke or remove old strokes.')}</p>}
    {inkExport && <p role="alert">{t('Freehand ink needs JSON export. The limited draw.io converter cannot preserve these strokes.')}<button type="button" onClick={() => setInkExport(false)}>{t('Close')}</button></p>}
    {drawingError && <p role="alert">{t(drawingError === 'not-tree' ? 'Mind maps need a tree: remove cycles or multiple parents first. Your drawing was not changed.' : drawingError === 'too-large' ? 'This mind map does not fit the canvas. Reduce cards or branches before arranging. Your drawing was not changed.' : 'Unsupported draw.io file or XML text. Only single-page, uncompressed AgentOpsDeck-compatible cards and lines can be imported; rich shapes, HTML and images are not converted.')}</p>}
    {discard && <div className="workspace-board-confirm" role="group" aria-label={t('Discard local changes?')}><span>{t('Discard local changes?')}</span><button type="button" onClick={() => setDiscard(false)}>{t('Cancel')}</button><button type="button" onClick={() => {
      if (!validIdentity()) return;
      try { sessionStorage.removeItem(key); } catch { setStorageError(true); return; }
      setDiscard(false); setGeneration(n => n + 1);
    }}>{t('Discard and reload')}</button></div>}
    {draft && <>
      <div className="workspace-drawing-tools">
        <button type="button" aria-pressed={!pen} disabled={disabled} onClick={() => setPen(false)}>{t('Select shapes')}</button>
        <button type="button" aria-pressed={pen} disabled={disabled} onClick={() => { setPen(true); setSelected(undefined); setSelectedStroke(undefined); }}>{t('Freehand pen')}</button>
        {pen && <><input name="workspacedrawing-input-2" type="color" aria-label={t('Ink color')} disabled={disabled} value={penColor} onChange={e => setPenColor(e.target.value)} />
          <select name="workspacedrawing-select-3" aria-label={t('Ink width')} disabled={disabled} value={penWidth} onChange={e => setPenWidth(Number(e.target.value))}>{[2, 4, 8].map(width => <option key={width} value={width}>{`${width}px`}</option>)}</select></>}
        {selectedStroke && !pen && <button type="button" disabled={disabled} onClick={() => { edit({ ...draft, strokes: (draft.strokes ?? []).filter(s => s.id !== selectedStroke) }); setSelectedStroke(undefined); }}><Trash2 size={15} />{t('Remove stroke')}</button>}
        <button type="button" disabled={disabled || draft.nodes.length >= DRAWING_MAX_NODES} onClick={() => {
          const id = crypto.randomUUID(), n = draft.nodes.length;
          edit({ ...draft, nodes: [...draft.nodes, { id, x: 60 + n % 6 * 225, y: 60 + Math.floor(n / 6) % 7 * 120, width: 200, height: 100, text: t('New card'), color: '#dbeafe' }] }); setSelected(id);
        }}><Plus size={15} />{t('Add card')}</button>
        <button type="button" aria-label={t('Undo')} disabled={disabled || !undo.length} onClick={() => { const previous = undo.at(-1); if (previous) { edit(previous, false); setUndo(items => items.slice(0, -1)); } }}><Undo2 size={15} /></button>
        <button type="button" aria-label={t('Zoom out drawing')} disabled={inking || zoom <= .25} onClick={() => setZoom(n => Math.max(.25, n - .1))}><Minus size={14} /></button>
        <span className="workspace-drawing-zoom">{Math.round(zoom * 100)}%</span>
        <button type="button" aria-label={t('Zoom in drawing')} disabled={inking || zoom >= 2} onClick={() => setZoom(n => Math.min(2, n + .1))}><Plus size={14} /></button>
        <button type="button" disabled={inking} onClick={() => setZoom(Math.max(.25, Math.min(2, (canvas.current?.parentElement?.clientWidth ?? 1280) / DRAWING_CANVAS.width)))}>{t('Fit drawing')}</button>
        <button type="button" disabled={inking} aria-label={t('Export drawing')} title={t('Export drawing')} onClick={() => exportFile()}><Download size={15} /></button>
        <button type="button" disabled={inking} aria-label={t('Export draw.io file')} title={t('Export draw.io file')} onClick={() => exportFile('drawio')}>{t('draw.io')}</button>
        <button type="button" aria-label={t('Import drawing')} title={t('Import drawing')} disabled={disabled} onClick={() => file.current?.click()}><Upload size={15} /></button>
        <input name="workspacedrawing-input-4" type="file" ref={file} hidden accept=".json,.drawio,.xml,application/json,application/xml,text/xml" onChange={async e => {
          const selectedFile = e.target.files?.[0]; e.target.value = ''; if (!selectedFile || !draft) return;
          if (disabled || !validIdentity()) return;
          if (selectedFile.size > DRAWING_MAX_BODY_BYTES) { setInvalid(true); return; }
          // Lock while reading so a slow import cannot overwrite intervening edits.
          lock.current = true; setBusy(true);
          const xml = /\.(drawio|xml)$/i.test(selectedFile.name);
          try { const text = await selectedFile.text(); const imported = xml ? importDrawio(text) : importDrawing(text); lock.current = false; if (validIdentity()) { edit(imported); setSelected(undefined); } }
          catch { if (validIdentity()) { if (xml) setDrawingError('drawio'); else setInvalid(true); } }
          finally { lock.current = false; if (validIdentity()) setBusy(false); }
        }} />
      </div>
      <div className="workspace-drawing-mindmap-tools" role="group" aria-label={t('Mind map')}>
        <span><GitBranch size={14} />{t('Mind map')}</span>
        {!draft.nodes.length ? <button type="button" disabled={disabled} onClick={() => addTopic('child')}>{t('Start mind map')}</button> : <>
          <button type="button" disabled={disabled || !chosen} onClick={() => addTopic('child')}>{t('Add child topic')}</button>
          <button type="button" disabled={disabled || !chosen} onClick={() => addTopic('sibling')}>{t('Add sibling topic')}</button>
          <button type="button" disabled={disabled} onClick={() => applyMindmap(arrangeMindmap(draft))}><Network size={14} />{t('Arrange mind map')}</button>
        </>}
      </div>
      <div className="workspace-drawing-viewport">
        <svg ref={canvas} tabIndex={0} data-pen={pen} style={{ width: DRAWING_CANVAS.width * zoom, height: DRAWING_CANVAS.height * zoom }} viewBox={`0 0 ${DRAWING_CANVAS.width} ${DRAWING_CANVAS.height}`} aria-label={t('Drawing canvas')}
          onKeyDown={e => { if (e.key === 'Escape') cancelInk(); }}
          onPointerDownCapture={e => {
            if (!pen) return;
            e.preventDefault(); e.stopPropagation();
            if (disabled || ink.current || e.button !== 0 || !validIdentity()) return;
            const p = point(e), limit = inkBudget(draft);
            if (!p) return;
            if (!limit || (draft.strokes?.length ?? 0) >= DRAWING_MAX_STROKES) { setInkLimit(true); return; }
            const points: DrawingPoint[] = []; appendInkPoint(points, p.x, p.y, limit);
            ink.current = { pointer: e.pointerId, points, limit }; setInking(true); setInkLimit(false);
            e.currentTarget.focus({ preventScroll: true }); e.currentTarget.setPointerCapture(e.pointerId); inkPreview.current?.setAttribute('d', inkPath(points));
          }} onPointerDown={e => { if (e.target === e.currentTarget) { setSelected(undefined); setSelectedStroke(undefined); } }}
          onPointerMove={e => { if (ink.current) { sampleInk(e); return; } const gesture = drag.current, p = point(e), node = draft.nodes.find(n => n.id === gesture?.id); if (!gesture || e.pointerId !== gesture.pointer || !p || !node) return;
            setMoving({ id: node.id, x: Math.round(Math.max(0, Math.min(DRAWING_CANVAS.width - node.width, gesture.originalX + p.x - gesture.x))), y: Math.round(Math.max(0, Math.min(DRAWING_CANVAS.height - node.height, gesture.originalY + p.y - gesture.y))) });
          }} onPointerUp={e => {
            if (ink.current?.pointer === e.pointerId) {
              sampleInk(e); const points = ink.current.points;
              edit({ ...draft, strokes: [...(draft.strokes ?? []), { id: crypto.randomUUID(), color: penColor, width: penWidth, points }] }); cancelInk(); return;
            }
            if (drag.current?.pointer !== e.pointerId) return; if (moving) edit({ ...draft, nodes: draft.nodes.map(n => n.id === moving.id ? { ...n, x: moving.x, y: moving.y } : n) }); drag.current = undefined; setMoving(undefined);
          }} onPointerCancel={e => { if (ink.current?.pointer === e.pointerId) cancelInk(); if (drag.current?.pointer === e.pointerId) { drag.current = undefined; setMoving(undefined); } }} onLostPointerCapture={e => { if (ink.current?.pointer === e.pointerId) cancelInk(); if (drag.current?.pointer === e.pointerId) { drag.current = undefined; setMoving(undefined); } }}>
          {draft.edges.map(edge => { const from = nodesById.get(edge.from)!, to = nodesById.get(edge.to)!;
            const a = moving?.id === from.id ? { ...from, ...moving } : from, b = moving?.id === to.id ? { ...to, ...moving } : to;
            return <line key={edge.id} x1={a.x + a.width / 2} y1={a.y + a.height / 2} x2={b.x + b.width / 2} y2={b.y + b.height / 2} className="workspace-drawing-edge" />;
          })}
          {draft.nodes.map(node => <g key={node.id} role="button" tabIndex={disabled || pen ? -1 : 0} aria-label={node.text || t('Drawing card')} data-selected={node.id === selected} transform={`translate(${moving?.id === node.id ? moving.x : node.x},${moving?.id === node.id ? moving.y : node.y})`}
            onFocus={() => { setSelected(node.id); setSelectedStroke(undefined); }} onKeyDown={e => {
              if (disabled || pen) return;
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(node.id); }
              const dx = e.key === 'ArrowLeft' ? -10 : e.key === 'ArrowRight' ? 10 : 0, dy = e.key === 'ArrowUp' ? -10 : e.key === 'ArrowDown' ? 10 : 0;
              if (dx || dy) { e.preventDefault(); edit({ ...draft, nodes: draft.nodes.map(n => n.id === node.id ? { ...n, x: Math.max(0, Math.min(DRAWING_CANVAS.width - n.width, n.x + dx)), y: Math.max(0, Math.min(DRAWING_CANVAS.height - n.height, n.y + dy)) } : n) }); }
            }} onPointerDown={e => { if (disabled || pen || e.button !== 0) return; e.preventDefault(); e.stopPropagation(); setSelected(node.id); setSelectedStroke(undefined); const p = point(e); if (!p) return;
              drag.current = { id: node.id, pointer: e.pointerId, x: p.x, y: p.y, originalX: node.x, originalY: node.y }; e.currentTarget.setPointerCapture(e.pointerId);
              setMoving({ id: node.id, x: node.x, y: node.y });
            }}>
            <rect width={node.width} height={node.height} rx={10} fill={node.color} />
            {node.text.split('\n').flatMap(line => line.match(/.{1,16}/gu) ?? ['']).slice(0, 3).map((line, index) => <text key={index} style={{ fill: drawingTextColor(node.color) }} x={14} y={27 + index * 24}>{line}</text>)}
          </g>)}
          {(draft.strokes ?? []).map((stroke, index) => <path key={stroke.id} className="workspace-drawing-ink" data-selected={selectedStroke === stroke.id} d={strokePaths[index]} stroke={stroke.color} strokeWidth={stroke.width} fill="none" strokeLinecap="round" strokeLinejoin="round"
            role="button" tabIndex={disabled || pen ? -1 : 0} aria-label={`${t('Ink stroke')} ${index + 1}`} onFocus={() => { setSelectedStroke(stroke.id); setSelected(undefined); }}
            onPointerDown={e => { if (disabled || pen) return; e.stopPropagation(); setSelectedStroke(stroke.id); setSelected(undefined); }}
            onKeyDown={e => { if (!disabled && ['Delete', 'Backspace'].includes(e.key)) { e.preventDefault(); edit({ ...draft, strokes: (draft.strokes ?? []).filter(s => s.id !== stroke.id) }); setSelectedStroke(undefined); } }} />)}
          <path ref={inkPreview} className="workspace-drawing-ink-preview" stroke={penColor} strokeWidth={penWidth} fill="none" strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
        </svg>
      </div>
      {chosen && <div className="workspace-drawing-inspector">
        <textarea name="workspacedrawing-textarea-5" aria-label={t('Card text')} maxLength={2000} rows={2} disabled={disabled} value={chosen.text} onChange={e => edit({ ...draft, nodes: draft.nodes.map(n => n.id === chosen.id ? { ...n, text: e.target.value } : n) })} />
        <input name="workspacedrawing-input-6" type="color" aria-label={t('Card color')} disabled={disabled} value={chosen.color} onChange={e => edit({ ...draft, nodes: draft.nodes.map(n => n.id === chosen.id ? { ...n, color: e.target.value } : n) })} />
        <button type="button" aria-label={t('Remove card')} disabled={disabled} onClick={() => { edit(removeDrawingNode(draft, chosen.id)); setSelected(undefined); }}><Trash2 size={15} /></button>
        <select name="workspacedrawing-select-7" aria-label={t('Connect to card')} disabled={disabled} value={target} onChange={e => setTarget(e.target.value)}><option value="">{t('Connect to card')}</option>{draft.nodes.filter(n => n.id !== chosen.id).map((n, i) => <option key={n.id} value={n.id}>{n.text.slice(0, 50) || `${i + 1}`}</option>)}</select>
        <button type="button" disabled={disabled || !draft.nodes.some(n => n.id === target && n.id !== chosen.id) || draft.edges.some(e => e.from === chosen.id && e.to === target)} onClick={() => edit({ ...draft, edges: [...draft.edges, { id: crypto.randomUUID(), from: chosen.id, to: target }] })}>{t('Connect')}</button>
        <button type="button" disabled={disabled || !draft.edges.some(e => e.from === chosen.id || e.to === chosen.id)} onClick={() => edit({ ...draft, edges: draft.edges.filter(e => e.from !== chosen.id && e.to !== chosen.id) })}>{t('Disconnect card')}</button>
      </div>}
    </>}
    {catalogOpen && <dialog ref={catalogDialog} className="workspace-board-picker" aria-label={t('Open drawing')} onCancel={() => setCatalogOpen(false)} onClick={e => { if (e.target === e.currentTarget) setCatalogOpen(false); }}>
      <header><h2>{t('Open drawing')}</h2><button type="button" onClick={() => setCatalogOpen(false)}>{t('Close')}</button></header>
      {catalogError ? <p role="alert">{t('Unable to load drawing. Retry refresh.')}</p> : !catalog ? <p>{t('Loading…')}</p> : <div className="workspace-board-picker-list">{catalog.map(item => <button key={item.resourceId} type="button" onClick={() => { if (validIdentity()) { setCatalogOpen(false); onOpen('drawing', item.resourceId); } }}>{item.title}</button>)}</div>}
      <button type="button" disabled={!catalog || catalog.length >= DRAWING_MAX_DOCUMENTS} onClick={() => { if (validIdentity()) { setCatalogOpen(false); onOpen('drawing', crypto.randomUUID()); } }}>{t('New drawing')}</button>
    </dialog>}
    {historyOpen && draft ? (
      <Suspense fallback={null}>
        <CardVersionHistoryModal
          scope={scope}
          kind="drawing"
          resourceId={resourceId}
          currentPayload={JSON.stringify(drawingContent(draft))}
          disabled={disabled}
          onRestore={(payload) => {
            try {
              const parsed = JSON.parse(payload) as DrawingContent;
              if (parsed && validDrawingContent(parsed, true)) {
                edit(parsed);
              }
            } catch {
              // Ignore invalid payload
            }
          }}
          onClose={() => setHistoryOpen(false)}
        />
      </Suspense>
    ) : null}
  </section>;
}
