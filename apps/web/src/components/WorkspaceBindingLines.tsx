import { memo, useCallback, useEffect, useId, useMemo, useState, type RefObject } from 'react';
import { api, recoveryScope } from '../api';
import { isSessionPane, type Pane } from '../lib/workspace-layout';
import { fileCardPaneResource } from '../lib/workspace-file-card-pane';
import type { FileBoardBinding } from '../lib/workspace-file-board';
import { workspaceResourceEvents } from '../lib/workspace-resource-events';
import {
  bindingCurve,
  bindingEdges,
  bindingGroupColor,
  type BindingEdge,
  type BindingRect,
} from '../lib/workspace-binding-lines';
import { fileLinkEdges } from '../lib/workspace-file-links';

type Link = { paneId: string; binding: FileBoardBinding | null };
type Source = { key: string; paneId: string; resource: string; legacy: boolean };

type RenderedBindingCurve = {
  key: string;
  d: string;
  groupId: string;
  stroke: string;
  secondary: string;
  glow: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
};

function parseEndpoints(d: string): { startX: number; startY: number; endX: number; endY: number } | null {
  const m = /^M\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+C\s+[^,]+,\s*[^,]+,\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/.exec(d.trim());
  if (!m) return null;
  return {
    startX: Number(m[1]),
    startY: Number(m[2]),
    endX: Number(m[3]),
    endY: Number(m[4]),
  };
}

/** Only metadata, once on mount and when the existing owner SSE invalidates it.
 * Hover never fetches; hidden tabs defer refresh until visible. One inflight read
 * and one coalesced successor, including a reconnect during an inflight read. */
function BindingSource({ source, scope, publish }: { source: Source; scope: string; publish: (key: string, link?: Link) => void }) {
  useEffect(() => {
    const abort = new AbortController(); let busy = false, dirty = true;
    const valid = () => !abort.signal.aborted && recoveryScope() === scope;
    const refresh = async () => {
      if (!valid() || busy || !dirty || document.hidden) return;
      busy = true; dirty = false;
      try {
        const result = await (source.legacy ? api.fileBoardBinding : api.fileCardBinding)(source.resource, abort.signal);
        if (valid() && !dirty) publish(source.key, { paneId: source.paneId, binding: result.enabled ? result.binding : null });
      } catch { if (valid()) publish(source.key); }
      finally { busy = false; if (valid() && dirty) void refresh(); }
    };
    const unsubscribe = workspaceResourceEvents.subscribe(scope, source.resource, () => { dirty = true; void refresh(); }, source.legacy ? 'taskboard-binding' : 'card-file-binding');
    void refresh();
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { abort.abort(); unsubscribe(); document.removeEventListener('visibilitychange', visible); publish(source.key); };
  }, [source.key, source.paneId, source.resource, source.legacy, scope, publish]);
  return null;
}

function BindingGeometry({ surface, edges, hovered }: { surface: RefObject<HTMLDivElement | null>; edges: BindingEdge[]; hovered: string | undefined }) {
  const gradientPrefix = useId();
  const [curves, setCurves] = useState<RenderedBindingCurve[]>([]);
  useEffect(() => {
    const host = surface.current;
    const related = hovered ? edges.filter(edge => edge.card === hovered || edge.session === hovered) : [];
    if (!host || !related.length) { setCurves([]); return; }
    let frame = 0;
    const nodes = new Map(Array.from(host.querySelectorAll<HTMLElement>('[data-workspace-pane]')).map(node => [node.dataset.remotePane, node]));
    const marked = [...new Set(related.flatMap(edge => [edge.card, edge.session]))].flatMap(id => nodes.get(id) ?? []);
    const measure = () => {
      frame = 0; const origin = host.getBoundingClientRect();
      const rect = (node: HTMLElement): BindingRect => {
        const r = node.getBoundingClientRect();
        return { x: r.left - origin.left + host.scrollLeft, y: r.top - origin.top + host.scrollTop, width: r.width, height: r.height };
      };
      const allRects = new Map<string, BindingRect>();
      for (const [paneId, node] of nodes.entries()) {
        if (paneId) allRects.set(paneId, rect(node));
      }
      const next: RenderedBindingCurve[] = [];
      related.forEach((edge, idx) => {
        const a = allRects.get(edge.card), b = allRects.get(edge.session);
        if (!a || !b || host.dataset.hasMaximized === 'true') return;
        const obstacles: BindingRect[] = [];
        for (const [id, r] of allRects.entries()) {
          if (id !== edge.card && id !== edge.session) obstacles.push(r);
        }
        const d = bindingCurve(a, b, {
          obstacles,
          parallelIndex: idx,
          parallelCount: related.length,
        });
        if (!d) return;
        const palette = bindingGroupColor(edge.card);
        const pts = parseEndpoints(d) ?? {
          startX: a.x + a.width / 2,
          startY: a.y + a.height / 2,
          endX: b.x + b.width / 2,
          endY: b.y + b.height / 2,
        };
        next.push({
          key: `${edge.card}->${edge.session}:${idx}`,
          d,
          groupId: palette.id,
          stroke: palette.stroke,
          secondary: palette.secondary,
          glow: palette.glow,
          ...pts,
        });
      });
      for (const node of nodes.values()) {
        if (next.length && !marked.includes(node)) node.dataset.bindingMuted = 'true';
        else delete node.dataset.bindingMuted;
      }
      setCurves(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule), move = new MutationObserver(schedule);
    resize.observe(host);
    for (const node of marked) { node.dataset.bindingLinked = 'true'; resize.observe(node); move.observe(node, { attributes: true, attributeFilter: ['style'] }); }
    move.observe(host, { attributes: true, attributeFilter: ['data-has-maximized'] });
    host.addEventListener('scroll', schedule, { passive: true }); measure();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); move.disconnect(); host.removeEventListener('scroll', schedule); for (const node of nodes.values()) { delete node.dataset.bindingLinked; delete node.dataset.bindingMuted; } };
  }, [surface, edges, hovered]);

  if (!curves.length) return null;
  return (
    <svg className="workspace-binding-lines workspace-binding-lines--top" data-top-layer="true" aria-hidden="true">
      <defs>
        {curves.map((c, idx) => (
          <linearGradient
            key={c.key}
            id={`${gradientPrefix}-${idx}`}
            gradientUnits="userSpaceOnUse"
            x1={c.startX}
            y1={c.startY}
            x2={c.endX}
            y2={c.endY}
          >
            <stop offset="0%" stopColor={c.stroke} />
            <stop offset="100%" stopColor={c.secondary} />
          </linearGradient>
        ))}
      </defs>
      {curves.map((c, idx) => (
        <g key={c.key} className="binding-line" data-group-color={c.groupId}>
          <path className="binding-line-halo" d={c.d} style={{ stroke: c.glow }} />
          <path className="binding-line-track" d={c.d} style={{ stroke: `url(#${gradientPrefix}-${idx})` }} />
          <path className="binding-line-flow" d={c.d} pathLength={100} style={{ stroke: `url(#${gradientPrefix}-${idx})` }} />
          <circle className="workspace-binding-endpoint" cx={c.startX} cy={c.startY} r={4} style={{ fill: c.stroke }} />
          <circle className="workspace-binding-endpoint" cx={c.endX} cy={c.endY} r={4} style={{ fill: c.secondary }} />
        </g>
      ))}
    </svg>
  );
}

/** Kept outside the panel render tree: hover/animation never rerenders chats. */
export const WorkspaceBindingLines = memo(function WorkspaceBindingLines({ surface, panes, scope }: { surface: RefObject<HTMLDivElement | null>; panes: Pane[]; scope: string }) {
  const [selected, setSelected] = useState<string>();
  useEffect(() => {
    const host = surface.current; if (!host) return;
    const toggle = (event: Event) => {
      const pane = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-workspace-pane]') : null;
      if (pane && host.contains(pane)) setSelected(previous => previous === pane.dataset.remotePane ? undefined : pane.dataset.remotePane);
    };
    const clear = () => setSelected(undefined);
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') clear(); };
    host.addEventListener('agentopsdeck:binding-lines', toggle);
    host.addEventListener('dragstart', clear);
    document.addEventListener('keydown', key); document.addEventListener('visibilitychange', clear);
    return () => { host.removeEventListener('agentopsdeck:binding-lines', toggle); host.removeEventListener('dragstart', clear); document.removeEventListener('keydown', key); document.removeEventListener('visibilitychange', clear); };
  }, [surface]);
  const [sourceSet, setSourceSet] = useState<{ identity: string; sources: Source[] }>();
  const [links, setLinks] = useState<Record<string, Link>>({});
  const identity = JSON.stringify(panes.map(p => isSessionPane(p) ? { id: p.id, sessionKey: p.sessionKey } : { id: p.id, kind: p.kind, resourceId: p.resourceId, ...('target' in p ? { target: p.target } : {}) }));
  const stablePanes = useMemo(() => JSON.parse(identity) as Pane[], [identity]);
  useEffect(() => {
    const host = surface.current;
    if (!host) return;
    let source: Pane | undefined;
    const eligible = (pane: Pane) => !(pane.kind === 'metric-card' && pane.resourceId === 'catalog');
    const paneAt = (target: EventTarget | null) => target instanceof Element
      ? stablePanes.find(p => p.id === target.closest<HTMLElement>('[data-workspace-pane]')?.dataset.remotePane) : undefined;
    const clear = () => { source = undefined; for (const node of host.querySelectorAll<HTMLElement>('[data-binding-drop]')) delete node.dataset.bindingDrop; };
    const start = (event: DragEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('[data-binding-drag]')) return;
      source = paneAt(event.target);
      if (!source || !eligible(source) || !event.dataTransfer) { clear(); return; }
      setSelected(undefined);
      event.stopPropagation();
      event.dataTransfer.setData('application/x-agentopsdeck-binding', source.id);
      event.dataTransfer.effectAllowed = 'link';
      for (const node of host.querySelectorAll<HTMLElement>('[data-workspace-pane]')) {
        const target = paneAt(node);
        if (target && eligible(target) && isSessionPane(target) !== isSessionPane(source)) node.dataset.bindingDrop = 'available';
      }
    };
    const over = (event: DragEvent) => {
      const target = paneAt(event.target);
      if (!source || !target || !eligible(target) || isSessionPane(target) === isSessionPane(source)) return;
      event.preventDefault(); event.stopPropagation(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'link';
    };
    const drop = (event: DragEvent) => {
      const target = paneAt(event.target), origin = source;
      if (!origin || !target || !eligible(target) || isSessionPane(target) === isSessionPane(origin) || recoveryScope() !== scope) { clear(); return; }
      event.preventDefault(); event.stopPropagation();
      const session = isSessionPane(origin) ? origin : target, card = isSessionPane(origin) ? target : origin;
      clear();
      if (isSessionPane(session)) document.dispatchEvent(new CustomEvent('agentopsdeck:binding-drop', { detail: { paneId: card.id, sessionKey: session.sessionKey, scope } }));
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') clear(); };
    host.addEventListener('dragstart', start, true); host.addEventListener('dragover', over, true); host.addEventListener('drop', drop, true);
    document.addEventListener('dragend', clear); document.addEventListener('keydown', key); document.addEventListener('visibilitychange', clear);
    return () => { clear(); host.removeEventListener('dragstart', start, true); host.removeEventListener('dragover', over, true); host.removeEventListener('drop', drop, true);
      document.removeEventListener('dragend', clear); document.removeEventListener('keydown', key); document.addEventListener('visibilitychange', clear); };
  }, [surface, stablePanes, scope]);
  const cardIdentity = JSON.stringify(stablePanes.filter(p => !isSessionPane(p)));
  const stableCards = useMemo(() => JSON.parse(cardIdentity) as Pane[], [cardIdentity]);
  const sources = sourceSet?.identity === cardIdentity ? sourceSet.sources : [];
  useEffect(() => {
    let alive = true;
    void Promise.all(stableCards.map(async pane => {
      const resource = await fileCardPaneResource(pane);
      return [...(resource ? [{ key: JSON.stringify([pane.id, resource, false]), paneId: pane.id, resource, legacy: false }] : []),
        ...(pane.kind === 'taskboard' || pane.kind === 'statuscard' ? [{ key: JSON.stringify([pane.id, pane.resourceId, true]), paneId: pane.id, resource: pane.resourceId, legacy: true }] : [])];
    })).then(value => { if (alive) setSourceSet({ identity: cardIdentity, sources: value.flat() }); }).catch(() => { if (alive) setSourceSet({ identity: cardIdentity, sources: [] }); });
    return () => { alive = false; };
  }, [stableCards, cardIdentity, scope]);
  const publish = useCallback((key: string, value?: Link) => setLinks(previous => {
    if (JSON.stringify(previous[key]) === JSON.stringify(value)) return previous;
    const next = { ...previous }; if (value) next[key] = value; else delete next[key]; return next;
  }), []);
  const fileIdentity = JSON.stringify(fileLinkEdges(panes));
  const fileEdges = useMemo(() => JSON.parse(fileIdentity) as BindingEdge[], [fileIdentity]);
  const edges = useMemo(() => [...bindingEdges(stablePanes.map(p => ({ id: p.id, ...(isSessionPane(p) ? { sessionKey: p.sessionKey } : {}) })), sources.flatMap(source => links[source.key] ?? [])), ...fileEdges], [stablePanes, links, sources, fileEdges]);
  const active = selected && stablePanes.some(pane => pane.id === selected) ? selected : undefined;
  return <>{active && sources.map(source => <BindingSource key={source.key} source={source} scope={scope} publish={publish} />)}<BindingGeometry surface={surface} edges={active ? edges : []} hovered={active} /></>;
});

export default WorkspaceBindingLines;
