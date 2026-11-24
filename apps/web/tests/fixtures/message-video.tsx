import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DesktopMessageWithTools, MobileMessageBubble } from '../../src/components/messages';
import { setRecoveryScope } from '../../src/api';
import type { ChatMessage } from '@agentopsdeck/shared';
import '../../src/styles.css';

setRecoveryScope('a'.repeat(64));
const hubUrl = `/api/hub/v1/sessions/c%3As/messages/m/media/${'b'.repeat(64)}`;
const media = [{ type: 'file' as const, name: '演示 video.webm', mimeType: 'video/webm', url: '/api/artifacts/abc123' },
  { type: 'file' as const, name: 'Connector video.webm', mimeType: 'video/webm', url: hubUrl },
  { type: 'file' as const, name: 'external.mp4', mimeType: 'video/mp4', url: 'https://external.invalid/movie.mp4' }];
const message: ChatMessage = { id: 'video', sessionKey: 'c:s', role: 'assistant', text: 'A [video link](/api/artifacts/abc123).', createdAt: 1, media };
function Fixture() {
  const [mounted, setMounted] = useState(true), [width, setWidth] = useState(240), [revision, setRevision] = useState(0);
  return <>
    <button id="mount" onClick={() => setMounted(value => !value)}>Mount</button>
    <button id="resize" onClick={() => setWidth(value => value === 240 ? 900 : 240)}>Resize</button>
    <button id="refresh" onClick={() => setRevision(value => value + 1)}>Refresh</button>
    <button id="scope" onClick={() => setRecoveryScope('b'.repeat(64))}>Account</button>
    <input aria-label="Draft" />
    {mounted && <section data-workspace-pane style={{ width, maxWidth: '100%', overflow: 'hidden' }}>
      <DesktopMessageWithTools message={{ ...message, media: media.map(item => ({ ...item })), updatedAt: revision } as ChatMessage} attachedTools={undefined} isRecent onMediaLoad={undefined} />
    </section>}
    <section data-mobile><MobileMessageBubble message={{ ...message, id: 'mobile', text: 'Mobile', media: [media[0]!] }} isRecent onMediaLoad={undefined} /></section>
  </>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>);
