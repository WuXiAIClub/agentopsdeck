import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FileBrowser } from '../src/components/FileBrowser';
import { api, setRecoveryScope } from '../src/api';
import { useI18n } from '../src/lib/i18n';
import '../src/styles.css';

setRecoveryScope('a'.repeat(64));
function Fixture() {
  const [connection, setConnection] = useState<string>();
  const [visible, setVisible] = useState(true);
  const { locale, setLocale } = useI18n();
  Object.assign(window, {
    fileFixture: { api, setRecoveryScope, setConnection, setVisible },
  });
  return <main className="mx-auto max-w-6xl p-4">
    <label>Language <select value={locale} onChange={event => setLocale(event.target.value as 'en' | 'zh-CN')}><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
    {visible && <FileBrowser title="Fixture files" description="Isolated fixture" mode="agent" initialAgentId="codex" agentIds={['codex', 'hermes']} connectionId={connection} />}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
