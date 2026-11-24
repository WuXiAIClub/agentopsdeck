// Shared by browser→Hub and Hub→Connector. No persistent or stale-on-error cache.
export { createConditionalHistoryCache, restoreConditionalHistory, restoreHistoryDelta, HISTORY_DELTA_HEADER } from '@agentopsdeck/shared';
