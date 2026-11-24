import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { nanoid } from 'nanoid';
import { ChangeSignal } from '../utils/change-signal.js';
import { AuthPersistenceError, PrivateAuthStoreGuard } from './private-store.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';

export const CONNECTOR_SCOPES = [
  'sessions:read',
  'sessions:create',
  'messages:read',
  'messages:send',
  'messages:mirror',
  'queue:manage',
  'automation:manage', // Explicit bounded rule management; never default/bootstrap.
  'execution:delegate',
  'events:read',
  'media:read',
  'agents:read',
  'files:read',
  'issues:read', // Explicit read-only provider access; never session-derived/default.
  'system:metrics:read', // Explicit machine telemetry; never default or session-derived.
  'files:write', // Explicit text editing within configured roots; never default/bootstrap.
  'websites:read', // Opt-in read-only website snapshots; never default/bootstrap.
  'websites:browse', // Separate opt-in resource access; not implied by snapshot reads.
  'websites:act', // Explicit configured write operations; neither read nor browse implies this.
  'websites:connect', // Bidirectional configured WebSocket paths; separate explicit opt-in.
  'terminals:use', // Explicit OS execution, never default/bootstrap or implied by Agent rights.
  'boards:bind', // Opt-in private per-session task tools; never default/bootstrap.
  'boards:files', // Separate opt-in whole-board files; not implied by task tools or file reads.
  // Explicit operator delegation within SOURCE_APPROVAL_ROOTS; not bootstrap.
  'source:approve',
  // Explicit Connector-admin exact-file preview approval; never bootstrap/default.
  'source:approve:admin',
  'users:read',
  'users:write',
  'models:read',
  'models:write',
  'connector:update',
  // Opt-in node lifecycle authority; never included in bootstrap/default tokens.
  'connector:lifecycle',
] as const;

export type ConnectorScope = typeof CONNECTOR_SCOPES[number];

export type ConnectorPrincipal = {
  tokenId: string;
  label: string;
  scopes: ConnectorScope[];
};

type TokenRecord = {
  id: string;
  label: string;
  hash: string;
  scopes: ConnectorScope[];
  createdAt: number;
  revokedAt?: number;
  delegationHubId?: string;
};

type TokenFile = {
  version: 1;
  records: TokenRecord[];
};

export const DEFAULT_SCOPES: ConnectorScope[] = [
  'sessions:read',
  'sessions:create',
  'messages:read',
  'messages:send',
  'events:read',
  'media:read',
  'agents:read',
  'users:read',
  'users:write',
];

export class ConnectorTokenStore {
  readonly changes = new ChangeSignal();
  private records: TokenRecord[] = [];
  private transientRecords: TokenRecord[] = [];
  // Historical revocations remain part of durable identity. Reusing an ID
  // must never lend a new credential's authority to previously queued work.
  private readonly ambiguousIds = new Set<string>();
  private readonly guard: PrivateAuthStoreGuard;
  private retired = false;

  constructor(private readonly file: string, bootstrapToken?: string,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {
    try {
      // Capture identity BEFORE reading, then verify the original load.
      this.guard = new PrivateAuthStoreGuard(file);
      this.load();
      this.guard.check();
    } catch {
      this.observeFailure(1);
      throw new AuthPersistenceError();
    }
    if (bootstrapToken) this.ensureBootstrapToken(bootstrapToken);
  }

  authenticate(request: Request): ConnectorPrincipal | undefined {
    return this.authenticateAuthorization(request.headers.get('authorization'));
  }

  // Worker-local authentication at the actual command execution point. A
  // principal/preflight boolean from another owner is never authority.
  authenticateAuthorization(authorization: string | null): ConnectorPrincipal | undefined {
    if (!this.current()) return undefined;
    const supplied = bearerToken(authorization);
    if (!supplied) return undefined;
    const suppliedHash = hashToken(supplied);
    const matches = (record: TokenRecord) => !this.ambiguousIds.has(record.id)
      && record.revokedAt === undefined && safeEqual(record.hash, suppliedHash);
    const match = this.records.find(matches) ?? this.transientRecords.find(matches);
    return match ? { tokenId: match.id, label: match.label, scopes: [...match.scopes] } : undefined;
  }

  requireScope(request: Request, scope: ConnectorScope): ConnectorPrincipal | undefined {
    const principal = this.authenticate(request);
    return principal?.scopes.includes(scope) ? principal : undefined;
  }

  // Durable work retains an identity, never a bearer secret or frozen scopes.
  hasScope(tokenId: string | undefined, scope: ConnectorScope) {
    if (!this.current() || !tokenId || this.ambiguousIds.has(tokenId)) return false;
    const matches = (record: TokenRecord) => record.id === tokenId && record.revokedAt === undefined && record.scopes.includes(scope);
    return this.records.some(matches) || this.transientRecords.some(matches);
  }

  // Explicit operator binding, immutable for the lifetime of this credential.
  // A browser-supplied Hub identity is never used as issuer provenance.
  delegationHubId(tokenId: string) {
    if (!this.current() || this.ambiguousIds.has(tokenId)) return undefined;
    const matches = (item: TokenRecord) => item.id === tokenId && item.revokedAt === undefined;
    const record = this.records.find(matches) ?? this.transientRecords.find(matches);
    return record?.scopes.includes('execution:delegate') && record.scopes.includes('messages:send')
      && validHubId(record.delegationHubId) ? record.delegationHubId : undefined;
  }

  // Historical provenance check for retiring local execution grants after the
  // issuer credential itself was rotated or revoked. Never authorizes issuing.
  canRetireDelegationIssuer(tokenId: string, hubId: string): boolean {
    if (!this.current() || !tokenId || !validHubId(hubId) || this.ambiguousIds.has(tokenId)) return false;
    const matches = (item: TokenRecord) => item.id === tokenId && item.delegationHubId === hubId
      && item.scopes.includes('execution:delegate') && item.scopes.includes('messages:send');
    return this.records.some(matches) || this.transientRecords.some(matches);
  }

  list() {
    this.assertCurrent();
    return this.records.map(record => this.redact(record));
  }

  // Same authentication/scopes for in-process requests, but never persist or expose
  // this process-lifetime capability via token management endpoints.
  createTransient(scopes: ConnectorScope[] = [...DEFAULT_SCOPES], identity = `local_${nanoid(10)}`) {
    this.assertCurrent();
    if ([...this.records, ...this.transientRecords].some((record) => record.id === identity)) throw new Error('Connector identity already exists');
    const token = `aod_local_${randomBytes(32).toString('base64url')}`;
    const record: TokenRecord = {
      id: identity, label: 'In-process Hub', hash: hashToken(token),
      scopes: normalizeScopes(scopes), createdAt: Date.now(),
    };
    this.transientRecords.push(record);
    return { token, dispose: () => {
      if (!this.transientRecords.includes(record)) return;
      this.transientRecords = this.transientRecords.filter((item) => item !== record);
      this.changes.notify();
    } };
  }

  create(params: { label: string; scopes?: ConnectorScope[]; delegationHubId?: string }) {
    this.assertCurrent();
    const scopes = normalizeScopes(params.scopes);
    if (params.delegationHubId !== undefined && (!validHubId(params.delegationHubId)
      || !scopes.includes('execution:delegate') || !scopes.includes('messages:send'))) throw new Error('Invalid delegation Hub binding');
    const token = `aod_conn_${randomBytes(24).toString('base64url')}`;
    const record: TokenRecord = {
      id: `tok_${nanoid(10)}`,
      label: params.label.trim() || 'Connector token',
      hash: hashToken(token),
      scopes,
      ...(params.delegationHubId !== undefined ? { delegationHubId: params.delegationHubId } : {}),
      createdAt: Date.now(),
    };
    this.assertUnusedIdentity(record.id);
    const candidate = [...this.records, record];
    this.save(candidate);
    // No new authority or raw credential is published before the original save.
    this.records = candidate;
    return { token, record: this.redact(record) };
  }

  revoke(id: string) {
    this.assertCurrent();
    const records = this.records.filter((item) => item.id === id && item.revokedAt === undefined);
    if (records.length === 0) return false;
    // Older bootstrap rotations reused their durable ID. Revoking that ID
    // must deny ALL of its credentials, not leave a hidden survivor active.
    // Preserve every historical record and publish one atomic revocation.
    const revokedAt = Date.now();
    for (const record of records) record.revokedAt = revokedAt;
    // Even a persistence failure must wake streams: in-memory authority is gone.
    try { this.save(this.records); }
    catch {
      // Revocation has denied this instance, not proven durable success.
      // Retire instead of letting another write incidentally replay it.
      this.retire(4);
      throw new AuthPersistenceError();
    } finally { if (!this.retired) this.changes.notify(); }
    return true;
  }

  private ensureBootstrapToken(token: string) {
    this.assertCurrent();
    const hash = hashToken(token);
    const existing = this.records.find((record) => safeEqual(record.hash, hash));
    if (existing) {
      // Do not silently migrate or expand authority for ambiguous history.
      // The independent operator can inspect/revoke it and issue a fresh ID.
      if (this.ambiguousIds.has(existing.id)) return;
      const mergedScopes = [...new Set([...existing.scopes, ...DEFAULT_SCOPES])];
      if (mergedScopes.length !== existing.scopes.length) {
        const candidate = this.records.map(record => record === existing ? { ...record, scopes: mergedScopes } : record);
        this.save(candidate);
        this.records = candidate;
      }
      return;
    }
    const id = this.records.some(record => record.id === 'tok_bootstrap') ? `tok_bootstrap_${nanoid(10)}` : 'tok_bootstrap';
    this.assertUnusedIdentity(id);
    const candidate = [...this.records, {
      // Retain historical duplicate bootstrap IDs on load, but do not create
      // more: an old durable identity must not acquire a rotated token's scope.
      id,
      label: 'Bootstrap local Hub token',
      hash,
      scopes: [...DEFAULT_SCOPES],
      createdAt: Date.now(),
    }];
    this.save(candidate);
    this.records = candidate;
  }

  private redact(record: TokenRecord) {
    const { hash: _hash, ...safe } = record;
    return { ...safe, scopes: [...safe.scopes], ...(this.ambiguousIds.has(record.id) ? { identityAmbiguous: true as const } : {}) };
  }

  private assertUnusedIdentity(id: string) {
    if (this.records.some(record => record.id === id) || this.transientRecords.some(record => record.id === id))
      throw new Error('Connector identity already exists');
  }

  private load() {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new AuthPersistenceError();
    }
    const parsed = JSON.parse(text) as Partial<TokenFile> | null;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.records) || !parsed.records.every(isTokenRecord))
      throw new AuthPersistenceError();
    // Never turn damaged/unsupported records into an empty bootstrap store.
    this.records = parsed.records;
    const seen = new Set<string>();
    for (const record of this.records) {
      if (seen.has(record.id)) this.ambiguousIds.add(record.id);
      seen.add(record.id);
    }
    if (this.ambiguousIds.size) {
      const trace = guardedTrace(this.diagnostics, 'connector-token-owner');
      trace.add('step', 5); trace.add('deferred', 1); trace.add('pending', this.ambiguousIds.size); trace.finish(true);
    }
  }

  private save(records: TokenRecord[]) {
    const trace = guardedTrace(this.diagnostics, 'connector-token-owner');
    trace.add('step', 3);
    let failed = true;
    try {
      this.guard.write({ version: 1, records });
      trace.add('settled', 1); failed = false;
    } catch { trace.add('unknown', 1); throw new AuthPersistenceError(); }
    finally { trace.finish(failed); }
  }

  private current() {
    if (!this.retired && !this.guard.current()) this.retire(2);
    return !this.retired;
  }
  private assertCurrent() { if (!this.current()) throw new AuthPersistenceError(); }
  private retire(step: 2 | 4) {
    if (this.retired) return;
    this.retired = true;
    this.observeFailure(step);
    // A wake hint, not a successful revocation or a new owner.
    this.changes.notify();
  }
  private observeFailure(step: 1 | 2 | 4) {
    const trace = guardedTrace(this.diagnostics, 'connector-token-owner');
    trace.add('step', step); trace.add('unknown', 1); trace.finish(true);
  }
}

function bearerToken(authorization: string | null) {
  const header = authorization?.trim();
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function normalizeScopes(scopes: ConnectorScope[] | undefined) {
  const allowed = new Set<ConnectorScope>(CONNECTOR_SCOPES);
  const normalized = (scopes && scopes.length > 0 ? scopes : DEFAULT_SCOPES).filter((scope): scope is ConnectorScope => allowed.has(scope));
  return [...new Set(normalized)];
}

function hashToken(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isTokenRecord(value: unknown): value is TokenRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string'
    && record.id.length > 0
    && typeof record.label === 'string'
    && typeof record.hash === 'string'
    && /^[a-f0-9]{64}$/.test(record.hash)
    && Array.isArray(record.scopes)
    && record.scopes.every(scope => CONNECTOR_SCOPES.includes(scope))
    && Number.isSafeInteger(record.createdAt) && Number(record.createdAt) >= 0
    && (record.revokedAt === undefined || Number.isSafeInteger(record.revokedAt) && Number(record.revokedAt) >= 0)
    && (record.delegationHubId === undefined || validHubId(record.delegationHubId)
      && record.scopes.includes('messages:send') && record.scopes.includes('execution:delegate'));
}

function validHubId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
}
