/** Private authenticated UI text, never telemetry. Bound both serialization
 * and output. A preview does not alter the immutable native tool arguments. */
export function interactionToolPrompt(name: string, value: unknown): string {
  const text = JSON.stringify(value);
  // Never ask for approval of a silently truncated command/patch.
  if (!text || text.length > 7000 || name.length > 240) throw new Error('Tool approval exceeds safe display limit');
  return `Allow this tool once within the Connector's configured permissions?\n${name}\n${text}`;
}
