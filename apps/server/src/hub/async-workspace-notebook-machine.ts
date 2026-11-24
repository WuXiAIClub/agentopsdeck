import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { encodeHubMemberJson, type AsyncHubMemberOwner } from './async-member-owner.js';
import { HubMemberRequestError } from './async-member-request.js';
import { HubRequestWork } from './async-request-work.js';
import type { AsyncHubNativeFiles } from './async-native-files.js';
import type { NotebookFacet } from './notebook-capabilities.js';
import { NotebookMoveConflict, type NotebookMove } from './notebook-operations.js';
import { HUB_NOTEBOOK_MACHINE_BYTES, notebookMachineExpectation, validHubNotebookMachineCommand,
  validHubNotebookMachineReply, type HubNotebookMachineCommand } from './member-notebook-machine-domain.js';

const moveFacets: NotebookFacet[] = ['hot:read', 'cold:read', 'move'];
const fail = (status: ConstructorParameters<typeof HubMemberRequestError>[0]): never => { throw new HubMemberRequestError(status); };

/** Original capability proof, never a human principal. A route keeps its rate
 * slot until this complete operation (SQL + effect + original receipt) exits.
 * No deadline races or retry loop may detach an admitted operation. */
export class AsyncWorkspaceNotebookMachine {
  private readonly work = new HubRequestWork();
  private readonly persistence: AuthRoutePersistence;
  private closing?: Promise<void>;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>,
    private readonly native: Pick<AsyncHubNativeFiles, 'beginNotebookMachine'>,
    diagnostics: PerformanceDiagnostics = performanceDiagnostics) {
    this.persistence = new AuthRoutePersistence(diagnostics);
  }
  get pending() { return this.work.pending; }
  private copy(input: HubNotebookMachineCommand) {
    try {
      const value: unknown = JSON.parse(encodeHubMemberJson(input, HUB_NOTEBOOK_MACHINE_BYTES));
      if (validHubNotebookMachineCommand(value)) return value;
    } catch { /* Reject before admission; no token or body in diagnostics. */ }
    return fail(400);
  }
  private async command(input: HubNotebookMachineCommand) {
    const command = this.copy(input), expected = notebookMachineExpectation(command);
    let result;
    try { result = (await this.persistence.run(108, () => this.owner.command('notebookMachine', command))).value; }
    catch { return fail(503); }
    if (!validHubNotebookMachineReply(expected, result)) return fail(503);
    return result;
  }
  private current(request: Request) { if (request.signal.aborted) fail(499); }
  private async check(request: Request, token: string, facets: NotebookFacet[]) {
    this.current(request);
    const result = await this.command({token, action: 'authorized', facets});
    this.current(request);
    if (!result || result.action !== 'authorized' || !result.authorized) fail(403);
  }
  authorized(request: Request, token: string, facets: NotebookFacet[] = []) {
    const input = this.copy({token, action: 'authorized', facets});
    return this.work.run(async () => {
      this.current(request);
      const result = await this.command(input);
      this.current(request);
      return !!result && result.action === 'authorized' && result.authorized;
    });
  }
  read(request: Request, token: string, query: [string, string][]) {
    const input = this.copy({token, action: 'read', query});
    if (input.action !== 'read') return Promise.reject(new HubMemberRequestError(400));
    return this.work.run(async () => {
      this.current(request);
      const result = await this.command(input);
      if (!result) return fail(403);
      if (result.action !== 'read') return fail(503);
      const area = new URLSearchParams(input.query).get('area') ?? 'hot';
      // Bad-query replies carry no notebook text. Valid reads recheck exactly
      // the facets used inside the transaction, including cold-only search.
      const required: NotebookFacet[] = result.result.status !== 200 ? [] : area === 'both'
        ? ['hot:read', 'cold:read'] : [area === 'cold' ? 'cold:read' : 'hot:read'];
      await this.check(request, token, required);
      return result.result;
    });
  }
  move(request: Request, token: string, requestId: string, input?: NotebookMove, enabled = true) {
    const copied = this.copy(input ? {token, action: 'move', input} : {token, action: 'receipt', requestId});
    if (copied.action !== 'move' && copied.action !== 'receipt' || requestId !== (copied.action === 'move' ? copied.input.requestId : copied.requestId)) return Promise.reject(new HubMemberRequestError(400));
    return this.work.run(async () => {
      await this.check(request, token, moveFacets);
      const bound = await this.native.beginNotebookMachine(request, token);
      let result;
      if (bound) {
        // Undefined means no original receipt. It is NOT permission to execute
        // a local CAS after a bound operation or an unknown remote outcome.
        result = await bound.move(requestId, copied.action === 'move' ? copied.input : null, enabled);
      } else {
        const value = await this.command(copied);
        if (!value) return fail(403);
        if (value.action !== copied.action || !('conflict' in value)) return fail(503);
        if (value.conflict) throw new NotebookMoveConflict('move_conflict');
        result = value.result ?? undefined;
      }
      await this.check(request, token, moveFacets);
      return result;
    });
  }
  close(): Promise<void> {
    if (!this.closing) this.closing = this.work.close().then(() => this.persistence.close());
    return this.closing;
  }
}
