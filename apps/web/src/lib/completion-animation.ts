import { recordCompletionDiagnostic } from './completion-diagnostics';

/** Measure natural playback (never seek/pause it). Runs only on completion,
 * with three bounded samples, not on message updates or animation frames. */
export function monitorCompletionAnimation(host: HTMLElement, key: string, sequence: string) {
  const style = getComputedStyle(host);
  recordCompletionDiagnostic(key, 'render', {
    sequence, effect: host.dataset.completionEffect,
    animation: style.animationName, duration: style.animationDuration,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    visible: document.visibilityState !== 'hidden', active: host.dataset.active === 'true',
    collapsed: host.dataset.collapsed === 'true', width: host.offsetWidth, height: host.offsetHeight,
  });
  const onEvent = (event: AnimationEvent) => {
    if (event.target !== host || !['pane-heartbeat', 'pane-completed', 'pane-flash-border', 'pane-flash-overlay'].includes(event.animationName)) return;
    recordCompletionDiagnostic(key, event.type, { sequence, animation: event.animationName, elapsed: event.elapsedTime });
  };
  for (const event of ['animationstart', 'animationend', 'animationcancel']) host.addEventListener(event, onEvent as EventListener);
  const timers = [150, 300, 950].map(after => setTimeout(() => {
    if (!host.isConnected || host.dataset.completionSequence !== sequence) return;
    const css = getComputedStyle(host);
    const overlay = getComputedStyle(host, '::before');
    recordCompletionDiagnostic(key, 'playback-sample', {
      sequence, after, scale: css.scale, animation: css.animationName,
      overlayAnimation: overlay.animationName, overlayOpacity: overlay.opacity,
      widthRatio: host.offsetWidth ? Math.round(host.getBoundingClientRect().width / host.offsetWidth * 1000) / 1000 : 0,
      playing: host.getAnimations().some(animation => animation.playState === 'running'),
      visible: document.visibilityState !== 'hidden',
    });
  }, after));
  return () => {
    for (const timer of timers) clearTimeout(timer);
    for (const event of ['animationstart', 'animationend', 'animationcancel']) host.removeEventListener(event, onEvent as EventListener);
  };
}
