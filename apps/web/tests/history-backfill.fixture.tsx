import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ChatMessage } from '@agentopsdeck/shared';
import { useMessageHistory } from '../src/lib/use-message-history';
import type { HistoryBackfillOutcome } from '../src/lib/history-backfill-attempts';

type Mode = 'recover' | 'storm' | 'error' | 'throw' | 'loading' | 'dispose';
const rows = (count: number): ChatMessage[] => Array.from({ length: count }, (_, i) => ({
  id: `chat-${i}`, sessionKey: 'synthetic', role: 'assistant', text: `History ${i}`, createdAt: i,
}));
type Stats = { calls: number; rendered: number; times: number[]; signals: AbortSignal[] };
let stats: Stats;
const controls = { start, close: () => root.render(null), resume: () => {}, manual: async () => {}, stats: () => stats };
(window as any).__backfill = controls;
const root = createRoot(document.getElementById('root')!);
let generation = 0;
function start(mode: Mode) {
  stats = { calls: 0, rendered: 0, times: [], signals: [] };
  root.render(<Harness key={++generation} mode={mode} stats={stats} />);
}
function Harness({ mode, stats }: { mode: Mode; stats: Stats }) {
  const [messages, setMessages] = useState(() => rows(1));
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null), followingRef = useRef(true);
  const history = useMessageHistory({ messages, hiddenCount: messages.length < 200 ? 199 : 0, loading,
    containerRef, followingRef, automaticReadPriority: () => 3,
    loadMore: async (_schedule, signal): Promise<HistoryBackfillOutcome> => {
      stats.calls++; stats.times.push(performance.now());
      if (signal) stats.signals.push(signal);
      if (mode === 'throw') throw new Error('Synthetic handled read failure');
      if (mode === 'error') return;
      if (mode === 'loading' && stats.calls === 1) { setLoading(true); return 'superseded'; }
      if (mode === 'recover' && stats.calls >= 3 || mode === 'loading' && stats.calls >= 2) { setMessages(rows(200)); return; }
      return 'superseded';
    },
  });
  stats.rendered = history.visible.length;
  useEffect(() => {
    controls.resume = () => setLoading(false);
    controls.manual = async () => {
      containerRef.current?.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
      await history.loadOlder();
    };
  });
  return <div ref={containerRef}>{history.visible.map(row => <p key={row.id}>{row.text}</p>)}</div>;
}
