import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ChatMessage } from '@agentopsdeck/shared';
import { DesktopMessageWithTools, DesktopToolTimeline, MobileToolStrip, ToolDetailCacheContext } from '../src/components/messages';
import { createIdleToolDetailCache } from '../src/lib/idle-tool-detail-cache';
import { useI18n } from '../src/lib/i18n';
import '../src/styles.css';

function Fixture() {
  const attached = new URLSearchParams(location.search).has('attached');
  const wrap = new URLSearchParams(location.search).has('wrap');
  const [session, setSession] = useState('alpha');
  const [revision, setRevision] = useState(0);
  const [prepend, setPrepend] = useState(false);
  const [visible, setVisible] = useState(true);
  const { setLocale } = useI18n();
  // Deliberately tiny, per-session shared budget for deterministic eviction.
  const detailCache = useMemo(() => createIdleToolDetailCache(512, 2), [session]);
  (window as any).fixtureIdleCache = detailCache;
  const tool = (id: string, text: string): ChatMessage => ({ id, text, sessionKey: `local:${session}`,
    role: 'tool', status: 'sent', createdAt: revision + 1 + (id === 'empty' ? 2000 : id === 'delayed' ? 4000 : 0), toolName: 'exec_command',
    toolCallId: id, toolPhase: 'result', toolDetailAvailable: true });
  const messages = wrap ? [{ ...tool('wrap', `First line\nSecond line\n${'unbroken'.repeat(100)}`), toolName: `long_tool_${'name_'.repeat(30)}`, toolDetailAvailable: false }] : [
    ...Array.from({ length: 5 }, (_, index) => tool(`compact-${index}`, `Older tool ${index}`)),
    ...(prepend ? [tool('older', 'Older preview')] : []),
    tool('same-id', `${session} preview`), tool('empty', 'Empty-result preview'), tool('delayed', 'Delayed preview'),
  ];
  return <main className="mx-auto max-w-3xl space-y-4 p-4" style={attached ? { containerType: 'inline-size', containerName: 'sessionpane' } : undefined}>
    <nav className="flex flex-wrap gap-3">
      <button onClick={() => setRevision(value => value + 1)}>Refresh projection</button>
      <button onClick={() => setPrepend(value => !value)}>Toggle older tool</button>
      <button onClick={() => setSession(value => value === 'alpha' ? 'beta' : 'alpha')}>Switch session</button>
      <button onClick={() => setVisible(value => !value)}>Toggle timeline</button>
      <button onClick={() => setLocale('zh-CN')}>中文</button>
    </nav>
    <output aria-label="Fixture state">{session}:{revision}</output>
    <ToolDetailCacheContext.Provider value={detailCache}>{visible ? attached
      ? <DesktopMessageWithTools message={{ id: 'chat', text: 'Conversation following tools', sessionKey: `local:${session}`,
        role: 'assistant', status: 'sent', createdAt: 1 }} attachedTools={messages} isRecent={false} onMediaLoad={undefined} />
      : <DesktopToolTimeline messages={messages} /> : null}</ToolDetailCacheContext.Provider>
    <MobileToolStrip messages={Array.from({ length: 8 }, (_, index) => tool(`mobile-${index}`, `Mobile tool ${index}`))} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
