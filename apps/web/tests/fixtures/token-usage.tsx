import { createRoot } from 'react-dom/client';
import { SessionTokenUsage } from '../../src/components/SessionTokenUsage';
import { setRecoveryScope } from '../../src/api';
import '../../src/styles.css';
setRecoveryScope('a'.repeat(64));
createRoot(document.getElementById('root')!).render(<SessionTokenUsage sessionKey={`local:${btoa('codex:usage-fixture')}`} />);
