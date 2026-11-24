import type { SourceReference } from '@agentopsdeck/shared';
import { sourceApprovalTarget, type ApprovedSourceFile, type SourceApprovalOptions } from './source-preview.js';

export type SourceApprovalEntry = ApprovedSourceFile & { expires: number };
type ApprovalInput = string[] | SourceApprovalOptions;
function normalizeOptions(input: ApprovalInput): SourceApprovalOptions {
  return Array.isArray(input) ? { roots: input } : input;
}

/** Temporary, exact-file, session-isolated grants. Never persist read authority in browser data.
 * Token revocation, session mismatch, inode replacement, TTL, and process restart all fail closed.
 * Audit contains the referenced source path and session key, never file contents or credentials. */
export class SourceApprovals {
  private readonly entries = new Map<string, SourceApprovalEntry>();
  constructor(private readonly audit: (event: { action: 'approve' | 'revoke'; tokenId: string; sessionKey: string; path: string; at: number }) => void,
    private readonly now = Date.now) {}
  private key(tokenId: string, sessionKey: string, path: string) { return JSON.stringify([tokenId, sessionKey, path]); }
  active(tokenId: string, sessionKey: string, reference: SourceReference, entry: object) {
    const current = this.entries.get(this.key(tokenId, sessionKey, reference.path));
    return current === entry && current.expires > this.now();
  }
  async resolve(tokenId: string, sessionKey: string, reference: SourceReference, options: ApprovalInput, authorize: () => void | Promise<void>) {
    const key = this.key(tokenId, sessionKey, reference.path), entry = this.entries.get(key);
    if (!entry) return undefined;
    const normalized = normalizeOptions(options);
    const current = entry.expires > this.now()
      ? await sourceApprovalTarget(reference, entry.exactFile ? normalized : { roots: normalized.roots }, authorize)
      : undefined;
    await authorize();
    if (!this.active(tokenId, sessionKey, reference, entry) || !current
      || current.file !== entry.file || current.ino !== entry.ino || current.dev !== entry.dev
      || Boolean(current.exactFile) !== Boolean(entry.exactFile) || current.root !== entry.root) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      return undefined;
    }
    return entry;
  }
  async approve(tokenId: string, sessionKey: string, reference: SourceReference, options: ApprovalInput, authorize: () => void | Promise<void>) {
    const target = await sourceApprovalTarget(reference, normalizeOptions(options), authorize); await authorize();
    if (!target) return false;
    const at = this.now();
    for (const [key, entry] of this.entries) if (entry.expires <= at) this.entries.delete(key);
    const key = this.key(tokenId, sessionKey, reference.path);
    if (!this.entries.has(key) && this.entries.size >= 512) return false;
    this.audit({ action: 'approve', tokenId, sessionKey, path: reference.path, at });
    this.entries.set(key, { ...target, expires: at + 60 * 60_000 });
    return true;
  }
  revoke(tokenId: string, sessionKey: string, reference: SourceReference) {
    if (this.entries.delete(this.key(tokenId, sessionKey, reference.path)))
      this.audit({ action: 'revoke', tokenId, sessionKey, path: reference.path, at: this.now() });
  }
}
