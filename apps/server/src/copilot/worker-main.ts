import { waitForPrivateWorkerGroup } from '../connector/private-worker-supervision.js';
import { enterPrivateWorkerScope } from '../connector/private-worker-scope.js';
import { WindowsWorkerJob } from '../connector/windows-worker-job.js';
import { COPILOT_CLI_VERSION, COPILOT_PROTOCOL_VERSION } from './dispatch-adapter.js';
import { verifyCopilotWorker, copilotWorkerOptions } from './worker-environment.js';
import { InteractionWorker } from '../commands/interaction-worker.js';
import { copilotInteractionPolicy } from './interaction-policy.js';
import { readCopilotHistoryTail } from './history-reader.js';
import { CopilotStreamDelivery } from './stream-delivery.js';
import { validateCompactExecution } from '../connector/sdk-compact-worker.js';
import { copilotManualCompactId } from './compact-evidence.js';
import { copilotAttachmentPrompt, normalizeCopilotAttachmentEcho, validateSdkAttachments } from '../connector/sdk-attachment-input.js';
import type { CopilotWorkerCompact } from './worker-protocol.js';
import type { CopilotWorkerDeletion } from './worker-protocol.js';
import { copilotLifecycleFrame, validateCopilotWorkerStart, type CopilotWorkerReply,
  type CopilotWorkerStart, type CopilotWorkerPreflight } from './worker-protocol.js';
import { loadWorkerBoardTools } from '../tools/workspace-board-worker.js';
import { copilotBoardTools } from './board-tools.js';

type Session = { sessionId: string; on(handler: (event: unknown) => void): () => void; send(text: ReturnType<typeof copilotAttachmentPrompt>): Promise<string>;
  abort(): Promise<void>; disconnect(): Promise<void>;
  rpc: { history: { compact(args: { trigger: 'manual' }): Promise<{ success: boolean }>;
    abortManualCompaction(): Promise<unknown> } } };
type Client = { start(): Promise<void>; stop(): Promise<Error[]>; getStatus(): Promise<{ version: string; protocolVersion: number }>;
  listSessions(): Promise<{ sessionId: string }[]>; deleteSession(id: string): Promise<void>;
  createSession(options: Record<string, unknown>): Promise<Session>; resumeSession(id: string, options: Record<string, unknown>): Promise<Session> };
type Sdk = { CopilotClient: new (options: Record<string, unknown>) => Client; RuntimeConnection: { forStdio(): unknown } };
type Control = { interrupt(): Promise<void>; close(): Promise<void> };
const failed = () => new Error('Copilot private worker failed');

/** Child-only, a fresh stdio client per execution; never in-process mode. */
export async function runCopilotWorker(request: CopilotWorkerStart | CopilotWorkerCompact | CopilotWorkerPreflight | CopilotWorkerDeletion,
  emit: (reply: CopilotWorkerReply) => Promise<void>, attach: (control: Control) => void,
  attachInteraction: (worker: InteractionWorker) => void = () => {}) {
  if (process.platform === 'win32') await WindowsWorkerJob.enter(request.config.homeDirectory);
  enterPrivateWorkerScope(request.config.toolPolicy, process.env);
  if (request.kind === 'delete-native') {
    const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
    if (!uuid.test(request.id) || !uuid.test(request.nativeSessionId)) throw failed();
  } else if (request.kind === 'compact') validateCompactExecution(request.execution, 'ghcp');
  else if (request.kind !== 'preflight') validateCopilotWorkerStart(request);
  if (request.kind === 'start') validateSdkAttachments(request.attachments ?? []);
  const entry = await verifyCopilotWorker(request.config, process.env);
  const sdk = await import(entry) as Sdk;
  if (typeof sdk.CopilotClient !== 'function' || typeof sdk.RuntimeConnection?.forStdio !== 'function') throw failed();
  let permissionsOpen = true;
  const interaction = request.kind === 'start' && request.interactionMode === 'interactive'
    ? new InteractionWorker(request.execution.id, request.execution.epoch, emit) : undefined;
  if (interaction) attachInteraction(interaction);
  const board = request.kind === 'start' ? await loadWorkerBoardTools(request.config.boardToolsDirectory, 'ghcp', request.execution.nativeSessionId, () => permissionsOpen) : undefined;
  const options = await copilotWorkerOptions(request.config, () => permissionsOpen, board && request.kind === 'start' ? request.execution.nativeSessionId : undefined,
    request.kind === 'start' ? request.taskFiles : undefined, interaction && request.kind === 'start' ? request.execution.nativeSessionId : undefined);
  const sessionOptions = { ...options.session,
    ...(interaction && request.kind === 'start' ? copilotInteractionPolicy(options.session, interaction, request.execution.nativeSessionId, () => permissionsOpen) : {}),
    ...(board && request.kind === 'start' ? { tools: copilotBoardTools(board, request.execution.nativeSessionId) } : {}) };
  const client = new sdk.CopilotClient({ ...options.client, connection: sdk.RuntimeConnection.forStdio() });
  let session: Session | undefined, stopped = false, stopping: Promise<void> | undefined;
  const close = () => { permissionsOpen = false; interaction?.close(); board?.close(); return stopping ??= (async () => { stopped = true; if ((await client.stop()).length) throw failed(); })(); };
  attach({ interrupt: async () => {
    permissionsOpen = false;
    interaction?.close();
    board?.close();
    if (!session || stopped) throw failed();
    if (request.kind === 'compact') await session.rpc.history.abortManualCompaction();
    else await session.abort();
  }, close });
  let unsubscribe = () => {}, delivery: CopilotStreamDelivery | undefined;
  try {
    await client.start();
    const status = await client.getStatus();
    if (stopped || status.version !== COPILOT_CLI_VERSION || status.protocolVersion !== COPILOT_PROTOCOL_VERSION) throw failed();
    if (request.kind === 'preflight') {
      await close(); await waitForPrivateWorkerGroup();
      await emit({ kind: 'preflight-complete' }); return;
    }
    if (request.kind === 'delete-native') {
      if (!(await client.listSessions()).some(row => row.sessionId === request.nativeSessionId)) throw failed();
      await client.deleteSession(request.nativeSessionId);
      if ((await client.listSessions()).some(row => row.sessionId === request.nativeSessionId)) throw failed();
      await close(); await waitForPrivateWorkerGroup();
      await emit({ kind: 'delete-complete', id: request.id, nativeSessionId: request.nativeSessionId }); return;
    }
    const sessionId = request.execution.nativeSessionId;
    session = request.execution.nativeMode === 'create'
      ? await client.createSession({ ...sessionOptions, sessionId }) : await client.resumeSession(sessionId, sessionOptions);
    if (stopped || session.sessionId !== sessionId) throw failed();
    if (request.kind === 'compact') {
      let completionEventId: string | undefined, invalid = false;
      unsubscribe = session.on(value => {
        try {
          const id = copilotManualCompactId(value);
          if (id) { if (completionEventId) throw failed(); completionEventId = id; }
        } catch { invalid = true; }
      });
      const result = await session.rpc.history.compact({ trigger: 'manual' });
      if (invalid || result.success !== true || !completionEventId) throw failed();
      unsubscribe(); unsubscribe = () => {};
      await session.disconnect(); await close(); await waitForPrivateWorkerGroup();
      const history = await readCopilotHistoryTail(request.config.homeDirectory, sessionId);
      if (!history.compactIds.includes(completionEventId)) throw failed();
      const execution = request.execution;
      await emit({ kind: 'compact-finished', proof: { id: execution.id, key: execution.key, epoch: execution.epoch,
        nativeSessionId: sessionId, nativeRequestId: execution.id, completionEventId, outcome: 'completed' } });
      return;
    }
    await emit({ kind: 'verified', sessionId, version: status.version, protocolVersion: status.protocolVersion });
    let complete!: () => void, reject!: (error: Error) => void, sawUser = false, idle = false, invalid = false;
    const finished = new Promise<void>((resolve, fail) => { complete = resolve; reject = fail; });
    void finished.catch(() => {});
    delivery = new CopilotStreamDelivery(emit, () => { invalid = true; reject(failed()); }, 50, sessionId);
    unsubscribe = session.on(value => {
      try {
        const event = copilotLifecycleFrame(value);
        if (!idle) delivery!.send(normalizeCopilotAttachmentEcho(value, request.text, request.attachments ?? [], request.context));
        if (!['user.message', 'assistant.message', 'tool.execution_start', 'tool.execution_complete', 'session.error', 'session.idle'].includes(event.type)) return;
        if (idle) throw failed();
        const root = event.agentId === undefined && event.data.parentToolCallId === undefined;
        if (root && event.type === 'user.message') sawUser = true;
        if (root && event.type === 'session.idle' && sawUser) { permissionsOpen = false; board?.close(); idle = true; complete(); }
        if (root && event.type === 'session.error' && !sawUser) reject(failed());
      } catch { invalid = true; reject(failed()); }
    });
    // Exactly one send. Neither ACK loss nor disconnect retries a prompt.
    validateSdkAttachments(request.attachments ?? []);
    const messageId = await session.send(copilotAttachmentPrompt(request.text, request.attachments, request.context));
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(messageId)) throw failed();
    await emit({ kind: 'admitted', messageId });
    await finished; await delivery.finish();
    if (invalid) throw failed();
    unsubscribe(); unsubscribe = () => {};
    await session.disconnect(); await close(); await waitForPrivateWorkerGroup();
    const history = await readCopilotHistoryTail(request.config.homeDirectory, sessionId);
    await emit({ kind: 'finished', sessionId, history: history.entries });
  } finally { unsubscribe(); delivery?.dispose(); await close(); }
}

if (process.send) {
  let started = false, closing = false, compactMode = false, control: Control | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let interaction: InteractionWorker | undefined;
  const emit = (reply: CopilotWorkerReply) => new Promise<void>((resolve, reject) => {
    if (!process.connected || !process.send) { reject(failed()); return; }
    process.send(reply, error => error ? reject(failed()) : resolve());
  });
  const shutdown = () => {
    if (closing) return;
    closing = true;
    interaction?.close();
    void control?.close().catch(() => {});
    // Referenced deadline retains the group leader after IPC loss until its
    // descendants drain. Never signal a saved PID after the leader exits.
    timer = setTimeout(() => { if (process.platform === 'win32') { WindowsWorkerJob.terminate(); process.exit(1); } else process.kill(-process.pid, 'SIGKILL'); }, 12_000);
  };
  process.on('disconnect', shutdown); process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  process.on('message', message => {
    const value = message as { kind?: string };
    if (typeof value?.kind === 'string' && value.kind.startsWith('interaction-') && interaction && !closing) {
      void interaction.receive(message).then(ok => { if (!ok) shutdown(); }, shutdown); return;
    }
    if ((value?.kind === 'interrupt' && !compactMode || value?.kind === 'interrupt-compact' && compactMode) && started && control && !closing) {
      void control.interrupt().then(() => emit({ kind: 'interrupted' })).catch(() => emit({ kind: 'failed' })).catch(shutdown); return;
    }
    if (started || closing || !['start', 'compact', 'preflight', 'delete-native'].includes(value?.kind ?? '')) { void emit({ kind: 'failed' }).catch(shutdown); return; }
    started = true;
    compactMode = value.kind === 'compact';
    void runCopilotWorker(message as CopilotWorkerStart | CopilotWorkerCompact | CopilotWorkerPreflight | CopilotWorkerDeletion, emit, value => {
      control = value; if (closing) void control.close().catch(() => {});
    }, value => { interaction = value; if (closing) value.close(); }).then(() => { process.exitCode = 0; }, async () => { process.exitCode = 1; await emit({ kind: 'failed' }).catch(() => {}); })
      .finally(async () => {
        shutdown();
        try {
          await waitForPrivateWorkerGroup();
          if (process.platform === 'win32') await WindowsWorkerJob.release();
        } catch { process.exitCode = 1; return; }
        clearTimeout(timer); if (process.connected) process.disconnect();
      });
  });
}
