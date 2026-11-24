import type { ConnectorTokenStore } from '../auth/connector-token.js';
import type { TurnQueue } from '../commands/turn-queue.js';
import type { MirrorOutbox } from '../messages/mirror.js';
import { ExecutionGrantCapacity, ExecutionGrantConflict, ExecutionGrantInvalid, ExecutionIssuerDenied,
  type ExecutionAction, type ExecutionGrantBinding, type ExecutionGrantRef, type ExecutionGrants } from './execution-grants.js';

type Evidence = { authorization: string; expectedNode: string };
export type GrantIssuer = { nodeId: string; issuerTokenId: string; hubId: string };
export type GrantFailure = { status: 400 | 403 | 409 | 503; error: string };
export type GrantReply<T> = GrantFailure | { status: 200; value: T };
export type ConnectorGrantCommands = {
  authorizedGrantIssuer: { input: Evidence; output: GrantReply<GrantIssuer> };
  authorizedGrantCreation: { input: Evidence; output: GrantReply<GrantIssuer & { creationAllowed: boolean }> };
  authorizedGrantIssue: { input: Evidence & { body: unknown }; output: GrantReply<GrantIssuer & { grant: ExecutionGrantRef; leaseMs?: number }> };
  authorizedGrantRevoke: { input: Evidence & { body: unknown }; output: GrantReply<GrantIssuer & { revokedThroughVersion: number }> };
  authorizedGrantUsage: { input: Evidence & { body: unknown }; output: GrantReply<GrantIssuer & { usage: { id: string; needed: boolean }[] }> };
  localRetiredGrantRevoke: { input: { expectedNode: string; issuerTokenId: string; hubId: string; body: unknown }; output: GrantReply<GrantIssuer & { revokedThroughVersion: number }> };
};
export type ConnectorGrantKind = keyof ConnectorGrantCommands;
export type ConnectorHttpGrantKind = Exclude<ConnectorGrantKind, 'localRetiredGrantRevoke'>;
export const connectorGrantSteps: Readonly<Record<ConnectorGrantKind, number>> = Object.freeze({
  authorizedGrantIssuer: 30, authorizedGrantCreation: 31, authorizedGrantIssue: 32,
  authorizedGrantRevoke: 33, authorizedGrantUsage: 34, localRetiredGrantRevoke: 369,
});
export const isConnectorGrantKind = (kind: string): kind is ConnectorGrantKind => Object.hasOwn(connectorGrantSteps, kind);
const record = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && required.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 1;
const mutation = (kind: ConnectorGrantKind) => kind !== 'authorizedGrantIssuer' && kind !== 'authorizedGrantCreation';
export function validConnectorGrantInput(kind: ConnectorGrantKind, v: unknown): boolean {
  if (kind === 'localRetiredGrantRevoke') {
    return record(v, ['expectedNode', 'issuerTokenId', 'hubId', 'body'])
      && typeof v.expectedNode === 'string' && Buffer.byteLength(v.expectedNode) <= 4096
      && text(v.issuerTokenId) && Buffer.byteLength(v.issuerTokenId) <= 256 && !/[\0\r\n]/.test(v.issuerTokenId)
      && text(v.hubId) && Buffer.byteLength(v.hubId) <= 256 && !/[\0\r\n]/.test(v.hubId);
  }
  return record(v, ['authorization', 'expectedNode', ...(mutation(kind) ? ['body'] : [])])
    && typeof v.authorization === 'string' && Buffer.byteLength(v.authorization) <= 4096 && !/[\0\r\n]/.test(v.authorization)
    && typeof v.expectedNode === 'string' && Buffer.byteLength(v.expectedNode) <= 4096;
}
const errors = {
  'Trusted delegation issuer required': 403, 'Verified Connector identity required': 409,
  'Invalid execution usage fields': 400, 'Invalid execution usage batch': 400,
  'Execution usage is not authorized': 403, 'Execution usage unavailable': 503,
  'Invalid execution grant fields': 400, 'Invalid relative execution lease': 400,
  'Invalid execution binding': 400, 'Invalid execution actions': 400, 'Execution lease exceeds bound': 400,
  'Delegation issuer authorization changed': 403, 'Execution grant version or policy conflicts': 409,
  'Execution grant capacity reached': 503, 'Execution grant storage unavailable': 503,
} as const;
export function validConnectorGrantOutput(kind: ConnectorGrantKind, v: unknown): boolean {
  if (record(v, ['status', 'error'])) return typeof v.error === 'string' && Object.hasOwn(errors, v.error)
    && errors[v.error as keyof typeof errors] === v.status;
  if (!record(v, ['status', 'value']) || v.status !== 200) return false;
  const value = v.value;
  const fields = kind === 'authorizedGrantIssuer' ? [] : kind === 'authorizedGrantCreation' ? ['creationAllowed']
    : kind === 'authorizedGrantIssue' ? ['grant']
    : (kind === 'authorizedGrantRevoke' || kind === 'localRetiredGrantRevoke') ? ['revokedThroughVersion'] : ['usage'];
  if (!record(value, ['nodeId', 'issuerTokenId', 'hubId', ...fields], kind === 'authorizedGrantIssue' ? ['leaseMs'] : [])
    || !text(value.nodeId) || !text(value.issuerTokenId) || !text(value.hubId)) return false;
  switch (kind) {
    case 'authorizedGrantIssuer': return true;
    case 'authorizedGrantCreation': return typeof value.creationAllowed === 'boolean';
    case 'authorizedGrantIssue': return record(value.grant, ['id', 'actorId']) && text(value.grant.id) && text(value.grant.actorId)
      && (!Object.hasOwn(value, 'leaseMs') || integer(value.leaseMs) && value.leaseMs <= 60_000);
    case 'localRetiredGrantRevoke':
    case 'authorizedGrantRevoke': return integer(value.revokedThroughVersion);
    case 'authorizedGrantUsage': return Array.isArray(value.usage) && value.usage.length <= 32
      && value.usage.every(row => record(row, ['id', 'needed']) && text(row.id) && typeof row.needed === 'boolean');
  }
}
export type ConnectorGrantDependencies = {
  nodeId: string; tokens: ConnectorTokenStore; grants: ExecutionGrants; now?: () => number;
  turns?: Pick<TurnQueue, 'usesExecutionGrant'>; mirrorOutbox?: Pick<MirrorOutbox, 'usesExecutionGrant'>;
};
const failure = (error: keyof typeof errors): GrantFailure => ({ status: errors[error], error });

/** One original owner execution turn: credential, Hub binding, grant mutation
 * and shared queue/outbox observation have no await between them. No caller
 * principal, issuer ID, permission boolean or transaction callback is trusted.
 * Preflight issuer replies are observations, not authority for later commands. */
export function executeConnectorGrant<K extends ConnectorGrantKind>(kind: K, input: ConnectorGrantCommands[K]['input'],
  deps: ConnectorGrantDependencies): ConnectorGrantCommands[K]['output'] {
  const run = (): GrantReply<Record<string, unknown>> => {
    if (kind === 'localRetiredGrantRevoke') {
      const localInput = input as ConnectorGrantCommands['localRetiredGrantRevoke']['input'];
      if (localInput.expectedNode !== deps.nodeId) return failure('Verified Connector identity required');
      if (!deps.tokens.canRetireDelegationIssuer(localInput.issuerTokenId, localInput.hubId)) {
        return failure('Trusted delegation issuer required');
      }
      const body = localInput.body;
      if (!record(body, [], ['principalId', 'grantKey', 'version', 'runtime', 'sessionKey'])) {
        return failure('Invalid execution grant fields');
      }
      const binding = {
        issuerTokenId: localInput.issuerTokenId,
        hubId: localInput.hubId,
        principalId: body.principalId,
        grantKey: body.grantKey,
        version: body.version,
        runtime: body.runtime,
        sessionKey: body.sessionKey,
      } as ExecutionGrantBinding;
      try {
        deps.grants.revokeVersion(binding);
        return {
          status: 200,
          value: {
            nodeId: deps.nodeId,
            issuerTokenId: localInput.issuerTokenId,
            hubId: localInput.hubId,
            revokedThroughVersion: binding.version,
          },
        };
      } catch (error) {
        if (error instanceof ExecutionGrantInvalid) return failure(Object.hasOwn(errors, error.message)
          ? error.message as keyof typeof errors : 'Invalid execution grant fields');
        if (error instanceof ExecutionIssuerDenied) return failure('Delegation issuer authorization changed');
        if (error instanceof ExecutionGrantConflict) return failure('Execution grant version or policy conflicts');
        if (error instanceof ExecutionGrantCapacity) return failure('Execution grant capacity reached');
        return failure('Execution grant storage unavailable');
      }
    }
    const httpInput = input as Evidence;
    const actor = deps.tokens.authenticateAuthorization(httpInput.authorization);
    const hubId = actor?.scopes.includes('execution:delegate') && deps.tokens.delegationHubId(actor.tokenId);
    if (!actor || !hubId) return failure('Trusted delegation issuer required');
    if (httpInput.expectedNode !== deps.nodeId) return failure('Verified Connector identity required');
    const identity: GrantIssuer = { nodeId: deps.nodeId, issuerTokenId: actor.tokenId, hubId };
    if (kind === 'authorizedGrantIssuer') return { status: 200, value: identity };
    if (kind === 'authorizedGrantCreation') return { status: 200, value: { ...identity,
      creationAllowed: deps.tokens.hasScope(actor.tokenId, 'sessions:create') } };
    const body = (input as Evidence & { body: unknown }).body;
    if (kind === 'authorizedGrantUsage') {
      if (!record(body, [], ['ids'])) return failure('Invalid execution usage fields');
      if (!deps.turns) return failure('Execution usage unavailable');
      try {
        const usage = deps.grants.usage(body.ids as string[], actor.tokenId, hubId,
          (target, grant) => deps.turns!.usesExecutionGrant(target, grant)
            || (deps.grants.authorize(grant, actor.tokenId, target, 'messages:mirror')
              && !!deps.mirrorOutbox?.usesExecutionGrant(target, grant)));
        return { status: 200, value: { ...identity, usage } };
      } catch (error) {
        if (error instanceof ExecutionGrantInvalid) return failure('Invalid execution usage batch');
        if (error instanceof ExecutionIssuerDenied) return failure('Execution usage is not authorized');
        return failure('Execution usage unavailable');
      }
    }
    const revoke = kind === 'authorizedGrantRevoke';
    const fields = ['principalId', 'grantKey', 'version', 'runtime', 'sessionKey', ...(revoke ? [] : ['actions', 'expiresAt', 'leaseMs'])];
    if (!record(body, [], fields)) return failure('Invalid execution grant fields');
    const binding = { issuerTokenId: actor.tokenId, hubId, principalId: body.principalId, grantKey: body.grantKey,
      version: body.version, runtime: body.runtime, sessionKey: body.sessionKey } as ExecutionGrantBinding;
    try {
      if (revoke) {
        deps.grants.revokeVersion(binding);
        return { status: 200, value: { ...identity, revokedThroughVersion: binding.version } };
      }
      const relative = Object.hasOwn(body, 'leaseMs');
      if (relative && (Object.hasOwn(body, 'expiresAt') || !integer(body.leaseMs) || body.leaseMs > 60_000))
        return failure('Invalid relative execution lease');
      const expiresAt = relative ? (deps.now ?? Date.now)() + (body.leaseMs as number) : body.expiresAt as number;
      const grant = deps.grants.issue(binding, body.actions as ExecutionAction[], expiresAt);
      return { status: 200, value: { ...identity, grant, ...(relative ? { leaseMs: body.leaseMs } : {}) } };
    } catch (error) {
      if (error instanceof ExecutionGrantInvalid) return failure(Object.hasOwn(errors, error.message)
        ? error.message as keyof typeof errors : 'Invalid execution grant fields');
      if (error instanceof ExecutionIssuerDenied) return failure('Delegation issuer authorization changed');
      if (error instanceof ExecutionGrantConflict) return failure('Execution grant version or policy conflicts');
      if (error instanceof ExecutionGrantCapacity) return failure('Execution grant capacity reached');
      return failure('Execution grant storage unavailable');
    }
  };
  return run() as ConnectorGrantCommands[K]['output'];
}
