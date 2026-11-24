import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HubLoginActivity } from '../src/components/HubLoginActivity';
import { SharedGrantDirectory } from '../src/components/SharedGrantDirectory';
import { SharedQueuePanel } from '../src/components/SharedQueuePanel';
import { CommandRecoveryNotice } from '../src/components/CommandRecoveryNotice';
import { RenderRecoveryBoundary } from '../src/components/RenderRecoveryBoundary';
import { setRecoveryScope } from '../src/api';
import { CommandJournal } from '../src/lib/command-recovery';
import { useI18n } from '../src/lib/i18n';
import '../src/styles.css';

const scope = 'a'.repeat(64);
setRecoveryScope(scope);
const journal = new CommandJournal(sessionStorage);
if (!journal.list(scope, 'local:c2Vzc2lvbg').length) journal.begin(scope, 'local:c2Vzc2lvbg', 'fixture.unknown');
function Broken(): React.ReactNode { throw new Error('Synthetic render error 原文'); }
function Fixture() {
  const { locale, setLocale } = useI18n();
  const [visible, setVisible] = useState(true);
  (window as any).cycleAccount = () => { setRecoveryScope('b'.repeat(64)); setRecoveryScope(scope); };
  return <div className="mx-auto max-w-3xl space-y-4 p-4">
    <label>Language <select value={locale} onChange={event => setLocale(event.target.value as 'en' | 'zh-CN')}><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
    <HubLoginActivity users={[]} />
    <RenderRecoveryBoundary scope="tools" plainText="Original tool output 原文"><Broken /></RenderRecoveryBoundary>
    <button onClick={() => setVisible(value => !value)}>Toggle recovery</button>
    {visible && <CommandRecoveryNotice sessionKey="local:c2Vzc2lvbg" onRecovered={async () => {}} />}
    <SharedQueuePanel sessionKey={JSON.stringify(['shared-session-v1', 'owner-fixture', 'local:c2Vzc2lvbg'])} revision={0} onChanged={async () => {}} onDenied={() => {}} />
    <SharedGrantDirectory paused={false} />
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
