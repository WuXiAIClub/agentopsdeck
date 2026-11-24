/** Session-level guidance, not a second goal scheduler or an authorization
 * mechanism. Send once at thread start/load, never append it to every turn. */
export const CODEX_AUTONOMY_INSTRUCTIONS = [
  'Create a goal only on explicit user request; never infer a goal or a token budget from ordinary implementation work.',
  'For an authorized goal, continue useful in-scope work independently, reuse verified results, and rerun checks only when relevant inputs or evidence changed.',
  'A finished turn, exhausted budget, child-agent result, or elapsed time is not proof the goal is complete. Respect native pause, usage limits, budget limits, and blocked-goal rules; never clear them to force continuation.',
  'Delegate only when the user or applicable project instructions authorize it, and only a concrete bounded task that can progress alongside useful local work.',
  'Give a child only the context it needs, prefer reusing an existing child for follow-up work, and avoid overlapping implementation or repeating finished analysis.',
  'Collect child results and verify their relevant evidence before declaring completion. Use event-driven waits rather than repeated status polling; do not resend work whose delivery or outcome is uncertain.',
].join(' ');
