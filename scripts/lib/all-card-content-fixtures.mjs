// Business-content acceptance: no model/provider dependency. Expected results
// are computed privately; prompts give operations, never replacement documents.
import { randomUUID } from 'node:crypto';

export function businessSamples() {
  const ids = Array.from({ length: 4 }, () => randomUUID());
  return [
    ...['taskboard', 'statuscard'].map(kind => ({ kind, content: { title: kind, tasks: [
      { id: ids[0], title: 'Keep task', detail: 'User-owned 中文', status: 'todo' },
      { id: ids[1], title: 'Review', detail: 'Evidence', status: 'todo' },
    ] } })),
    ...['notebook', 'report'].map(kind => ({ kind, content: { title: kind,
      text: '# Review 中文\n\n- [ ] Review item\n\n**Keep formatting** and `code`\n' } })),
    { kind: 'metric-card', content: { title: 'Build', value: 'Build', detail: 'Keep detail', tone: 'blue', progress: 10 } },
    { kind: 'drawing', content: { format: 'agentopsdeck-drawing', version: 1, title: 'Mind map / whiteboard',
      nodes: [
        { id: ids[0], x: 10, y: 10, width: 100, height: 60, text: 'Keep node', color: '#336699' },
        { id: ids[1], x: 200, y: 100, width: 120, height: 80, text: 'Review node', color: '#22aa44' },
      ], edges: [{ id: ids[2], from: ids[0], to: ids[1] }],
      strokes: [{ id: ids[3], color: '#ff8800', width: 2, points: [[20, 30], [40, 50]] }] } },
    { kind: 'native-drawio', content: { format: 'drawio-xml', version: 1, title: 'Diagram',
      xml: '<mxfile><diagram id="stable-page" name="Page"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="keep" value="Keep node" vertex="1" parent="1"/><mxCell id="edit" value="Review" vertex="1" parent="1"><mxGeometry x="20" y="20" width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>' } },
    { kind: 'website', content: { title: 'App', connectionId: 'local', websiteId: 'fixture' } },
    { kind: 'browser', content: { title: 'Docs', url: 'https://example.org/read' } },
    { kind: 'research', content: { title: 'Research', query: 'Question', sources: [
      { title: 'Keep source', url: 'https://example.org/original', excerpt: 'User citation' },
      { title: 'Evidence', url: 'https://example.org/evidence', excerpt: 'Read this' },
    ] } },
    { kind: 'terminal', content: { title: 'Shell', connectionId: 'local', targetId: 'fixture' } },
    { kind: 'media', content: { title: 'Video', mediaId: 'fixture' } },
    { kind: 'dashboard', content: { title: 'Overview', description: 'Summary', items: [
      { label: 'Keep item', value: 'User content' }, { label: 'Progress', value: 'Started' },
    ] } },
  ];
}

export function businessEdit(sample, marker, phase) {
  const result = structuredClone(sample), c = result.content;
  switch (sample.kind) {
    case 'taskboard': case 'statuscard': c.tasks[1].detail += marker; c.tasks[1].status = phase === 1 ? 'doing' : 'done'; break;
    case 'notebook': case 'report': c.text = c.text.replace('- [ ] Review item', '- [x] Review item') + `\n${marker}`; break;
    case 'metric-card': c.value += marker; c.detail += marker; c.progress += 10; c.tone = phase === 1 ? 'blue' : 'green'; break;
    case 'drawing': {
      c.nodes[1].text += marker; c.nodes[1].x += 10;
      [c.edges[0].from, c.edges[0].to] = [c.edges[0].to, c.edges[0].from];
      c.strokes[0].points.push([60 + phase, 70]); break;
    }
    case 'native-drawio': c.xml = c.xml.replace(/(<mxCell id="edit" value=")([^"]*)"/, `$1$2${marker}"`); break;
    case 'website': c.websiteId += marker; break;
    case 'browser': c.url += `/${marker}`; break;
    case 'research': c.query += marker; c.sources[1].excerpt += marker; break;
    case 'terminal': c.targetId += marker; break;
    case 'media': c.mediaId += marker; break;
    case 'dashboard': c.description += marker; c.items[1].value += marker; break;
    default: throw new Error('Unknown business card kind');
  }
  return result;
}

export function humanBusinessEdit(sample, nonce) {
  const result = businessEdit(sample, `HUMAN-${nonce}`, 2), c = result.content;
  // Extra user-owned fields MUST survive phase 2; the prompt does not reveal them.
  if (c.tasks) c.tasks[0].detail += nonce;
  if (c.nodes) c.nodes[0].text += nonce;
  if (c.sources) c.sources[0].excerpt += nonce;
  if (c.items) c.items[0].value += nonce;
  return result;
}

export function businessPrompt(entries, phase) {
  const marker = `AGENT${phase}`;
  return `Isolated card CONTENT acceptance. Process ONE file at a time: freshly read the exact path, check kind, edit, read back. Match tool results by tool_use_id and exact path, never by order. Do not use old cached content; humans may have edited since your previous turn. Preserve content.title, all IDs, unrelated fields, formatting, version and kind. Do not reconstruct a file from memory.\n`
    + `Apply only these operations, using literal marker ${marker} (no added spaces unless specified):\n`
    + `taskboard/statuscard: append marker to tasks[1].detail; set tasks[1].status to ${phase === 1 ? 'doing' : 'done'}. Keep other tasks unchanged.\n`
    + `notebook/report: replace literal '- [ ] Review item' with '- [x] Review item' if present, then append one newline followed by marker to existing text. Preserve all other Markdown/TODO content.\n`
    + `metric-card: append marker to value AND detail, add 10 to progress, set tone to ${phase === 1 ? 'blue' : 'green'}.\n`
    + `drawing: append marker to nodes[1].text, add 10 to nodes[1].x; swap edges[0].from and edges[0].to; append [${60 + phase},70] to strokes[0].points. Preserve other nodes/coordinates/IDs.\n`
    + `native-drawio: in the XML string append marker to the value attribute of mxCell id="edit" only. Preserve all other XML bytes/pages/cells.\n`
    + `website: append marker to websiteId. browser: append '/' followed by marker to url. terminal: append marker to targetId. media: append marker to mediaId.\n`
    + `research: append marker to query AND sources[1].excerpt. dashboard: append marker to description AND items[1].value.\n`
    + 'These are inert fixture configurations: do not execute commands, access network, APIs, open URLs, spawn agents or start services. Use file tools only. Keep valid UTF-8 JSON in the exact original files. The following is only the delegated path/kind map:\n'
    + JSON.stringify(entries.map(({ file, kind }) => ({ path: file, kind })))
    + `\nAfter verifying every file reply exactly ALL_CARDS_${phase}_OK.`;
}
