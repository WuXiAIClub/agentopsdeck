import { ensureChineseLoaded } from './i18n.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { compactResponseNotice, formatMaintenanceResult, readConnectorAdmissionStatus } from './maintenance-controls.js';

test('admission status never treats paused admission or interrupted resume as native idle', () => {
  const initial = readConnectorAdmissionStatus({ state: 'released', boundary: 'admission_only', nativeQuiescent: false });
  assert.ok(initial);
  assert.match(formatMaintenanceResult(initial), /admission only.*native idle not verified/);
  const interrupted = readConnectorAdmissionStatus({ state: 'paused', boundary: 'admission_only', nativeQuiescent: false,
    fenceId: 'a'.repeat(36), resumeInterrupted: true });
  assert.ok(interrupted);
  assert.match(formatMaintenanceResult(interrupted), /resume interrupted; still paused/);
  for (const invalid of [null, [], { ...initial, nativeQuiescent: true }, { ...initial, state: 'paused' },
    { ...initial, state: 'resuming' }, { ...initial, resumeInterrupted: true }, { ...initial, fenceId: '' }]) {
    assert.equal(readConnectorAdmissionStatus(invalid), undefined);
  }
});
import { buildConnectorUpdateApplyPayload, canApplyConnectorUpdate, canRollbackConnectorUpdate, formatConnectorUpdateStatus, formatModelSetStatus, type ModelSetStatusLike, type UpdateStatusLike } from './maintenance-controls.js';

function updateStatus(overrides: Partial<UpdateStatusLike> = {}): UpdateStatusLike {
  return {
    state: 'idle',
    rollbackAvailable: false,
    ...overrides,
  };
}

test('compact unknown never falls back to an acceptance notice', () => {
  for (const message of [undefined, 'Compact requested.']) {
    const notice = compactResponseNotice({ status: 'outcome_unknown', ...(message ? { message } : {}) }, 'Compact requested.');
    assert.match(notice, /outcome unknown/);
    assert.match(notice, /not automatically resent/);
    assert.doesNotMatch(notice, /Compact requested/);
  }
});

test('compact acknowledged notice preserves server explanation or fallback', () => {
  assert.equal(compactResponseNotice({ status: 'started', message: 'Below threshold' }, 'Requested'), 'Below threshold');
  assert.equal(compactResponseNotice({ status: 'started' }, 'Requested'), 'Requested');
});

test('connector update apply payload uses checked target and manifest hash', () => {
  const payload = buildConnectorUpdateApplyPayload(updateStatus({
    state: 'available',
    targetVersion: '1.2.3',
    targetRevision: 'rev-123',
    manifestSha256: 'sha256:abc',
  }));

  assert.deepEqual(payload, {
    version: '1.2.3',
    revision: 'rev-123',
    manifestSha256: 'sha256:abc',
  });
});

test('connector update apply requires an approved checked target version and manifest hash', () => {
  assert.equal(buildConnectorUpdateApplyPayload(updateStatus({ state: 'idle', manifestSha256: 'sha256:abc' })), undefined);
  assert.equal(buildConnectorUpdateApplyPayload(updateStatus({ state: 'available', targetVersion: '1.2.3' })), undefined);
  assert.equal(buildConnectorUpdateApplyPayload(updateStatus({ state: 'available', targetVersion: '1.2.3', manifestSha256: '   ' })), undefined);
  assert.equal(canApplyConnectorUpdate(false, updateStatus({ targetVersion: '1.2.3', manifestSha256: 'sha256:abc' })), true);
  assert.equal(canApplyConnectorUpdate(false, updateStatus({ targetVersion: '1.2.3' })), false);
  assert.equal(canApplyConnectorUpdate(true, updateStatus({ targetVersion: '1.2.3', manifestSha256: 'sha256:abc' })), false);
  assert.equal(canApplyConnectorUpdate(false, updateStatus()), false);
});

test('connector update rollback eligibility follows status and busy state', () => {
  assert.equal(canRollbackConnectorUpdate(false, updateStatus({ rollbackAvailable: true })), true);
  assert.equal(canRollbackConnectorUpdate(true, updateStatus({ rollbackAvailable: true })), false);
  assert.equal(canRollbackConnectorUpdate(false, updateStatus({ rollbackAvailable: false })), false);
});

test('maintenance status text includes update state, restart flag, and error', () => {
  assert.equal(formatConnectorUpdateStatus(undefined), 'not loaded');
  assert.equal(formatConnectorUpdateStatus(updateStatus({ state: 'failed', restartRequired: true, lastError: 'bad hash' })), 'failed · restart required · bad hash');
});

test('model set status text includes convergence and restart behavior', () => {
  const model: ModelSetStatusLike = { converged: false, missing: ['github-copilot/gpt-5.6-sol'], restartRequired: true };

  assert.equal(formatModelSetStatus(undefined), 'not loaded');
  assert.equal(formatModelSetStatus(model), 'Missing 1 · restart required');
  assert.equal(formatModelSetStatus({ converged: true, missing: [], restartRequired: false }), 'Converged');
});

test('maintenance labels switch language without translating protocol or error data', async () => {
  await ensureChineseLoaded();
  const status = { state: 'failed', rollbackAvailable: false, restartRequired: true, lastError: 'failed' };
  assert.equal(formatConnectorUpdateStatus(status, 'zh-CN'), '失败 · 需要重启 · failed');
  assert.equal(status.state, 'failed');
  assert.equal(formatModelSetStatus({ converged: false, missing: ['custom/id'] }, 'zh-CN'), '缺少 1 项');
  assert.equal(formatModelSetStatus(undefined, 'zh-CN'), '尚未读取');
  assert.equal(formatMaintenanceResult({ state: 'paused', boundary: 'admission_only', nativeQuiescent: false, resumeInterrupted: true }, 'zh-CN'),
    '已暂停 · 仅接单边界 · 尚未验证原生任务空闲 · 恢复中断，仍保持暂停');
  assert.equal(formatConnectorUpdateStatus({ state: 'new_future_state', rollbackAvailable: false }, 'zh-CN'), 'new_future_state');
});
