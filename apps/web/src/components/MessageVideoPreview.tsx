import React, { lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Play, X } from 'lucide-react';
import type { ChatMessageMedia } from '@agentopsdeck/shared';
import { mediaUrl, subscribeRecoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
const LazyVideoPlayer = lazy(() => import('./VideoPlayer').then(module => ({ default: module.VideoPlayer })));
const VideoPlayer = (props: React.ComponentProps<typeof LazyVideoPlayer>) => <Suspense fallback={null}><LazyVideoPlayer {...props} /></Suspense>;

let dismissVideo: (() => void) | undefined;

/** Compact in every message layout; media is mounted only while the popover is open. */
export function MessageVideoPreview({ item, children }: { item: ChatMessageMedia; children?: ReactNode }) {
  const { t } = useI18n(), id = useId();
  const root = useRef<HTMLSpanElement>(null), popup = useRef<HTMLSpanElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pinned = useRef(false), restoringFocus = useRef(false);
  const [open, setOpen] = useState(false), [revoked, setRevoked] = useState(false);
  const clear = () => { clearTimeout(timer.current); timer.current = undefined; };
  const close = () => { clear(); pinned.current = false; setOpen(false); };
  const dismiss = () => {
    if (root.current?.contains(document.activeElement)) {
      restoringFocus.current = true; trigger.current?.focus(); restoringFocus.current = false;
    }
    close();
  };
  const enter = () => { clear(); if (!revoked) timer.current = setTimeout(() => setOpen(true), 160); };
  const leave = () => { clear(); timer.current = setTimeout(() => {
    if (!pinned.current && !root.current?.contains(document.activeElement)) close();
  }, 220); };
  useEffect(() => {
    // Stale message metadata must not be reopened under a different account.
    const revoke = () => { close(); setRevoked(true); };
    const unsubscribe = subscribeRecoveryScope(revoke);
    window.addEventListener('agentopsdeck:auth-required', revoke);
    return () => { clear(); unsubscribe(); window.removeEventListener('agentopsdeck:auth-required', revoke); };
  }, []);
  useEffect(close, [item.url]);
  useLayoutEffect(() => {
    if (!open || revoked || !popup.current || !trigger.current) return;
    dismissVideo?.(); dismissVideo = close;
    const el = popup.current;
    const position = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const width = Math.max(0, Math.min(640, innerWidth - 16));
      el.style.width = `${width}px`;
      el.style.maxHeight = `${Math.max(0, innerHeight - 16)}px`;
      el.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
      el.style.top = `${Math.max(8, Math.min(rect.bottom + 6, innerHeight - el.getBoundingClientRect().height - 8))}px`;
    };
    el.showPopover(); position();
    const observer = new ResizeObserver(position); observer.observe(el);
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); }
    };
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !el.contains(event.target)) close(); };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', close);
    return () => {
      observer.disconnect();
      if (dismissVideo === close) dismissVideo = undefined;
      if (el.matches(':popover-open')) el.hidePopover();
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', close);
    };
  }, [open, revoked]);
  return <span ref={root} className="message-video-preview" onBlur={event => {
    if (!pinned.current && !event.currentTarget.contains(event.relatedTarget as Node | null)) close();
  }}>
    <button ref={trigger} type="button" className="source-hover-trigger message-video-trigger" disabled={revoked}
      title={item.name} aria-label={t('Video preview {name}', { name: item.name })} aria-expanded={open && !revoked}
      aria-controls={open && !revoked ? id : undefined} aria-haspopup="dialog"
      onPointerEnter={event => { if (event.pointerType !== 'touch') enter(); }} onPointerLeave={leave}
      onFocus={() => { if (!restoringFocus.current && !revoked) { clear(); setOpen(true); } }}
      onClick={() => { clear(); pinned.current = true; setOpen(true); }}>
      <Play size={14} aria-hidden="true" /><span>{children || item.name}</span>
    </button>
    {open && !revoked ? <span ref={popup} id={id} role="dialog" aria-label={t('Video preview {name}', { name: item.name })}
      popover="manual" className="source-hover-popup message-video-popup" onPointerEnter={clear} onPointerLeave={leave}
      onPointerDown={() => { pinned.current = true; }} onPlayCapture={() => { pinned.current = true; }}>
      <span className="message-video-heading"><span title={item.name}>{item.name}</span>
        <a href={mediaUrl(item.url)} download={item.name || 'video'}>{t('Download')}</a>
        <button type="button" aria-label={t('Close')} onClick={dismiss}><X size={16} /></button>
      </span>
      <span className="message-video-hint">{t('Video preview · click play to start')}</span>
      <VideoPlayer inline src={mediaUrl(item.url)} title={item.name} className="message-video-element" />
    </span> : null}
  </span>;
}
