import { createHash } from 'node:crypto';

/** An address within a message, never a bearer capability or a file path.
 * Membership is checked at the Connector on every download and body pull.
 */
export function mediaResourceId(url: string) {
  return createHash('sha256').update(url).digest('hex');
}

export function localMediaResource(url: string): { kind: 'inbound' | 'artifact'; id: string } | undefined {
  const artifact = /^\/api\/artifacts\/([a-f0-9]{24,64})$/i.exec(url);
  if (artifact) return { kind: 'artifact', id: artifact[1]! };
  const inbound = /^\/api\/media\/inbound\/([^/?#]+)$/.exec(url);
  if (!inbound) return undefined;
  let id: string;
  try { id = decodeURIComponent(inbound[1]!); } catch { return undefined; }
  return /^[\w.-]+$/.test(id) && id !== '.' && id !== '..' ? { kind: 'inbound', id } : undefined;
}
