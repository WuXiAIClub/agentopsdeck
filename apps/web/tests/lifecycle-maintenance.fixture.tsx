import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LifecycleControls, LifecycleRecoveryNotice, useLifecycleRecovery } from '../src/components/lifecycle-maintenance';
import { setRecoveryScope } from '../src/api';
import { useI18n } from '../src/lib/i18n';
import '../src/styles.css';

setRecoveryScope('a'.repeat(64));
function Fixture() {
  const [visible, setVisible] = useState(true), [generation, setGeneration] = useState(0);
  const recovery = useLifecycleRecovery(), { locale, setLocale } = useI18n();
  (window as any).removeConnection = () => setVisible(false);
  (window as any).cycleAccount = () => { setRecoveryScope('b'.repeat(64)); setRecoveryScope('a'.repeat(64)); };
  (window as any).replaceAccount = () => { setRecoveryScope('b'.repeat(64)); setGeneration(value => value + 1); };
  return <main className="mx-auto max-w-3xl p-4">
    <label>Language <select value={locale} onChange={event => setLocale(event.target.value as 'en' | 'zh-CN')}><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
    {visible && <LifecycleControls key={`${generation}:${recovery.epoch}`} connectionId="remote-fixture" recovery={recovery} />}
    <LifecycleRecoveryNotice recovery={recovery} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
