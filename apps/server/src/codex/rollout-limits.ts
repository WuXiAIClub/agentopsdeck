/** Resource guards, not string/heap size limits. Native records remain bounded
 * independently; tool-detail references must use the same raw-file boundary. */
export const maxRolloutFileBytes = 4 * 1024 * 1024 * 1024;
