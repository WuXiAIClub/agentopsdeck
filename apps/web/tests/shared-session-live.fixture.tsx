import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { recoveryScope, setApiBaseUrl, setRecoveryScope } from '../src/api';
import { GlobalNotebookProvider } from '../src/components/SessionNotebook';
import { SharedSessionBoundary } from '../src/components/SharedSessionView';
import { writeHashRoute } from '../src/lib/session-utils';
import { sessionAddress } from '../src/lib/session-address';
import '../src/styles.css';
import '../src/desktop-shell.css';

setApiBaseUrl(location.origin);
setRecoveryScope('a'.repeat(64));
(window as any).sharedFixture = {
  navigate(ownerUserId: string) { writeHashRoute({ sessionKey: sessionAddress({ ownerUserId, sessionId: 'node:c3ludGhldGlj' }).key }); },
};
function Fixture() {
  const [paused, setPaused] = useState(false), [, rerender] = useState(0);
  Object.assign((window as any).sharedFixture, {
    pause(value: boolean) { setPaused(value); },
    account(scope: string) { setRecoveryScope(scope); rerender(value => value + 1); },
  });
  return <GlobalNotebookProvider key={recoveryScope()} paused={paused}><SharedSessionBoundary paused={paused}><p>Owner workspace placeholder</p></SharedSessionBoundary></GlobalNotebookProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
