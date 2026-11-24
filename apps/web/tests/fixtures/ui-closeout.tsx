import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserSettings } from '../../src/components/BrowserSettings';
import { FontPreferencesProvider } from '../../src/components/FontPreferences';
import { DesktopToolTimeline } from '../../src/components/messages';
import { setRecoveryScope } from '../../src/api';
import { setLocale } from '../../src/lib/i18n';
import '../../src/styles.css';
import '../../src/desktop-shell.css';
setLocale('en'); setRecoveryScope('a'.repeat(64));
const tools = Array.from({ length: 14 }, (_, index) => ({ id: `tool-${index}`, sessionKey: 'local:synthetic', text: 'test output',
  role: 'tool' as const, status: 'sent' as const, createdAt: index * 1000, toolPhase: 'result' as const, toolName: 'exec_command' }));
createRoot(document.getElementById('root')!).render(<React.StrictMode><FontPreferencesProvider>
  <BrowserSettings />
  {[240, 320, 390, 780].map(width => <section key={width} data-width={width} data-font-area="chat"
    style={{ width, maxWidth: '100%', containerType: 'inline-size', containerName: 'sessionpane', padding: 8, boxSizing: 'border-box' }}>
    <DesktopToolTimeline messages={tools} />
  </section>)}
</FontPreferencesProvider></React.StrictMode>);
