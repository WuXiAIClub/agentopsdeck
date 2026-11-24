import { spawn, type ChildProcess } from 'node:child_process';
import { dirname } from 'node:path';
import { validTurnFiles } from '../connector/sdk-turn-context.js';
import { enterPrivateWorkerScope } from '../connector/private-worker-scope.js';
import { WindowsWorkerJob } from '../connector/windows-worker-job.js';
import { MAX_MESSAGE_CHARS } from '@agentopsdeck/shared';
import { BOARD_CONTEXT_MAX_CHARS } from '../connector/workspace-board-file-format.js';
import { verifyClaudeWorker, readClaudeWorkerKey } from './worker-environment.js';
import { assertClaudeWorkerPolicy, claudeWorkerSettings } from './worker-policy.js';
import { waitForClaudeWorkerGroup } from './worker-supervision.js';
import { ClaudeStreamDelivery } from './stream-delivery.js';
import { claudeToolPolicy } from './tool-policy.js';
import { ClaudeCompactEvidence } from './compact-evidence.js';
import { claudeAttachmentPrompt, normalizeClaudeAttachmentEcho, validateSdkAttachments } from '../connector/sdk-attachment-input.js';
import { validateCompactExecution } from '../connector/sdk-compact-worker.js';
import type { ClaudeWorkerCompact } from './worker-protocol.js';
import type { ClaudeWorkerDeletion } from './worker-protocol.js';
import { type ClaudeWorkerReply, type ClaudeWorkerStart, type ClaudeWorkerPreflightRequest, type ClaudeHistoryIdentity, type ClaudeWorkerFailureCode } from './worker-protocol.js';
import { loadWorkerBoardTools } from '../tools/workspace-board-worker.js';
import { claudeBoardServer, type BoardMcpSdk } from './board-tools.js';
import { InteractionWorker } from '../commands/interaction-worker.js';
import { claudeInteractionPolicy } from './interaction-policy.js';

type Query = AsyncIterable<unknown> & { interrupt(): Promise<void>; close(): void; initializationResult(): Promise<unknown> };
type NativeOptions = { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal };
type Sdk = BoardMcpSdk & { query(args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }): Query;
  getSessionInfo(id: string, options: { dir: string }): Promise<{ sessionId: string } | undefined>;
  deleteSession(id: string, options: { dir: string }): Promise<void>;
  resolveSettings(options: { cwd: string; settingSources: string[] }): Promise<unknown>;
  getSessionMessages(id: string, options: { dir: string; limit: number; includeSystemMessages?: boolean }): Promise<ClaudeHistoryIdentity[]> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One execution, one private worker, one native query. No native automatic
 * pending queue, user configuration, shell tools, hooks, plugins or MCP.
 * File tools require explicit Connector-local opt-in. NOT an OS sandbox. */
export async function runClaudeWorker(request: ClaudeWorkerStart | ClaudeWorkerCompact | ClaudeWorkerPreflightRequest | ClaudeWorkerDeletion,
  emit: (event: ClaudeWorkerReply) => Promise<void>, attach: (query: Query) => void,
  stage: (value: ClaudeWorkerFailureCode) => void = () => {}, attachInteraction: (worker: InteractionWorker) => void = () => {}) {
  const { config } = request;
  if (process.platform === 'win32') await WindowsWorkerJob.enter(config.homeDirectory);
  enterPrivateWorkerScope(config.toolPolicy, process.env);
  const attachments = request.kind === 'start' ? request.attachments ?? [] : [];
  validateSdkAttachments(attachments);
  if (request.kind === 'delete-native' && (!uuid.test(request.id) || !uuid.test(request.nativeSessionId))) throw new Error('Invalid deletion identity');
  if (request.kind === 'compact') validateCompactExecution(request.execution, 'claude-code');
  if (request.kind !== 'compact' && request.kind !== 'preflight' && request.kind !== 'delete-native' && (request.kind !== 'start' || request.execution.kind === 'compact' || !uuid.test(request.execution.id)
    || !uuid.test(request.execution.nativeSessionId) || !request.execution.key.startsWith('claude-code:')
    || !['create', 'resume'].includes(request.execution.nativeMode)
    || typeof request.text !== 'string' || !request.text.trim() || request.text.length > MAX_MESSAGE_CHARS
    || request.context !== undefined && (typeof request.context !== 'string' || request.context.length > BOARD_CONTEXT_MAX_CHARS)
    || request.taskFiles !== undefined && !validTurnFiles(request.taskFiles)
    || request.interactionMode !== undefined && !['automatic', 'interactive'].includes(request.interactionMode))) {
    throw new Error('Invalid Claude worker request');
  }
  const entry = await verifyClaudeWorker(config, process.env);
  // Dynamic import only AFTER child environment verification. This module
  // never imports the SDK into the Hub process or reads its account store.
  const sdk = await import(entry) as Sdk;
  if (request.kind === 'delete-native') {
    // No query, model call or credential read. Do not interpret missing or
    // unreadable materialized history as a successful deletion.
    const options = { dir: config.workspace };
    if (typeof sdk.getSessionInfo !== 'function' || typeof sdk.deleteSession !== 'function'
      || (await sdk.getSessionInfo(request.nativeSessionId, options))?.sessionId !== request.nativeSessionId) {
      throw new Error('Native deletion target cannot be verified');
    }
    await sdk.deleteSession(request.nativeSessionId, options);
    if (await sdk.getSessionInfo(request.nativeSessionId, options) !== undefined) throw new Error('Native deletion unconfirmed');
    await emit({ kind: 'delete-complete', id: request.id, nativeSessionId: request.nativeSessionId });
    return;
  }
  if (typeof sdk.query !== 'function' || typeof sdk.getSessionMessages !== 'function'
    || typeof sdk.resolveSettings !== 'function') throw new Error('Invalid Claude SDK');
  // A private HOME and settingSources:[] do not disable machine policy. Do
  // not read credentials or launch native execution until it is checked.
  stage('policy');
  assertClaudeWorkerPolicy(await sdk.resolveSettings({ cwd: config.workspace, settingSources: [] }));
  let permissionsOpen = true;
  const interaction = request.kind === 'start' && request.interactionMode === 'interactive'
    ? new InteractionWorker(request.execution.id, request.execution.epoch, emit) : undefined;
  if (interaction) attachInteraction(interaction);
  const board = request.kind === 'start' ? await loadWorkerBoardTools(config.boardToolsDirectory, 'claude-code', request.execution.nativeSessionId, () => permissionsOpen) : undefined;
  const taskFiles = request.kind === 'start' ? request.taskFiles ?? [] : [];
  const basePolicy = claudeToolPolicy(config, () => permissionsOpen, !!board, taskFiles);
  const toolPolicy = interaction ? claudeInteractionPolicy(basePolicy, interaction, () => permissionsOpen) : basePolicy;
  const mcpServers = board ? { agentopsdeck_board: claudeBoardServer(entry, sdk, board) } : {};
  stage('credential');
  const key = await readClaudeWorkerKey(config.apiKeyFile);
  let native: ChildProcess | undefined, exit: Promise<void> | undefined, exited = false;
  let streamError = false;
  let releasePrompt!: () => void;
  const promptClosed = new Promise<void>(resolve => { releasePrompt = resolve; });
  async function* prompt() {
    if (request.kind !== 'start' && request.kind !== 'compact') { await promptClosed; return; }
    const { execution } = request;
    const text = request.kind === 'compact' ? '/compact' : claudeAttachmentPrompt(request.text, attachments, request.kind === 'start' ? request.context : undefined);
    yield { type: 'user', uuid: execution.id, session_id: execution.nativeSessionId,
      parent_tool_use_id: null, message: { role: 'user', content: text } };
  }
  stage('native');
  const query = sdk.query({ prompt: prompt(), options: {
    cwd: config.workspace, env: { ...process.env, ANTHROPIC_API_KEY: key }, settingSources: [],
    // Native directory gate plus mandatory ask callback. The callback permits
    // only exact existing bound files, not sibling files or directory searches.
    ...(taskFiles.length ? { additionalDirectories: [...new Set(taskFiles.map(path => dirname(path)))] } : {}),
    tools: toolPolicy.tools, skills: [], agents: {}, plugins: [], mcpServers, strictMcpConfig: true,
    hooks: {}, settings: { ...claudeWorkerSettings, permissions: toolPolicy.permissions },
    permissionMode: 'default', canUseTool: toolPolicy.canUseTool,
    // Ordinary user text cannot execute slash controls. Only this dedicated,
    // owner-authorized fixed /compact operation enables native interpretation.
    verbatimPrompts: request.kind !== 'compact', model: config.model, includePartialMessages: true, persistSession: request.kind !== 'preflight',
    // Request native input acknowledgments in the stream. Without this the
    // CLI persists inputs, but may emit only assistant frames; settling then
    // removes the queue row before the UI has a durable user projection.
    extraArgs: { 'replay-user-messages': null },
    ...(request.kind === 'preflight' ? {} : request.execution.nativeMode === 'resume'
      ? { resume: request.execution.nativeSessionId } : { sessionId: request.execution.nativeSessionId }),
    // No diagnostic callback forwarding. Native stderr may contain secrets.
    spawnClaudeCodeProcess(options: NativeOptions) {
      if (native) throw new Error('Claude attempted a second native process');
      native = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: 'pipe', signal: options.signal, windowsHide: true, shell: false });
      native.stderr?.resume();
      exit = new Promise<void>(resolve => {
        native!.once('exit', () => { exited = true; resolve(); });
        native!.once('error', () => { if (!native?.pid) resolve(); });
      });
      return native;
    },
  } });
  // Give the owner a control facade: close/interrupt revoke permissions
  // synchronously, before waiting on native control acknowledgements.
  attach({
    [Symbol.asyncIterator]: () => query[Symbol.asyncIterator](),
    initializationResult: () => query.initializationResult(),
    interrupt: () => { permissionsOpen = false; interaction?.close(); board?.close(); return query.interrupt(); },
    close: () => { permissionsOpen = false; interaction?.close(); board?.close(); query.close(); },
  });
  let protocolError = false;
  const compact = request.kind === 'compact' ? new ClaudeCompactEvidence(request.execution.nativeSessionId, request.execution.id) : undefined;
  const delivery = request.kind === 'start' ? new ClaudeStreamDelivery(request.execution.nativeSessionId, emit,
    () => { permissionsOpen = false; board?.close(); protocolError = true; query.close(); }) : undefined;
  try {
    if (request.kind === 'preflight') {
      // The streaming prompt stays empty until close. Only initialize the
      // control channel; do not create a model request or persist a session.
      const initialized = await query.initializationResult();
      if (!initialized || typeof initialized !== 'object' || !('models' in initialized)
        || !Array.isArray(initialized.models) || !('commands' in initialized)
        || !Array.isArray(initialized.commands)) throw new Error('Invalid Claude initialization');
      // No account info, model metadata or native diagnostics leave worker.
    } else {
      try {
        for await (const event of query) {
          try {
            if (compact) compact.observe(event);
            else await delivery!.send(request.kind === 'start'
              ? normalizeClaudeAttachmentEcho(event, request.execution, request.text, attachments, request.context) : event);
          }
          catch { protocolError = true; throw new Error('Invalid Claude worker stream'); }
        }
      } catch { streamError = true; }
    }
  } finally {
    permissionsOpen = false;
    interaction?.close();
    board?.close();
    try { await delivery?.finish(); } catch { protocolError = true; }
    releasePrompt();
    query.close();
    if (exit) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([exit, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Native exit unconfirmed')), 10_000); })]); }
      finally { clearTimeout(timer); }
    }
  }
  if (protocolError || !exited) throw new Error('Native Claude completion unconfirmed');
  stage('process-group');
  await waitForClaudeWorkerGroup();
  if (request.kind === 'preflight') { await emit({ kind: 'preflight-complete' }); return; }
  const { execution } = request;
  // Bounded identity proof, not the UI transcript. SDK disk-read cost still
  // needs separate large-history acceptance before public runtime enablement.
  stage('history');
  if (request.kind === 'compact') {
    if (streamError) throw new Error('Compact stream unconfirmed');
    const rows = await sdk.getSessionMessages(execution.nativeSessionId, { dir: config.workspace, limit: 10_000, includeSystemMessages: true });
    const completionEventId = compact!.persisted(rows);
    await emit({ kind: 'compact-finished', proof: { id: execution.id, key: execution.key, epoch: execution.epoch,
      nativeSessionId: execution.nativeSessionId, nativeRequestId: execution.id, completionEventId, outcome: 'completed' } });
    return;
  }
  const rows = await sdk.getSessionMessages(execution.nativeSessionId, { dir: config.workspace, limit: 10_000 });
  if (!Array.isArray(rows) || rows.length > 10_000) throw new Error('Claude history proof exceeds limit');
  const history = rows.map(row => {
    if (!['user', 'assistant'].includes(row.type) || typeof row.uuid !== 'string' || row.uuid.length > 512
      || row.session_id !== execution.nativeSessionId
      || row.parent_tool_use_id !== null && (typeof row.parent_tool_use_id !== 'string' || row.parent_tool_use_id.length > 512)) {
      throw new Error('Invalid Claude history identity');
    }
    return { type: row.type, uuid: row.uuid, session_id: row.session_id, parent_tool_use_id: row.parent_tool_use_id };
  });
  await emit({ kind: 'finished', history, streamError });
}

if (process.send) {
  let started = false, closing = false, compactMode = false, query: Query | undefined;
  let interaction: InteractionWorker | undefined;
  let completion: { id: string; nativeSessionId: string; resolve(): void; reject(error: Error): void } | undefined;
  let executionIdentity: { id: string; nativeSessionId: string } | undefined;
  let completionRejected = false;
  const send = (event: ClaudeWorkerReply) => new Promise<void>((resolve, reject) => {
    if (!process.connected) { reject(new Error('Worker disconnected')); return; }
    process.send!(event, error => error ? reject(new Error('Worker disconnected')) : resolve());
  });
  const emit = async (event: ClaudeWorkerReply) => {
    if (event.kind !== 'finished') return send(event);
    const identity = executionIdentity;
    if (!identity || completion) throw new Error('Invalid worker completion handshake');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const acknowledged = new Promise<void>((resolve, reject) => {
      completion = { ...identity, resolve, reject };
      timer = setTimeout(() => reject(new Error('Worker completion acknowledgment unconfirmed')), 12_000);
    });
    void acknowledged.catch(() => {});
    // Keep the worker alive until the original parent has validated history.
    // A send callback alone does not prove a busy Windows parent received it.
    try {
      await send(event); await acknowledged;
      if (completionRejected) throw new Error('Invalid worker completion acknowledgment');
    }
    finally { clearTimeout(timer); completion = undefined; }
  };
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    completion?.reject(new Error('Worker completion interrupted'));
    interaction?.close();
    try { query?.close(); } catch { /* Never log native errors. */ }
    // This process is the leader of its dedicated group. The parent also
    // owns cleanup; this deadline covers loss of that parent/IPC connection.
    // Keep the leader alive, even after IPC loss, until cleanup is proven.
    // An unref timer would let orphan native descendants outlive this worker.
    shutdownTimer = setTimeout(() => {
      if (process.platform === 'win32') { WindowsWorkerJob.terminate(); process.exit(1); }
      else process.kill(-process.pid, 'SIGKILL');
    }, 12_000);
  };
  process.on('disconnect', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('message', message => {
    const input = message as { kind?: string };
    if (input?.kind === 'finished-ack') {
      const ack = message as import('./worker-protocol.js').ClaudeWorkerCompletionAck;
      if (!completion || !ack || typeof ack !== 'object' || Array.isArray(ack) || Object.keys(ack).length !== 3
        || ack.id !== completion.id || ack.nativeSessionId !== completion.nativeSessionId || closing) {
        completionRejected = true; process.exitCode = 1;
        shutdown(); return;
      }
      const pending = completion; completion = undefined; pending.resolve(); return;
    }
    if (typeof input?.kind === 'string' && input.kind.startsWith('interaction-') && interaction && !closing) {
      void interaction.receive(message).then(ok => { if (!ok) shutdown(); }, shutdown); return;
    }
    if ((input?.kind === 'interrupt' && !compactMode || input?.kind === 'interrupt-compact' && compactMode) && started && query && !closing) {
      void query.interrupt().then(() => emit({ kind: 'interrupted' })).catch(() => emit({ kind: 'failed' })).catch(shutdown);
      return;
    }
    if (started || !['start', 'compact', 'preflight', 'delete-native'].includes(input?.kind ?? '') || closing) { void emit({ kind: 'failed' }).catch(shutdown); return; }
    started = true;
    compactMode = input.kind === 'compact';
    if (input.kind === 'start') {
      const request = message as ClaudeWorkerStart;
      executionIdentity = { id: request.execution?.id, nativeSessionId: request.execution?.nativeSessionId };
    }
    let stage: ClaudeWorkerFailureCode = 'configuration';
    let failedPreflight = false;
    void runClaudeWorker(message as ClaudeWorkerStart | ClaudeWorkerCompact | ClaudeWorkerPreflightRequest | ClaudeWorkerDeletion, emit, value => {
      query = value;
      if (closing) query.close();
    }, value => { stage = value; }, value => { interaction = value; if (closing) value.close(); }).then(() => { process.exitCode = completionRejected ? 1 : 0; }, async () => {
      process.exitCode = 1;
      if (input.kind === 'preflight') { failedPreflight = true; return; }
      await emit({ kind: 'failed', code: stage }).catch(() => {});
    }).finally(async () => {
      shutdown();
      try {
        await waitForClaudeWorkerGroup();
        if (process.platform === 'win32') await WindowsWorkerJob.release();
        if (failedPreflight) await emit({ kind: 'preflight-failed' });
      }
      catch {
        process.exitCode = 1;
        // Keep the referenced group-kill deadline; never exit normally with
        // descendants still running or ownership unconfirmed.
        return;
      }
      clearTimeout(shutdownTimer);
      if (process.connected) process.disconnect();
    });
  });
}
