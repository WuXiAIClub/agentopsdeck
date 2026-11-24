// Test-only Chromium CPU/timeline capture. No production instrumentation.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createRequire } from 'node:module';

export async function startStartupProfile(cdp, output) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
  await cdp.send('Profiler.start');
  await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8', transferMode: 'ReturnAsStream' });
  return async () => {
    const { profile } = await cdp.send('Profiler.stop');
    const finished = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.end');
    const { stream } = await finished;
    let trace = '';
    for (;;) {
      const chunk = await cdp.send('IO.read', { handle: stream });
      trace += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString() : chunk.data;
      if (chunk.eof) break;
    }
    await cdp.send('IO.close', { handle: stream });
    const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-startup-profile-'));
    await writeFile(join(directory, 'cold.cpuprofile'), JSON.stringify(profile));
    await writeFile(join(directory, 'cold.trace.json'), trace);
    // Use the project's existing Babel source-map reader, without installing
    // dependencies or coupling the application to profiling libraries.
    const require = createRequire(import.meta.url);
    const plugin = createRequire(require.resolve('@vitejs/plugin-react'));
    const babel = createRequire(plugin.resolve('@babel/core'));
    const generator = createRequire(babel.resolve('@babel/generator'));
    const { TraceMap, originalPositionFor } = generator('@jridgewell/trace-mapping');
    const maps = new Map();
    for (const node of profile.nodes) {
      const url = node.callFrame.url;
      if (!url?.includes('/assets/') || maps.has(url)) continue;
      try { maps.set(url, new TraceMap(await readFile(join(output, 'assets', basename(new URL(url).pathname) + '.map'), 'utf8'))); }
      catch { maps.set(url, null); }
    }
    const frames = new Map(profile.nodes.map(node => {
      const frame = node.callFrame, map = maps.get(frame.url);
      const original = map && frame.lineNumber >= 0 ? originalPositionFor(map, { line: frame.lineNumber + 1, column: frame.columnNumber }) : null;
      return [node.id, { name: original?.name ?? frame.functionName, source: original?.source ?? frame.url,
        line: original?.line ?? frame.lineNumber + 1 }];
    }));
    const parent = new Map();
    for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
    const self = new Map(), inclusive = new Map();
    let sampledUs = 0;
    for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
      const id = profile.samples[i], us = profile.timeDeltas[i]; sampledUs += us;
      self.set(id, (self.get(id) ?? 0) + us);
      const visited = new Set();
      for (let cursor = id; cursor !== undefined && !visited.has(cursor); cursor = parent.get(cursor)) {
        visited.add(cursor); inclusive.set(cursor, (inclusive.get(cursor) ?? 0) + us);
      }
    }
    const byFrame = new Map(), bySource = new Map();
    for (const [id, us] of self) {
      const frame = frames.get(id), key = JSON.stringify(frame);
      byFrame.set(key, { ...frame, ms: (byFrame.get(key)?.ms ?? 0) + us / 1000 });
      const source = frame.source || frame.name || '(unknown)';
      bySource.set(source, (bySource.get(source) ?? 0) + us / 1000);
    }
    const events = JSON.parse(trace).traceEvents;
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const renderer = events.find(event => event.name === 'Layout' && event.args?.beginData?.frame === frameTree.frame.id)
      ?? events.find(event => event.name === 'thread_name' && event.args?.name === 'CrRendererMain');
    const timeline = new Map();
    for (const event of events) if (event.ph === 'X' && event.pid === renderer?.pid && event.tid === renderer?.tid) {
      const old = timeline.get(event.name) ?? { name: event.name, count: 0, ms: 0, threadMs: 0, maxMs: 0 };
      old.count++; old.ms += event.dur / 1000; old.threadMs += (event.tdur ?? 0) / 1000;
      old.maxMs = Math.max(old.maxMs, event.dur / 1000); timeline.set(event.name, old);
    }
    // Preserve all mapped frames after the temporary build/source maps are
    // removed, and record query ancestry to identify harness readiness polls.
    await writeFile(join(directory, 'frames.json'), JSON.stringify([...frames].map(([id, frame]) => ({ id, ...frame, parent: parent.get(id) })), null, 2));
    const queryCallers = profile.nodes.filter(node => node.callFrame.functionName === 'querySelectorAll' && self.has(node.id)).map(node => {
      const ancestry = [];
      for (let id = node.id; id !== undefined; id = parent.get(id)) ancestry.push(frames.get(id));
      return { selfMs: self.get(node.id) / 1000, ancestry };
    }).sort((a, b) => b.selfMs - a.selfMs);
    const summary = { directory, sampledMs: sampledUs / 1000, renderer: { pid: renderer?.pid, tid: renderer?.tid }, queryCallers,
      selfFrames: [...byFrame.values()].sort((a,b) => b.ms-a.ms).slice(0, 45),
      selfSources: [...bySource].map(([source,ms]) => ({source,ms})).sort((a,b) => b.ms-a.ms).slice(0, 30),
      inclusiveFrames: [...inclusive].map(([id,us]) => ({...frames.get(id),ms:us/1000})).sort((a,b) => b.ms-a.ms).slice(0, 40),
      timeline: [...timeline.values()].sort((a,b) => b.ms-a.ms).slice(0,30) };
    await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ label: 'startup-profile', ...summary }));
  };
}
