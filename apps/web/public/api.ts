// AgentOpsDeck compatibility shim.
// Stale PWA/dev-cache entries may probe /api.ts after a runtime swap.
// Keep this harmless static module so the probe does not surface as a 404.
export {};
