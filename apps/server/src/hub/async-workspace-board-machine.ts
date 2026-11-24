import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait, AuthReadCancelledError } from '../auth/route-read-wait.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { HubMemberRequestError } from './async-member-request.js';
import { encodeHubMemberJson, type AsyncHubMemberOwner } from './async-member-owner.js';
import { HUB_BOARD_MACHINE_RPC_BYTES, validHubBoardMachineCommand, validHubBoardMachineReply, hubBoardMachineReplyExpectation,
  type HubBoardMachineCommand } from './member-board-machine-domain.js';
import type { BoardAgentWrite } from './workspace-board-capabilities.js';
import type { BoardAgentRead } from './workspace-board-read.js';
import { HubRequestWork } from './async-request-work.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';

/** Awaited original-owner machine port, never a peer database writer.
 * Native file-managed updates remain denied by the original machine store.
 * No human credentials, caller user IDs, SQL or effect callbacks are accepted. */
export class AsyncHubWorkspaceBoardMachine {
  private readonly persistence: AuthRoutePersistence;
  private readonly reads: AuthRouteReadWait;
  private readonly work = new HubRequestWork();
  readonly close: () => Promise<void>;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>,
    diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30_000, timeoutMs = 30_000) {
    this.persistence = new AuthRoutePersistence(diagnostics, warningMs);
    this.reads = new AuthRouteReadWait(this.persistence, diagnostics, timeoutMs);
    const drain = createIndependentDrain([() => this.work.close(), () => this.persistence.close()],
      'hub-route-drain', diagnostics);
    this.close = () => { void this.work.close(); return drain(); };
  }
  get pending() { return this.persistence.pending; }
  get pendingWork() { return this.work.pending; }
  private async run(original: HubBoardMachineCommand, request?: Request) {
    this.work.check();
    let command: HubBoardMachineCommand;
    try {
      command = JSON.parse(encodeHubMemberJson(original, HUB_BOARD_MACHINE_RPC_BYTES));
      if (!validHubBoardMachineCommand(command)) throw Error('invalid');
    } catch { throw new HubMemberRequestError(400); }
    const expected = hubBoardMachineReplyExpectation(command);
    const work = () => this.owner.command('boardMachine', command);
    try {
      const value = command.action === 'update' ? (await this.persistence.run(70, work)).value
        : (await this.reads.run(request ?? new Request('http://localhost/'), 69, work)).value;
      this.work.check();
      if (!validHubBoardMachineReply(expected, value)) throw Error('invalid_owner_reply');
      return value;
    } catch (error) { throw new HubMemberRequestError(error instanceof AuthReadCancelledError ? 499 : 503); }
  }
  readonly authorized = (token: string, request?: Request): Promise<boolean> =>
    this.work.run(() => this.authorizedOriginal(token, request));
  private async authorizedOriginal(token: string, request?: Request): Promise<boolean> {
    const value = await this.run({ action: 'authorized', token }, request);
    if (value.action !== 'authorized') throw new HubMemberRequestError(503);
    return value.authorized;
  }
  readonly read = (token: string, query: BoardAgentRead = {}, request?: Request) =>
    this.work.run(() => this.readOriginal(token, query, request));
  private async readOriginal(token: string, query: BoardAgentRead, request?: Request) {
    const value = await this.run({ action: 'read', token, query }, request);
    if (value.action !== 'read') throw new HubMemberRequestError(503);
    // Recheck current capability before publishing; no projection/content is
    // released on a now-revoked or expired bearer. This is delivery, not replay.
    if (value.snapshot === null || !await this.authorizedOriginal(token, request)) return undefined;
    return value.snapshot;
  }
  readonly update = (token: string, document: BoardAgentWrite, request?: Request) =>
    this.work.run(() => this.updateOriginal(token, document, request));
  private async updateOriginal(token: string, document: BoardAgentWrite, request?: Request) {
    const value = await this.run({ action: 'update', token, document }, request);
    if (value.action !== 'update') throw new HubMemberRequestError(503);
    if (value.result.status === 'denied') return value.result;
    // A disconnected HTTP request cannot cancel an accepted mutation. A later
    // delivery denial never erases the original durable mutation receipt.
    return await this.authorizedOriginal(token) ? value.result : { status: 'denied' as const };
  }
}
