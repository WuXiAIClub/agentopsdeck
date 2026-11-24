import { useLayoutEffect, useRef } from 'react';
import { pageRefreshGate } from './page-refresh';
import { useFileCardGuard } from './workspace-file-card-context';

export function usePageRefreshGuard(ready: () => boolean) {
  const latest = useRef(ready);
  useFileCardGuard(ready);
  useLayoutEffect(() => { latest.current = ready; });
  useLayoutEffect(() => pageRefreshGate.register(() => latest.current()), []);
}
