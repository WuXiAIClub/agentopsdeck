import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HubConnectionsPanel } from '../src/components/hub-connections';
import { ExecutionSetup } from '../src/components/ExecutionSetup';
import { GatewayStatus } from '../src/components/GatewayStatus';
import { setRecoveryScope, type HubConnection } from '../src/api';
import { useI18n } from '../src/lib/i18n';
import '../src/styles.css';

setRecoveryScope('a'.repeat(64));
const initial: HubConnection = { id: 'remote-fixture', ownerUserId: 'fixture-owner', label: 'Fixture node', kind: 'remote',
  status: 'enabled', connectorUrl: 'https://fixture.invalid', updatedAt: 1 };
function Fixture() {
  const [connection, setConnection] = useState(initial);
  const [nodeVersion, setNodeVersion] = useState(1);
  const [executionBusy, setExecutionBusy] = useState(false);
  const [gatewayEnabled, setGatewayEnabled] = useState(true);
  const { locale, setLocale } = useI18n();
  // Tests can change the underlying snapshot while the real modal is open.
  (window as any).replaceMaintenanceConnection = () => setConnection(old => ({ ...old, updatedAt: (old.updatedAt ?? 0) + 1 }));
  (window as any).replaceMaintenanceAccount = () => { setRecoveryScope('b'.repeat(64)); setConnection(old => ({ ...old })); };
  (window as any).cycleMaintenanceAccount = () => { setRecoveryScope('b'.repeat(64)); setRecoveryScope('a'.repeat(64)); };
  (window as any).replaceExecutionVersion = (version: number) => setNodeVersion(version);
  (window as any).replaceGatewayEnabled = (enabled: boolean) => setGatewayEnabled(enabled);
  return <main data-gateway-enabled={gatewayEnabled} data-execution-version={nodeVersion} className="mx-auto max-w-3xl p-4">
    <label>Language <select value={locale} onChange={event => setLocale(event.target.value as 'en' | 'zh-CN')}><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
    {new URLSearchParams(location.search).has('gateway') ? <GatewayStatus gateway={{ enabled: gatewayEnabled, ok: true, status: 'online', updatedAt: 1, version: 'fixture', defaultModel: 'unchanged/model-id',
      gatewayWs: { configured: true, connected: true, url: 'ws://localhost:12345' } }} /> : new URLSearchParams(location.search).has('execution')
      ? <ExecutionSetup connectionId={connection.id} nodeVersion={nodeVersion} busy={executionBusy} run={async operation => {
        setExecutionBusy(true); try { await operation(); } finally { setExecutionBusy(false); }
      }} /> : <HubConnectionsPanel initialConnections={[connection]} />}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
