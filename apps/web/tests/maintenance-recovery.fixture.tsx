import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { setApiBaseUrl, setRecoveryScope } from '../src/api';
import { HubConnectionsPanel } from '../src/components/hub-connections';
import '../src/styles.css';

setApiBaseUrl(location.origin);
setRecoveryScope('a'.repeat(64));
function Fixture() {
  const [account, setAccount] = useState('a');
  (window as any).maintenanceFixture = { account(value: string) { setRecoveryScope(value.repeat(64)); setAccount(value); } };
  return <main data-account={account}><HubConnectionsPanel /></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
