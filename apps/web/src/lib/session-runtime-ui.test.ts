import assert from 'node:assert/strict';
import test from 'node:test';
import { newSessionSource, sessionRuntimeUi, sdkAttachmentsSupported } from './session-runtime-ui.js';
import type { SendMessageUpload } from '@agentopsdeck/shared';

test('creation fallback preserves runtime capabilities before directory refresh', () => {
  for (const agentId of ['claude-code', 'ghcp', 'antigravity', 'codex', 'hermes'] as const) assert.equal(newSessionSource(agentId), agentId);
  assert.equal(newSessionSource('my-openclaw-agent'), 'web');
  for (const agentId of ['claude-code', 'ghcp', 'antigravity']) {
    const ui = sessionRuntimeUi({ source: newSessionSource(agentId) });
    assert.equal(ui.attachments, false);
    assert.equal(ui.deleteSession, true);
    assert.equal(ui.modelCatalog, agentId);
  }
});

test('SDK sessions cannot offer unsupported mutations or fall back to the OpenClaw catalog', () => {
  for (const source of ['claude-code', 'ghcp', 'antigravity'] as const) {
    assert.deepEqual(sessionRuntimeUi({ source }), { sdk: true, configuredModel: false,
      attachments: false, compact: false, deleteSession: true, modelCatalog: source });
  }
});
test('existing Codex/OpenClaw and Hermes affordances remain unchanged', () => {
  for (const source of ['codex', 'openclaw'] as const) {
    const ui = sessionRuntimeUi({ source });
    assert.equal(ui.modelCatalog, source);
    assert.ok(ui.attachments && ui.compact && ui.deleteSession);
  }
  const hermes = sessionRuntimeUi({ source: 'hermes' });
  assert.ok(hermes.deleteSession && hermes.configuredModel);
  assert.equal(hermes.attachments, false);
});

test('SDK attachment controls require explicit current Connector capability', () => {
  for (const source of ['claude-code', 'ghcp', 'antigravity'] as const) {
    assert.equal(sessionRuntimeUi({ source }).attachments, false);
    assert.equal(sessionRuntimeUi({ source, controlCapabilities: { compact: false, attachments: true } }).attachments, true);
    assert.equal(sessionRuntimeUi({ source, controlCapabilities: { compact: false, attachments: false } }).attachments, false);
  }
});

test('SDK attachment selection enforces supported formats, count and byte budgets', () => {
  const upload = (bytes: number, mime = 'text/plain'): SendMessageUpload => ({
    type: 'file', name: 'fixture.txt', mimeType: mime,
    dataUrl: `data:${mime};base64,${Buffer.alloc(bytes, 65).toString('base64')}`,
  });
  const max = upload(5 * 1024 * 1024, 'image/png');
  for (const source of ['claude-code', 'ghcp'] as const) {
    assert.ok(sdkAttachmentsSupported({ source }, [upload(1)]));
    assert.ok(sdkAttachmentsSupported({ source }, [upload(100_000)]));
    assert.equal(sdkAttachmentsSupported({ source }, [upload(100_001)]), false);
    assert.equal(sdkAttachmentsSupported({ source }, [upload(60_000), upload(60_000)]), false);
    assert.ok(sdkAttachmentsSupported({ source }, Array(4).fill(max)));
    assert.equal(sdkAttachmentsSupported({ source }, [...Array(4).fill(max), upload(1)]), false);
    assert.equal(sdkAttachmentsSupported({ source }, [upload(5 * 1024 * 1024 + 1)]), false);
    assert.equal(sdkAttachmentsSupported({ source }, Array(9).fill(upload(1))), false);
    assert.equal(sdkAttachmentsSupported({ source }, [upload(0)]), false);
    assert.equal(sdkAttachmentsSupported({ source }, [upload(1, 'application/pdf')]), false);
    assert.equal(sdkAttachmentsSupported({ source }, [{ ...upload(1), dataUrl: 'https://example.invalid/file' }]), false);
  }
  assert.ok(sdkAttachmentsSupported({ source: 'codex' }, [upload(1, 'application/pdf')]));
});
