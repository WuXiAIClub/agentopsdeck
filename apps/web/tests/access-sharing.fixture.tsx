import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AccessRoleMatrix } from '../src/components/AccessRoleMatrix';
import { SessionSharing } from '../src/components/SessionSharing';
import { HubUserAccess } from '../src/components/HubUserAccess';
import { setRecoveryScope } from '../src/api';
import { useI18n } from '../src/lib/i18n';
import '../src/styles.css';

setRecoveryScope('a'.repeat(64));
function Fixture() {
  const { locale, setLocale } = useI18n();
  const [user, setUser] = useState('fixture-member');
  const [session, setSession] = useState('fixture-session');
  const [scopeVersion, setScopeVersion] = useState(0);
  (window as any).replaceAccessUser = (id: string) => setUser(id);
  (window as any).replaceAccessSession = (id: string) => setSession(id);
  (window as any).replaceAccessAccount = () => { setRecoveryScope('b'.repeat(64)); setScopeVersion(value => value + 1); };
  (window as any).cycleAccessAccount = () => { setRecoveryScope('b'.repeat(64)); setRecoveryScope('a'.repeat(64)); };
  return <main key={scopeVersion} data-fixture-user={user} data-fixture-session={session} data-fixture-scope={scopeVersion} className="mx-auto max-w-3xl space-y-4 p-4">
    <label>Language <select value={locale} onChange={event => setLocale(event.target.value as 'en' | 'zh-CN')}><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
    {new URLSearchParams(location.search).has('keys') ? <HubUserAccess actorUserId="fixture-owner" user={{ id: user, label: user, createdAt: 1, updatedAt: 1 }} connections={[
      { id: 'fixture-node', ownerUserId: 'fixture-owner', label: 'Fixture environment', kind: 'remote', status: 'enabled', updatedAt: 1 },
    ]} /> : <><AccessRoleMatrix user={{ id: user, label: user }} /><SessionSharing sessionKey={session} /></>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
