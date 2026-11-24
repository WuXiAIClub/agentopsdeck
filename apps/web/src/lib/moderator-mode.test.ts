import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAudioRms,
  downsampleFloat32,
  encodeWavPcm16Mono,
  float32ToPcm16Le,
  normalizeMixedZhEnTranscript,
  SttChunkAccumulator,
  upsertLiveSttSegment,
} from './moderator-stt.js';
import {
  appendModeratorNotes,
  buildModeratorBatchPrompt,
  DEFAULT_MODERATOR_ORCHESTRATION_CONFIG,
  mergeModeratorTasks,
  parseModeratorDirectives,
  shouldInjectModeratorGuidance,
} from './moderator-orchestrator.js';
import { autoBindTemplateResources, buildWorkspaceFromTemplate, prepareTemplateOptions } from './layout-templates.js';
import { fileLinkEdges } from './workspace-file-links.js';
import { restoreWorkspace, validPane } from './workspace-layout.js';

test('audio DSP helpers downsample, compute RMS, and encode WAV/PCM16 with zero external dependencies', () => {
  const input = new Float32Array([0, 0.5, -0.5, 1.0, -1.0, 0.25]);
  const rms = computeAudioRms(input);
  assert.ok(rms > 0.4 && rms < 0.7);

  const downsampled = downsampleFloat32(input, 48_000, 16_000);
  assert.equal(downsampled.length, 2);

  const pcm = float32ToPcm16Le(new Float32Array([0, 1, -1]));
  assert.equal(pcm.byteLength, 6);

  const wav = encodeWavPcm16Mono(new Float32Array([0, 0.5, -0.5, 0]), 16_000);
  const bytes = new Uint8Array(wav);
  assert.equal(String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!), 'RIFF');
  assert.equal(wav.byteLength, 44 + 8);
});

test('SttChunkAccumulator batches speech and flushes on pause, window, or manual trigger', () => {
  const acc = new SttChunkAccumulator({ pauseMs: 3000, fixedWindowMs: 10000 });

  assert.equal(acc.pushSegment('First sentence about architecture.', true, 1000), null);
  assert.equal(acc.pushSegment('Second sentence about timeline.', true, 2500), null);

  // Advance past pauseMs (2500 + 3100 = 5600)
  const pauseBatch = acc.tick(5600);
  assert.ok(pauseBatch);
  assert.equal(pauseBatch.reason, 'pause');
  assert.equal(pauseBatch.text, 'First sentence about architecture. Second sentence about timeline.');

  // Fixed window flush even when user keeps speaking without a long pause
  assert.equal(acc.pushSegment('Continuous speech A', true, 10000), null);
  assert.equal(acc.pushSegment('Continuous speech B', true, 12000), null);
  const windowBatch = acc.tick(20050);
  assert.ok(windowBatch);
  assert.equal(windowBatch.reason, 'window');
  assert.equal(windowBatch.text, 'Continuous speech A Continuous speech B');

  // Manual flush
  assert.equal(acc.pushSegment('Manual segment', false, 21000), null);
  const manualBatch = acc.flush('manual', 21500);
  assert.ok(manualBatch);
  assert.equal(manualBatch.text, 'Manual segment');
  assert.equal(manualBatch.reason, 'manual');
});

test('Moderator orchestrator builds prompts, parses directives, appends notes, and idempotently merges tasks', () => {
  const batchPrompt = buildModeratorBatchPrompt(
    {
      text: 'We need to benchmark Redis latency and update the Q4 roadmap.',
      reason: 'pause',
      startedAtMs: 1000,
      flushedAtMs: 4000,
    },
    {
      ...DEFAULT_MODERATOR_ORCHESTRATION_CONFIG,
      scoutSessionKey: 'codex:scout-1',
    },
  );
  assert.match(batchPrompt, /\[Live STT Transcript · pause · /);
  assert.match(batchPrompt, /We need to benchmark Redis latency/);

  const assistantReply = `
Here is the structured summary:
[MODERATOR_NOTE]
### Architecture Sync
- Agreed to benchmark Redis latency before Friday.
[/MODERATOR_NOTE]
[MODERATOR_TASK status="doing" title="Benchmark Redis p99 latency"]Run benchmark suite on staging cluster[/MODERATOR_TASK]
[MODERATOR_TASK status="todo" title="Update Q4 roadmap"]Add Moderator Mode milestone[/MODERATOR_TASK]
[MODERATOR_SCOUT]Search the repo for current Redis connection pool settings and report back.[/MODERATOR_SCOUT]
`;

  const parsed = parseModeratorDirectives(assistantReply);
  assert.equal(parsed.notes.length, 1);
  assert.match(parsed.notes[0]!, /Architecture Sync/);
  assert.equal(parsed.tasks.length, 2);
  assert.deepEqual(parsed.tasks[0], {
    title: 'Benchmark Redis p99 latency',
    status: 'doing',
    detail: 'Run benchmark suite on staging cluster',
  });
  assert.equal(parsed.scoutQueries.length, 1);
  assert.match(parsed.scoutQueries[0]!, /Redis connection pool settings/);

  const updatedNote = appendModeratorNotes('# Existing Notes', parsed.notes);
  assert.equal(updatedNote.changed, true);
  assert.match(updatedNote.text, /# Existing Notes/);
  assert.match(updatedNote.text, /### Architecture Sync/);

  const initialTasks = [
    { id: 'task-1', title: 'Benchmark Redis p99 latency', status: 'todo' as const, detail: 'Old detail' },
  ];
  const merged = mergeModeratorTasks(initialTasks, parsed.tasks);
  assert.equal(merged.changed, true);
  assert.equal(merged.tasks.length, 2);
  assert.equal(merged.tasks[0]?.status, 'doing');
  assert.equal(merged.tasks[0]?.detail, 'Run benchmark suite on staging cluster');
  assert.equal(merged.tasks[1]?.title, 'Update Q4 roadmap');
});

test('Layout template builder constructs valid Moderator Mode workspace with auto-linked cards and visual binding edges', async () => {
  let seq = 0;
  const ws = buildWorkspaceFromTemplate('moderator-mode', {
    primarySessionKey: 'codex:moderator',
    secondarySessionKey: 'codex:scout',
    notebookTarget: 'hub',
    notebookResourceId: 'default',
    taskboardResourceId: 'default',
    idFactory: prefix => `pane:${prefix}-${++seq}`,
  });

  assert.equal(ws.panes.length, 5);
  for (const pane of ws.panes) {
    assert.equal(validPane(pane), true, `Expected pane ${pane.id} to be valid`);
  }

  const edges = fileLinkEdges(ws.panes);
  assert.equal(edges.length, 4, `Expected 4 clean hub-and-spoke binding edges without redundant cross-links, got ${edges.length}`);

  const restored = restoreWorkspace(ws, new Set(['codex:moderator', 'codex:scout']));
  assert.ok(restored);
  assert.equal(restored.panes.some(p => p.kind === 'moderator' && p.resourceId === 'control'), true);
  assert.equal(restored.panes.some(p => p.kind === 'notebook' && p.resourceId === 'default'), true);
  assert.equal(restored.panes.some(p => p.kind === 'taskboard' && p.resourceId === 'default'), true);

  const boundCalls: string[] = [];
  const bindResult = await autoBindTemplateResources(
    'scope-test',
    'moderator-mode',
    {
      primarySessionKey: 'codex:moderator',
      secondarySessionKey: 'codex:scout',
      notebookTarget: 'hub',
      notebookResourceId: 'default',
      taskboardResourceId: 'default',
    },
    {
      fileCardBinding: async () => ({ enabled: true, binding: null }),
      bindFileCard: async (id, intent) => { boundCalls.push(`card:${id}:${intent.sessionId}`); },
      fileBoardBinding: async () => ({ enabled: true, binding: null }),
      bindFileBoard: async (id, intent) => { boundCalls.push(`board:${id}:${intent.sessionId}`); },
    },
  );
  assert.equal(bindResult.moderatorConfigUpdated, true);
  assert.equal(bindResult.notebookBound, true);
  assert.equal(bindResult.taskboardBound, true);
  assert.equal(boundCalls.length, 2);
});


test('shouldInjectModeratorGuidance only injects on first batch or after context compression drops header', () => {
  const prompt = DEFAULT_MODERATOR_ORCHESTRATION_CONFIG.systemPrompt;
  assert.equal(shouldInjectModeratorGuidance([], prompt, false), true);
  assert.equal(shouldInjectModeratorGuidance([], prompt, true), false);
  assert.equal(
    shouldInjectModeratorGuidance([{ role: 'user', text: `[Moderator Guidance]\n${prompt}\n\n[Live STT...]` }], prompt, false),
    false,
  );
  assert.equal(
    shouldInjectModeratorGuidance([{ role: 'user', text: 'ordinary message after compaction' }], prompt, false),
    true,
  );
});

test('buildModeratorGuidancePrimer sends guidance once at layout creation while buildModeratorBatchPrompt sends incremental speech only', async () => {
  const { buildModeratorGuidancePrimer } = await import('./moderator-orchestrator.js');
  const primer = buildModeratorGuidancePrimer({
    ...DEFAULT_MODERATOR_ORCHESTRATION_CONFIG,
    notebookId: 'note-fresh-1',
    taskboardId: 'board-fresh-1',
    scoutSessionKey: 'codex:scout-1',
  });
  assert.match(primer, /\[Moderator Guidance\]/);
  assert.match(primer, /Notebook: note-fresh-1 \| Taskboard: board-fresh-1 \| Scout Session: codex:scout-1/);

  const incrementalBatch = buildModeratorBatchPrompt(
    {
      text: 'Only this new sentence is sent on pause.',
      reason: 'pause',
      startedAtMs: 1000,
      flushedAtMs: 4000,
    },
    {
      ...DEFAULT_MODERATOR_ORCHESTRATION_CONFIG,
      notebookId: 'note-fresh-1',
      taskboardId: 'board-fresh-1',
      scoutSessionKey: 'codex:scout-1',
    },
  );
  assert.equal(incrementalBatch.includes('[Moderator Guidance]'), false);
  assert.match(incrementalBatch, /\[Live STT Transcript · pause · /);
  assert.match(incrementalBatch, /Only this new sentence is sent on pause\./);
});

test('retargetModeratorWorkspace swaps cards in-place and updates all fileLinks edges', async () => {
  const { retargetModeratorWorkspace } = await import('./layout-templates.js');
  const initial = buildWorkspaceFromTemplate('moderator-mode', {
    primarySessionKey: 'codex:mod-old',
    secondarySessionKey: 'codex:scout-old',
    notebookTarget: 'hub',
    notebookResourceId: 'note-old',
    taskboardResourceId: 'board-old',
  });

  const retargeted = retargetModeratorWorkspace(
    initial,
    {
      moderatorSessionKey: 'codex:mod-old',
      scoutSessionKey: 'codex:scout-old',
      notebookTarget: 'hub',
      notebookId: 'note-old',
      taskboardId: 'board-old',
    },
    {
      moderatorSessionKey: 'codex:mod-new',
      scoutSessionKey: 'codex:scout-new',
      notebookTarget: 'hub',
      notebookId: 'note-new',
      taskboardId: 'board-new',
    },
  );

  assert.equal(retargeted.panes.some(p => 'sessionKey' in p && p.sessionKey === 'codex:mod-new'), true);
  assert.equal(retargeted.panes.some(p => 'sessionKey' in p && p.sessionKey === 'codex:scout-new'), true);
  assert.equal(retargeted.panes.some(p => p.kind === 'notebook' && p.resourceId === 'note-new'), true);
  assert.equal(retargeted.panes.some(p => p.kind === 'taskboard' && p.resourceId === 'board-new'), true);

  const modPane = retargeted.panes.find(p => p.kind === 'moderator');
  assert.deepEqual(modPane?.fileLinks, ['codex:mod-new']);
  const primarySessionPane = retargeted.panes.find(p => 'sessionKey' in p && p.sessionKey === 'codex:mod-new');
  assert.ok(primarySessionPane?.fileLinks?.includes('codex:scout-new'));
  assert.ok(primarySessionPane?.fileLinks?.includes('\u0000notebook:["hub","note-new"]'));
  assert.ok(primarySessionPane?.fileLinks?.includes('\u0000taskboard:board-new'));
});

test('upsertLiveSttSegment overwrites interim segments in-place and normalizes mixed Chinese-English speech', () => {
  assert.equal(
    normalizeMixedZhEnTranscript('请把我现在创建的这个 雷out 这个主持人布局的 session 和 taskboard 更新'),
    '请把我现在创建的这个 layout 这个主持人布局的 session 和 taskboard 更新',
  );

  let stream: ReturnType<typeof upsertLiveSttSegment> = [];
  stream = upsertLiveSttSegment(stream, { id: 'ws-1-0-0', text: '你', isFinal: false, timestampMs: 100 });
  assert.equal(stream.length, 1);
  assert.equal(stream[0]?.text, '你');

  // Interim update on the same utterance overwrites in-place instead of adding a new row
  stream = upsertLiveSttSegment(stream, { id: 'ws-1-0-0', text: '你好 session 测试', isFinal: false, timestampMs: 180 });
  assert.equal(stream.length, 1);
  assert.equal(stream[0]?.text, '你好 session 测试');

  // Finalizing that utterance still updates row 0 in-place
  stream = upsertLiveSttSegment(stream, { id: 'ws-1-0-0', text: '你好 session 测试完成', isFinal: true, timestampMs: 260 });
  assert.equal(stream.length, 1);
  assert.equal(stream[0]?.isFinal, true);
  assert.equal(stream[0]?.text, '你好 session 测试完成');

  // Next utterance starts a second row, then updates in-place until finalized
  stream = upsertLiveSttSegment(stream, { id: 'ws-1-0-1', text: '第二句 雷out', isFinal: false, timestampMs: 400 });
  assert.equal(stream.length, 2);
  assert.equal(stream[1]?.text, '第二句 layout');
});

test('prepareTemplateOptions creates fresh isolated notebook/taskboard UUIDs and avoids reusing existing sessions for moderator-mode', () => {
  const opts1 = prepareTemplateOptions(
    'moderator-mode',
    [{ sessionKey: 'codex:1' }, { sessionKey: 'codex:2' }],
    new Set(),
    'codex:1',
    'existing-note-id',
  );
  const opts2 = prepareTemplateOptions(
    'moderator-mode',
    [{ sessionKey: 'codex:1' }, { sessionKey: 'codex:2' }],
    new Set(),
    'codex:1',
    'existing-note-id',
  );
  assert.equal(opts1.primarySessionKey, undefined);
  assert.equal(opts1.secondarySessionKey, undefined);
  assert.equal(opts1.notebookTarget, 'hub');
  assert.notEqual(opts1.notebookResourceId, 'existing-note-id');
  assert.notEqual(opts1.notebookResourceId, 'default');
  assert.notEqual(opts1.taskboardResourceId, 'default');
  assert.notEqual(opts1.notebookResourceId, opts2.notebookResourceId);
  assert.notEqual(opts1.taskboardResourceId, opts2.taskboardResourceId);
});
