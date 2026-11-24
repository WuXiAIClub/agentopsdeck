import { normalizeSourceFiles, type SourceFileChange } from '@agentopsdeck/shared';

/** Per native execution, not per connection. Only known structured file tools
 * qualify; shell commands and tool output text are never parsed as evidence.
 * Completed IDs retain idempotent evidence; ambiguous IDs remain tombstoned,
 * so a duplicate cannot certify a different operation. Overflow disables this
 * optional metadata, not execution.
 */
export class FileOperationEvidence {
  private readonly calls = new Map<string, { start?: string; result?: string; files: SourceFileChange[]; success?: boolean }>();
  private disabled = false;

  constructor(private readonly runtime: 'claude-code' | 'ghcp') {}

  start(scope: readonly (string | null)[], eventId: string, name: string, input: unknown) {
    if (this.disabled) return;
    const key = JSON.stringify(scope);
    if (!this.calls.has(key) && this.calls.size >= 1024) { this.close(); return; }
    const args = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
    const known = this.runtime === 'claude-code' ? ['Write', 'Edit'].includes(name) : ['create', 'edit'].includes(name);
    // Write/create may replace an existing file. Do not claim 'added' without
    // pre-operation existence evidence. Relative paths are not guessed.
    const files = known ? normalizeSourceFiles([{ path: args?.[this.runtime === 'claude-code' ? 'file_path' : 'path'], kind: 'modified' }]) : [];
    const previous = this.calls.get(key);
    if (previous) {
      if (previous.start !== eventId || JSON.stringify(previous.files) !== JSON.stringify(files)) this.calls.set(key, { files: [] });
      return;
    }
    this.calls.set(key, { start: eventId, files });
  }

  complete(scope: readonly (string | null)[], eventId: string, success: boolean): SourceFileChange[] {
    if (this.disabled) return [];
    const key = JSON.stringify(scope), call = this.calls.get(key);
    if (!this.calls.has(key) && this.calls.size >= 1024) { this.close(); return []; }
    if (!call) { this.calls.set(key, { result: eventId, files: [] }); return []; }
    if (call.result !== undefined) return call.result === eventId && call.success === success && success ? call.files : [];
    call.result = eventId; call.success = success;
    return success ? call.files : [];
  }

  close() { this.disabled = true; this.calls.clear(); }
}
