import { randomUUID } from 'node:crypto';
import { MAX_MESSAGE_CHARS, type ChatMessageMedia } from '@agentopsdeck/shared';
import { SessionDeletionConflict, TurnAuthorizationError, type TurnQueueCommit } from '../commands/turn-queue.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import type { SdkTextInput } from './sdk-dispatch.js';
import type { SdkAgentId, SdkExecutionJournal } from './sdk-execution-journal.js';
import type { SdkInputAttachment } from './sdk-attachment-input.js';
import { sdkModelAllowed } from './sdk-models.js';
import { isSdkCompactCommand, SdkUnsupportedTextCommand } from './sdk-text-command.js';

export type SdkMessageAdmission = { status: 'queued'; queueDisposition: 'preparing' | 'waiting'; idempotencyKey: string; media: ChatMessageMedia[] };
export type SdkMessageActor = Pick<SdkTextInput, 'actorId' | 'executionGrant'> & {
  signal?: AbortSignal; accept: (result: SdkMessageAdmission) => TurnQueueCommit;
};
export type SdkMessageAdmissionOptions = {
  runtime: SdkAgentId; journal: SdkExecutionJournal; store: ConnectorUserStore;
  assertAvailable: (requireStartup: boolean) => void;
  authorize: (key: string, actor: SdkTextInput, action: 'messages:send') => boolean;
  models: { model?: string; modelChoices?: string[]; dynamicModels?: boolean };
};

/** Same-connection original admission participants. No native executor, RPC
 * callback, cached grant or second receipt. Both legacy and worker use this. */
export function prepareSdkMessageAdmission(options: SdkMessageAdmissionOptions, key: string, text: string,
  actor: SdkMessageActor, attachments: SdkInputAttachment[] = []) {
  if (options.journal.runtime !== options.runtime) throw new Error('SDK command runtime mismatch');
  const { store, journal, runtime } = options;
  const assertSession = () => {
    options.assertAvailable(true);
    if (!journal.session(key)) throw new Error('SDK session not found');
    if (store.commands.sessionDeletion(key) || journal.deletion(key)) throw new SessionDeletionConflict();
    if (store.commands.sessionSettingsPending(key)) throw new Error('SDK session settings are pending');
  };
  assertSession();
  const files = store.sdkAttachments.prepare(attachments);
  if (!text.trim() && files.length) text = '[Attachments]';
  const check = () => {
    assertSession();
    if (!sdkModelAllowed(options.models, journal.session(key)?.model)) {
      throw new SessionDeletionConflict('Session model is no longer allowed; select a current Connector model before sending');
    }
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_MESSAGE_CHARS) throw new Error(`SDK text must contain 1–${MAX_MESSAGE_CHARS} characters`);
    if (isSdkCompactCommand(text)) throw new SdkUnsupportedTextCommand();
    actor.signal?.throwIfAborted();
    if (typeof actor.actorId !== 'string' || !actor.actorId || actor.actorId.startsWith('actor_') || actor.executionGrant
      || !journal.checkPermission(options.authorize, [key, { actorId: actor.actorId, text, images: [] }, 'messages:send'], options)) throw new TurnAuthorizationError();
    if (journal.session(key)!.nativeState === 'unknown' || journal.current(key)?.phase === 'unknown') {
      throw new SessionDeletionConflict('SDK execution outcome is unknown; automatic resend is disabled');
    }
  };
  check();
  const id = randomUUID();
  const result: SdkMessageAdmission = { status: 'queued', queueDisposition:
    !journal.canStart(key) || store.turns.hasPending(runtime, key) ? 'waiting' : 'preparing',
    idempotencyKey: id, media: store.sdkAttachments.metadata(files) };
  const accept = actor.accept(result);
  const commit: TurnQueueCommit = (db, admission) => {
    check(); store.sdkAttachments.save(key, id, files); return accept(db, admission);
  };
  const turn = { id, sessionKey: key, createdAt: Date.now(), payload: {
    actorId: actor.actorId, text, images: [] as [], ...(files.length ? { attachmentCount: files.length } : {}),
  } };
  return { result, turn, commit, check };
}
