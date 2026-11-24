import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { setApiBaseUrl, setRecoveryScope } from '../src/api';
import { AdmissionMaintenanceControls } from '../src/components/admission-maintenance';
import { MaintenanceRecoveryNotice, useMaintenanceRecovery } from '../src/components/maintenance-recovery';
import '../src/styles.css';

declare global {
  interface Window {
    admissionFixture: { account(scope: string): void; connection(visible: boolean): void };
  }
}

setApiBaseUrl(location.origin);
setRecoveryScope('a'.repeat(64));
function Fixture() {
  const [, rerender] = useState(0), [visible, setVisible] = useState(true);
  const recovery = useMaintenanceRecovery();
  window.admissionFixture = {
    account(scope) { setRecoveryScope(scope); rerender(value => value + 1); },
    connection(value) { setVisible(value); },
  };
  return <main className="mx-auto max-w-3xl p-3">
    {visible && <AdmissionMaintenanceControls key={JSON.stringify([recovery.scope, 'original-node'])} connectionId="original-node" recovery={recovery} />}
    <MaintenanceRecoveryNotice recovery={recovery} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
