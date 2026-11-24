import { useId } from 'react';

/** A true perimeter runner: SVG dashes travel along the rounded rectangle,
 * independent of its aspect ratio and without animated custom properties. */
export function RunningPaneBorder() {
  const gradient = useId();
  return <svg className="session-running-ring" aria-hidden="true" focusable="false">
    <defs><linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
      <stop stopColor="#2563eb" /><stop offset=".5" stopColor="#22d3ee" /><stop offset="1" stopColor="#818cf8" />
    </linearGradient></defs>
    <rect className="session-running-track" pathLength="100" />
    <rect className="session-running-trail" pathLength="100" stroke={`url(#${gradient})`} />
    <rect className="session-running-head" pathLength="100" />
  </svg>;
}
