import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { observedTransaction } from '../storage/observed-transaction.js';
import { readAutomationRule, type AutomationRule } from './automation-policy.js';
import { AutomationStore, AutomationStoreConflict } from './automation-store.js';
import { validAutomationConfigurationReceipt, type AutomationConfiguration, type AutomationConfigurationReceipt } from '@agentopsdeck/shared';

export type { AutomationConfiguration, AutomationConfigurationReceipt } from '@agentopsdeck/shared';
const LIMIT = 8 * 1024 * 1024;
const validText = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 256
  && s.trim() === s && !/[\u0000-\u001f\u007f]/.test(s);
const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)])) : v;
const fingerprint = (v: unknown) => createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');

/** Configuration and original immutable receipt commit in the SAME owner DB.
 * Receipt lookup never edits a rule or starts a scheduler. Caller supplies
 * current owner/target authority; confirmation is explicit for every enabled
 * save, not inferred from defaults, a receipt, or a card's text. */
export class AutomationConfigurationStore {
  private readonly store: AutomationStore;
  constructor(private readonly db: DatabaseSync,
    private readonly authorized: (owner: string, target: AutomationRule['target']) => boolean,
    clock: () => number = Date.now) { this.store = new AutomationStore(db, clock); }
  private schema() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS automation_configuration_receipts (
      owner TEXT NOT NULL, request TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(owner,request));
      CREATE TRIGGER IF NOT EXISTS automation_configuration_no_update BEFORE UPDATE ON automation_configuration_receipts
      BEGIN SELECT RAISE(ABORT,'immutable automation configuration receipt'); END;
      CREATE TRIGGER IF NOT EXISTS automation_configuration_no_delete BEFORE DELETE ON automation_configuration_receipts
      BEGIN SELECT RAISE(ABORT,'immutable automation configuration receipt'); END;
      CREATE TRIGGER IF NOT EXISTS automation_configuration_no_replace BEFORE INSERT ON automation_configuration_receipts
      WHEN EXISTS(SELECT 1 FROM automation_configuration_receipts WHERE owner=new.owner AND request=new.request)
      BEGIN SELECT RAISE(ABORT,'immutable automation configuration receipt'); END;`);
  }
  private read(owner: string, requestId: string): AutomationConfigurationReceipt | undefined {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='automation_configuration_receipts'").get()) return;
    const row = this.db.prepare('SELECT payload FROM automation_configuration_receipts WHERE owner=? AND request=?').get(owner, requestId);
    if (!row) return;
    const value = JSON.parse(String(row.payload)) as AutomationConfigurationReceipt;
    if (!validAutomationConfigurationReceipt(value) || value.requestId !== requestId
      || value.result.rule.target.ownerId !== owner
      || createHash('sha256').update(value.result.template).digest('hex') !== value.result.templateHash) throw new AutomationStoreConflict('receipt-proof');
    return value;
  }
  original(owner: string, requestId: string) {
    if (!validText(owner) || !validText(requestId)) throw new AutomationStoreConflict('scope');
    const value = this.read(owner, requestId);
    if (value && !this.authorized(owner, value.result.rule.target)) throw new AutomationStoreConflict('forbidden');
    return value;
  }
  configure(owner: string, requestId: string, input: AutomationConfiguration): AutomationConfigurationReceipt {
    if (!validText(owner) || !validText(requestId) || !input || !['save', 'revoke'].includes(input.kind)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new AutomationStoreConflict('configuration');
    const keys = input.kind === 'save' ? ['kind', 'rule', 'template', 'expectedRevision', 'confirmEnable']
      : ['kind', 'ruleId', 'expectedRevision'];
    if (Object.keys(input).some(k => !keys.includes(k))) throw new AutomationStoreConflict('configuration');
    let action: AutomationConfiguration;
    if (input.kind === 'save') {
      const rule = readAutomationRule(input.rule);
      if (!rule || rule.target.ownerId !== owner || typeof input.confirmEnable !== 'boolean'
        || rule.enabled && !input.confirmEnable || typeof input.template !== 'string' || !input.template.trim()
        || input.template.length > 8192 || Buffer.byteLength(input.template) > 32768 || input.template.includes('\0')) {
        throw new AutomationStoreConflict('configuration-or-confirmation');
      }
      action = { ...input, rule };
    } else {
      if (!validText(input.ruleId)) throw new AutomationStoreConflict('configuration');
      action = input;
    }
    if (this.db.isTransaction) throw new AutomationStoreConflict('configuration-requires-top-level-commit');
    return observedTransaction(this.db, 'automation-configuration-change', () => {
      this.schema();
      const hash = fingerprint(action), prior = this.read(owner, requestId);
      const target = action.kind === 'save' ? action.rule.target : this.store.read(owner, action.ruleId)?.rule.target;
      if (!target || !this.authorized(owner, target)) throw new AutomationStoreConflict('forbidden');
      if (prior) {
        if (prior.fingerprint !== hash) throw new AutomationStoreConflict('request-reused');
        return prior;
      }
      const result = action.kind === 'save' ? this.store.save(owner, action.rule, action.template, action.expectedRevision)
        : this.store.revoke(owner, action.ruleId, action.expectedRevision);
      const receipt = { requestId, fingerprint: hash, result }, payload = JSON.stringify(receipt);
      const usage = this.db.prepare('SELECT count(*) n,coalesce(sum(length(CAST(payload AS BLOB))),0) bytes FROM automation_configuration_receipts').get()!;
      if (Number(usage.n) >= 10000 || Number(usage.bytes) + Buffer.byteLength(payload) > LIMIT) throw new AutomationStoreConflict('configuration-capacity');
      this.db.prepare('INSERT INTO automation_configuration_receipts VALUES(?,?,?)').run(owner, requestId, payload);
      return receipt;
    });
  }
}
