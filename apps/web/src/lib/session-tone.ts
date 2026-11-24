/** Cosmetic identity only: hash the full Hub session key (including connector),
 * never the agent, title, status or list position. No browser storage/config needed.
 * A finite colour space is a cue, not a unique identifier; keep titles/status text.
 */
export function sessionTone(sessionKey: string, customColor?: string) {
  if (customColor && /^#[0-9a-f]{6}$/i.test(customColor)) {
    const rgb = [1, 3, 5].map(offset => parseInt(customColor.slice(offset, offset + 2), 16));
    // Preserve hue while ensuring the existing white/muted-white selection text
    // stays readable, including when a user chooses white or a pastel.
    for (let step = 0; step < 255; step++) {
      const linear = rgb.map(c => c / 255 <= .04045 ? c / 255 / 12.92 : ((c / 255 + .055) / 1.055) ** 2.4);
      const luminance = linear[0]! * .2126 + linear[1]! * .7152 + linear[2]! * .0722;
      if (1.05 / (luminance + .05) >= 7) break;
      for (let i = 0; i < 3; i++) rgb[i] = Math.max(0, rgb[i]! - 1);
    }
    return { accent: `rgb(${rgb.join(', ')})`, soft: `${customColor}10`, shadow: `${customColor}29` };
  }
  let hash = 2166136261;
  for (let i = 0; i < sessionKey.length; i++) hash = Math.imul(hash ^ sessionKey.charCodeAt(i), 16777619);
  // Avalanche similar thread IDs so adjacent suffixes do not get adjacent hues.
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  hash = (hash ^ (hash >>> 16)) >>> 0;
  const hue = hash % 360;
  const saturation = 62 + ((hash >>> 9) % 14);
  let rgb: number[] = [];
  // Keep white selected-card labels readable even for yellow/green hues.
  for (let lightness = 44; lightness >= 20; lightness--) {
    const l = lightness / 100;
    const a = saturation / 100 * Math.min(l, 1 - l);
    rgb = [0, 8, 4].map(n => {
      const k = (n + hue / 30) % 12;
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    });
    const linear = rgb.map(c => c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
    const luminance = linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
    if (1.05 / (luminance + 0.05) >= 7) break;
  }
  return {
    accent: `rgb(${rgb.join(', ')})`,
    soft: `hsl(${hue} ${saturation}% 96%)`,
    shadow: `hsl(${hue} ${saturation}% 30% / 0.16)`,
  };
}
