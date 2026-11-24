/** Scale absolute font declarations, including Tailwind's generated utilities.
 * Relative em/% and inheritance already follow their parent: never scale twice.
 * Only font-size changes; rem spacing, hit targets, and panel geometry stay intact.
 */
export function scaledFontSize(value: string): string {
  if (value.includes('--agentopsdeck-font-scale')) return value;
  if (/^-?(?:\d*\.)?\d+(?:em|%|ex|ch|lh)$/.test(value.trim())) return value;
  if (!/(?:\d(?:px|rem|vw|vh)|var\(--text-)/.test(value)) return value;
  return `calc(${value} * var(--agentopsdeck-font-scale, 1))`;
}
export function fontScaleCss() {
  return {
    postcssPlugin: 'agentopsdeck-font-scale',
    Declaration: {
      'font-size': (declaration: { value: string }) => { declaration.value = scaledFontSize(declaration.value); },
    },
  };
}
