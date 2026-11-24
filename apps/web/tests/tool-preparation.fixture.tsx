import React from 'react';
import { createRoot } from 'react-dom/client';
// Export injected only by tool-preparation.browser.mjs.
// @ts-expect-error test-only export
import { toolPreparationTest as subject } from '../src/components/messages';
import { toolTimelineOracle } from './fixtures/tool-timeline-oracle.mjs';
import { DesktopToolTimeline, MobileToolStrip } from '../src/components/messages';

const probeWindow = window as any;
probeWindow.subject = subject;
probeWindow.oracle = toolTimelineOracle;
const root = createRoot(document.getElementById('root')!);
function Probe() {
  const [messages, setMessages] = React.useState([]);
  const [, setRevision] = React.useState(0);
  probeWindow.setProbeMessages = setMessages;
  probeWindow.probeMessages = messages;
  probeWindow.rerenderProbe = () => setRevision(n => n + 1);
  probeWindow.probe = subject.useToolTimelineEntries(messages);
  return <>
    <pre>{JSON.stringify(probeWindow.probe)}</pre>
    <div className="desktop-probe"><DesktopToolTimeline messages={messages} /></div>
    <div className="mobile-probe"><MobileToolStrip messages={messages} /></div>
  </>;
}
root.render(<Probe />);
probeWindow.unmountProbe = () => root.unmount();
