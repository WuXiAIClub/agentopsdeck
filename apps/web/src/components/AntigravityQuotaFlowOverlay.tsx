import { memo, useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import {
  ANTIGRAVITY_QUOTA_PULSE_EVENT,
  useAntigravityQuotaFxEnabled,
  type AntigravityQuotaPulseDetail,
} from '../lib/antigravity-quota-fx';
import './antigravity-quota-flow.css';

type Particle = {
  id: number;
  kind: 'message' | 'tool';
  startX: number;
  startY: number;
  midX: number;
  midY: number;
  endX: number;
  endY: number;
};

const MAX_ACTIVE_PARTICLES = 6;
const FLIGHT_DURATION_MS = 920;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Purely decorative, low-attention particle drift from an Antigravity session
 * to the Antigravity quota dial when a tool or message completes. Toggleable and
 * completely isolated from chat state and rendering. */
export const AntigravityQuotaFlowOverlay = memo(function AntigravityQuotaFlowOverlay({
  surface,
}: {
  surface: RefObject<HTMLDivElement | null>;
}) {
  const [enabled] = useAntigravityQuotaFxEnabled();
  const [particles, setParticles] = useState<Particle[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const activeTimers = timers.current;
    return () => {
      for (const timer of activeTimers) clearTimeout(timer);
      activeTimers.clear();
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      setParticles([]);
      return;
    }

    const onPulse = (event: Event) => {
      if (prefersReducedMotion()) return;
      const detail = (event as CustomEvent<AntigravityQuotaPulseDetail>).detail;
      const host = surface.current;
      if (!host || !detail?.sessionKey || host.dataset.hasMaximized === 'true') return;

      const quotaPane = host.querySelector<HTMLElement>('[data-workspace-pane][data-pane-kind="antigravity-quota"]');
      if (!quotaPane) return;

      const sourceNode = Array.from(host.querySelectorAll<HTMLElement>('[data-session-key]'))
        .find(node => node.dataset.sessionKey === detail.sessionKey);
      if (!sourceNode) return;

      const hostRect = host.getBoundingClientRect();
      const sourceRect = sourceNode.getBoundingClientRect();
      const targetDial = quotaPane.querySelector<HTMLElement>('.antigravity-quota-dial') ?? quotaPane;
      const targetRect = targetDial.getBoundingClientRect();
      if (sourceRect.width < 10 || targetRect.width < 10) return;

      const startX = sourceRect.left - hostRect.left + host.scrollLeft + sourceRect.width * 0.65;
      const startY = sourceRect.top - hostRect.top + host.scrollTop + Math.min(sourceRect.height * 0.42, 180);
      const endX = targetRect.left - hostRect.left + host.scrollLeft + targetRect.width / 2;
      const endY = targetRect.top - hostRect.top + host.scrollTop + targetRect.height / 2;
      const dx = endX - startX;
      const dy = endY - startY;
      const dist = Math.hypot(dx, dy);
      if (dist < 24) return;

      const arcLift = Math.min(72, Math.max(24, dist * 0.16));
      const midX = (startX + endX) / 2;
      const midY = (startY + endY) / 2 - arcLift;
      const id = nextId.current++;

      const particle: Particle = {
        id,
        kind: detail.kind,
        startX,
        startY,
        midX,
        midY,
        endX,
        endY,
      };

      setParticles(prev => [...prev.slice(-(MAX_ACTIVE_PARTICLES - 1)), particle]);

      const sipTimer = setTimeout(() => {
        timers.current.delete(sipTimer);
        if (targetDial.isConnected) {
          targetDial.dataset.quotaSip = 'true';
          const clearSip = setTimeout(() => {
            timers.current.delete(clearSip);
            if (targetDial.isConnected) delete targetDial.dataset.quotaSip;
          }, 420);
          timers.current.add(clearSip);
        }
      }, Math.round(FLIGHT_DURATION_MS * 0.82));
      timers.current.add(sipTimer);

      const removeTimer = setTimeout(() => {
        timers.current.delete(removeTimer);
        setParticles(prev => prev.filter(item => item.id !== id));
      }, FLIGHT_DURATION_MS + 60);
      timers.current.add(removeTimer);
    };

    window.addEventListener(ANTIGRAVITY_QUOTA_PULSE_EVENT, onPulse);
    return () => window.removeEventListener(ANTIGRAVITY_QUOTA_PULSE_EVENT, onPulse);
  }, [enabled, surface]);

  if (!enabled || particles.length === 0) return null;

  return (
    <div className="antigravity-quota-flow-layer" aria-hidden="true" data-quota-flow-overlay>
      {particles.map(p => (
        <span
          key={p.id}
          className={`antigravity-quota-spark is-${p.kind}`}
          style={{
            '--fx-sx': `${p.startX}px`,
            '--fx-sy': `${p.startY}px`,
            '--fx-mx': `${p.midX}px`,
            '--fx-my': `${p.midY}px`,
            '--fx-ex': `${p.endX}px`,
            '--fx-ey': `${p.endY}px`,
          } as CSSProperties}
        />
      ))}
    </div>
  );
});

export default AntigravityQuotaFlowOverlay;
