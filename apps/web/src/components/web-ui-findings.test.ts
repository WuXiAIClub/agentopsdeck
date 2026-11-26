import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { translateMessage, type Locale, type TranslationKey } from '../lib/translations.js';
import { findMatchingExplorerOpenWindow } from '../lib/desktop-os-mode.js';
import { validateNativeDrawioXml } from '../lib/workspace-native-drawio.js';

const source = (path: string) => readFileSync(resolve(process.cwd(), 'src', path), 'utf8');
const desktop = source('components/WorkspaceOsDesktop.tsx');
const messages = source('components/messages.tsx');
const files = source('components/FileBrowser.tsx');
const shared = source('components/SharedSessionView.tsx');
const drawio = source('components/WorkspaceNativeDrawio.tsx');
const main = source('main.tsx');
const moderator = source('components/WorkspaceModeratorControl.tsx');
const parsed = (text: string) => ts.createSourceFile('component.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function findNode(text: string, predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (predicate(node)) { found = node; return; }
    ts.forEachChild(node, visit);
  };
  visit(parsed(text));
  assert.ok(found, 'production source node must exist');
  return found;
}

function declaration(text: string, name: string): string {
  return findNode(text, node => (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node))
    && node.name?.getText() === name).getText().replace(/^export\s+/, '');
}

function callback(text: string, name: string): string {
  const node = findNode(text, item => ts.isVariableDeclaration(item) && item.name.getText() === name) as ts.VariableDeclaration;
  assert.ok(node.initializer);
  return ts.isCallExpression(node.initializer) ? node.initializer.arguments[0]!.getText() : node.initializer.getText();
}

type Tree = { type: unknown; props: Record<string, any> };
const jsx = (type: unknown, props: Record<string, any>): Tree => ({ type, props });
const jsxRuntime = { jsx, jsxs: jsx, Fragment: 'fragment' };

function evaluate<T>(text: string, expression: string, context: Record<string, unknown> = {}): T {
  const output = ts.transpileModule(text, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  return runInNewContext(`${output}\n;${expression}`, {
    URL, Blob, AbortController, crypto: { randomUUID }, exports: {},
    require: (name: string) => { assert.equal(name, 'react/jsx-runtime'); return jsxRuntime; }, ...context,
  }) as T;
}

function descendants(tree: unknown, type: unknown): Tree[] {
  if (Array.isArray(tree)) return tree.flatMap(child => descendants(child, type));
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const element = tree as Tree;
  return [...(element.type === type ? [element] : []), ...descendants(element.props.children, type)];
}

const target = { type: 'agent', connectionId: 'connector-a', agentId: 'workspace-a' };
const alternative = { type: 'agent', connectionId: 'connector-b', agentId: 'workspace-b' };
const windowStub = { location: { href: 'https://deck.example/', origin: 'https://deck.example' } };
const apiUrl = (path: string) => `https://api.example${path}`;
const mediaUrl = (path: string) => path.startsWith('/') ? apiUrl(path) : path;
const normalize = (value: unknown) => JSON.parse(JSON.stringify(value));
const forbiddenUserinfoUrl = (host: string) => ['https://', 'user', ':', 'password', '@', host, '/'].join('');

function browserHarness(mode = 'stream', configured: unknown = target) {
  const reads: unknown[][] = [], writes: unknown[][] = [], notices: string[] = [];
  const context: Record<string, any> = {
    browserEngineMode: mode, browserOpen: true, browserTarget: configured,
    browserIdentity: 'lifetime-a', browserScope: 'scope-a', browserEpoch: 1,
    browserLifetime: { current: { identity: 'lifetime-a', active: true, busy: false } },
    browserUnknown: { current: undefined }, browserCmdRevRef: { current: undefined },
    recoveryScope: () => 'scope-a', recoveryEpoch: () => 1,
    setBrowserBusy: () => undefined, setBrowserNotice: (value: string) => notices.push(value),
    api: {
      filePreview: async (...arguments_: unknown[]) => { reads.push(arguments_); return { revision: 'revision-a' }; },
      saveFileText: async (...arguments_: unknown[]) => { writes.push(arguments_); return { revision: 'revision-b' }; },
    },
  };
  context.writeDesktopBrowserCommand = evaluate(declaration(desktop, 'writeDesktopBrowserCommand'), 'writeDesktopBrowserCommand', context);
  const send = evaluate<(payload: Record<string, unknown>) => Promise<void>>(`const handler = ${callback(desktop, 'sendBrowserStreamCommand')}`, 'handler', context);
  const check = evaluate<() => Promise<void>>(`const handler = ${callback(desktop, 'checkOriginalBrowserCommand')}`, 'handler', context);
  return { context, reads, writes, notices, send, check };
}

for (const failure of ['lost response', 'AuthRequiredError', '409 conflict', 'expired scope']) {
  test(`WEBUI-001 ${failure}: one original write, paused input, read-only check`, async () => {
    const harness = browserHarness();
    harness.context.api.saveFileText = async (...arguments_: unknown[]) => {
      harness.writes.push(arguments_); throw new Error(failure);
    };
    await harness.send({ action: 'click', x: 10, y: 20, id: 'untrusted-id' });
    assert.equal(harness.writes.length, 1);
    const original = harness.context.browserUnknown.current;
    const body = JSON.parse(harness.writes[0]![2] as string);
    assert.equal(original.id, body.id);
    assert.notEqual(body.id, 'untrusted-id');
    assert.deepEqual(normalize(original.target), target);
    await harness.send({ action: 'navigate', url: 'https://external.example/' });
    assert.equal(harness.writes.length, 1);
    await harness.check();
    assert.equal(harness.writes.length, 1);
    assert.equal(harness.reads.length, 2);
    assert.equal(harness.context.browserUnknown.current, original);
    assert.match(harness.notices.at(-1)!, /still unconfirmed/);
  });
}

test('WEBUI-001 preflight failure performs no write and does not invent an unknown outcome', async () => {
  for (const missingRevision of [false, true]) {
    const harness = browserHarness();
    harness.context.api.filePreview = async () => { if (!missingRevision) throw new Error('preflight'); return {}; };
    await harness.send({ action: 'navigate' });
    assert.equal(harness.writes.length, 0);
    assert.equal(harness.context.browserUnknown.current, undefined);
    assert.match(harness.notices.at(-1)!, /No command was sent/);
  }
});

test('WEBUI-001 a scope transition during preflight prevents the first write', async () => {
  const harness = browserHarness();
  harness.context.api.filePreview = async () => {
    harness.context.browserLifetime.current.identity = 'lifetime-b'; return { revision: 'revision-a' };
  };
  await harness.send({ action: 'click' });
  assert.equal(harness.writes.length, 0);
});

test('WEBUI-001 a late write result cannot update CAS or clear the original unknown identity', async () => {
  const harness = browserHarness();
  harness.context.api.saveFileText = async (...arguments_: unknown[]) => {
    harness.writes.push(arguments_);
    harness.context.browserLifetime.current.identity = 'lifetime-b';
    return { revision: 'stale-revision' };
  };
  await harness.send({ action: 'click' });
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.context.browserCmdRevRef.current, undefined);
  assert.ok(harness.context.browserUnknown.current);
});

test('WEBUI-001 concurrent inputs are not queued and successful writes retain only current CAS', async () => {
  const harness = browserHarness();
  let finish!: (value: unknown) => void;
  harness.context.api.saveFileText = (...arguments_: unknown[]) => {
    harness.writes.push(arguments_); return new Promise(resolveWrite => { finish = resolveWrite; });
  };
  const first = harness.send({ action: 'click' });
  await Promise.resolve(); await Promise.resolve();
  await harness.send({ action: 'scroll' });
  finish({ revision: 'revision-b' }); await first;
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.context.browserCmdRevRef.current, 'revision-b');
  assert.equal(harness.context.browserUnknown.current, undefined);
});

test('WEBUI-002 writes route only to the explicitly selected configured workspace', async () => {
  for (const selected of [target, alternative]) {
    const harness = browserHarness('stream', selected);
    await harness.send({ action: 'navigate' });
    assert.equal(harness.writes.length, 1);
    assert.deepEqual(normalize(harness.reads[0]![0]), selected);
    assert.deepEqual(normalize(harness.writes[0]![0]), selected);
  }
});

test('WEBUI-002 absent target, closed browser, revoked auth and iframe mode make zero API calls', async () => {
  const variants = [browserHarness('stream', undefined), browserHarness('iframe'), browserHarness(), browserHarness()];
  variants[0]!.context.browserTarget = undefined;
  variants[2]!.context.browserOpen = false;
  variants[3]!.context.browserLifetime.current.active = false;
  for (const harness of variants) {
    const send = evaluate<(payload: Record<string, unknown>) => Promise<void>>(`const handler = ${callback(desktop, 'sendBrowserStreamCommand')}`, 'handler', harness.context);
    await send({ action: 'navigate' });
    assert.equal(harness.reads.length, 0); assert.equal(harness.writes.length, 0);
  }
});

test('WEBUI-002 catalog membership and writable root are mandatory, never first-target defaults', () => {
  const selection = callback(desktop, 'browserTarget');
  const select = (connectionId: string, agentId: string, readOnly: boolean) => evaluate<() => unknown>(
    `const selection = ${selection}`, 'selection', {
      browserConnectionId: connectionId, browserAgentId: agentId,
      browserConnections: [{ id: 'connector-a' }], browserRoots: [{ agentId: 'workspace-a', readOnly }],
    })();
  assert.equal(select('', '', false), undefined);
  assert.equal(select('absent', 'workspace-a', false), undefined);
  assert.equal(select('connector-a', 'absent', false), undefined);
  assert.equal(select('connector-a', 'workspace-a', true), undefined);
  assert.deepEqual(normalize(select('connector-a', 'workspace-a', false)), target);
  assert.match(desktop, /api\.hubConnections\(\)/);
  assert.match(desktop, /api\.connectorFileRoots\(browserConnectionId\)/);
  assert.match(desktop, /browserCmdRevRef\.current = undefined;\s*setBrowserStreamFrame\(null\); setBrowserRemoteText\(''\)/);
});

test('WEBUI-002 scoped frame polling discards late responses and cancels scheduling', async () => {
  const pollEffect = findNode(desktop, node => ts.isCallExpression(node) && node.expression.getText() === 'useEffect'
    && node.arguments[0]?.getText().includes("'browser-stream/state.json'") === true) as ts.CallExpression;
  const frames: unknown[] = [], reads: unknown[][] = [], cleared: number[] = [];
  const lifetime = { identity: 'lifetime-a', active: true };
  let finish!: (value: unknown) => void;
  const context = {
    browserOpen: true, browserEngineMode: 'stream', browserTarget: target, browserIdentity: 'lifetime-a',
    browserScope: 'scope-a', browserEpoch: 1, browserLifetime: { current: lifetime },
    recoveryScope: () => 'scope-a', recoveryEpoch: () => 1,
    document: { hidden: false }, navigator: { onLine: true },
    window: { setTimeout: () => 42, clearTimeout: (timer: number) => cleared.push(timer) },
    setBrowserStreamFrame: (frame: unknown) => frames.push(frame),
    api: { filePreview: (...arguments_: unknown[]) => { reads.push(arguments_); return new Promise(resolveRead => { finish = resolveRead; }); } },
  };
  const effect = evaluate<() => () => void>(`const effect = ${pollEffect.arguments[0]!.getText()}`, 'effect', context);
  const cleanup = effect();
  assert.deepEqual(normalize(reads[0]), [target, 'browser-stream/state.json']);
  cleanup(); finish({ kind: 'text', text: JSON.stringify({ status: 'ready', url: 'https://external.example/', title: 'Synthetic', width: 100, height: 100 }) });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(frames.length, 0);
  assert.equal(cleared.length, 0);
});

const embed = evaluate<(value: string, origin: string, apiOrigin: string) => string | undefined>(declaration(desktop, 'desktopEmbedUrl'), 'desktopEmbedUrl');
test('WEBUI-003 embedding refuses Deck/API origins, active schemes and credentials', () => {
  for (const url of ['https://deck.example/untrusted.html', 'https://api.example/file', 'javascript:alert(1)', 'data:text/html,test', 'file:///tmp/test', forbiddenUserinfoUrl('external.example'), '/relative']) {
    assert.equal(embed(url, windowStub.location.origin, 'https://api.example'), undefined);
  }
  assert.equal(embed('https://external.example/page', windowStub.location.origin, 'https://api.example'), 'https://external.example/page');
});

test('WEBUI-003 production iframe uses an opaque sandbox and no-referrer', () => {
  const iframe = findNode(desktop, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText() === 'iframe').getText();
  assert.match(iframe, /sandbox="allow-scripts"/); assert.doesNotMatch(iframe, /allow-same-origin|allow-popups|allow-top-navigation/);
  assert.match(iframe, /referrerPolicy="no-referrer"/); assert.match(iframe, /src=\{desktopEmbedUrl\(/);
});

const imageSource = evaluate<(src: string, media?: unknown[]) => { url: string; trusted: boolean } | undefined>(
  declaration(messages, 'markdownImageSource'), 'markdownImageSource', { window: windowStub, mediaUrl, apiUrl });
test('WEBUI-004 external images are untrusted while approved attachments and controlled inbound media remain usable', () => {
  assert.equal(imageSource('https://images.example/pixel.png')?.trusted, false);
  assert.equal(imageSource('/api/media/inbound/image.png')?.trusted, true);
  assert.equal(imageSource('https://api.example/api/media/inbound/image.png?tracking=1')?.trusted, false);
  assert.equal(imageSource('https://external.example/api/media/inbound/image.png')?.trusted, false);
  assert.equal(imageSource('https://images.example/approved.png', [{ type: 'image', url: 'https://images.example/approved.png' }])?.trusted, true);
  assert.equal(imageSource('https://images.example/other.png', [{ type: 'image', url: 'https://images.example/approved.png' }])?.trusted, false);
  for (const url of ['javascript:alert(1)', 'data:text/html,test', forbiddenUserinfoUrl('images.example')]) assert.equal(imageSource(url), undefined);
});

test('WEBUI-004 production Markdown image requires URL-specific consent before creating an image element', () => {
  let accepted = '';
  const ChatImage = 'approved-chat-image';
  const render = evaluate<(props: Record<string, unknown>) => Tree>(declaration(messages, 'MarkdownImage'), 'MarkdownImage', {
    markdownImageSource: imageSource, ChatImage, useI18n: () => ({ t: (key: string) => key }),
    useState: () => [accepted, (next: string) => { accepted = next; }],
  });
  const props = { src: 'https://images.example/pixel.png', alt: 'Synthetic alternative text' };
  const blocked = render(props);
  assert.equal(descendants(blocked, ChatImage).length, 0); assert.equal(descendants(blocked, 'img').length, 0);
  const button = descendants(blocked, 'button')[0]!;
  assert.equal(button.props.children, 'Load external image');
  assert.equal(descendants(blocked, 'span')[1]!.props.children, props.alt);
  button.props.onClick();
  assert.equal(descendants(render(props), ChatImage).length, 1);
  assert.equal(descendants(render({ ...props, src: 'https://images.example/next.png' }), ChatImage).length, 0);
  assert.equal(descendants(render({ ...props, media: [{ type: 'image', url: props.src }] }), ChatImage).length, 1);
  assert.match(messages, /referrerPolicy="no-referrer"/);
  assert.match(messages, /<MarkdownImage key=\{src\}/);
});

test('WEB-PENDING-003 identical Markdown does not reuse another message attachment trust', () => {
  const ChatImage = 'approved-chat-image';
  const MarkdownImage = evaluate<(props: Record<string, unknown>) => Tree>(declaration(messages, 'MarkdownImage'), 'MarkdownImage', {
    markdownImageSource: imageSource, ChatImage, useI18n: () => ({ t: (key: string) => key }),
    useState: () => ['', () => {}],
  });
  const cache = evaluate<(limit: number) => unknown>(declaration(source('lib/markdown-fast-path.ts'), 'createBoundedMarkdownCache'), 'createBoundedMarkdownCache');
  const render = evaluate<(props: Record<string, unknown>) => Tree>(`const ${declaration(messages, 'MarkdownTextContent')};`, 'MarkdownTextContent', {
    React: { memo: (component: unknown) => component, useMemo: (create: () => unknown) => create() },
    MarkdownMedia: { Provider: 'media-context' }, LazyMessageRichMarkdown: 'rich-markdown', Suspense: 'suspense',
    MarkdownImage, MarkdownLink: 'markdown-link', cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
    sourceLink: () => undefined, isPlainTextMarkdown: () => false, markdownElementCache: cache(320),
  });
  const url = 'https://images.example/attachment.png';
  const text = `![Synthetic image](${url})`;
  const approved = [{ type: 'image', url }];
  const imageIn = (media: unknown[] | undefined) => {
    const tree = render({ text, media });
    const rich = descendants(tree, 'rich-markdown')[0]!;
    const element = rich.props.components.img({ src: url, alt: 'Synthetic image' }) as Tree;
    assert.equal(element.props.media, media);
    return MarkdownImage(element.props);
  };
  assert.equal(descendants(imageIn(approved), ChatImage).length, 1);
  assert.equal(descendants(imageIn(undefined), ChatImage).length, 0);
  assert.equal(descendants(imageIn(approved), ChatImage).length, 1);
});

const fileDownloadUrl = (scope: typeof target, path: string, inline = false) => `https://api.example/api/hub/connections/${scope.connectionId}/agents/${scope.agentId}/files/download?path=${encodeURIComponent(path)}${inline ? '&inline=1' : ''}`;
const validPdf = evaluate<(value: unknown, scope: typeof target, path: string) => boolean>(declaration(files, 'validPdfPreview'), 'validPdfPreview', {
  api: { fileDownloadUrl }, window: windowStub, mediaUrl,
});
const pdfPreview = { kind: 'pdf', path: 'synthetic.pdf', name: 'synthetic.pdf', size: 10, mimeType: 'application/pdf', downloadUrl: fileDownloadUrl(target, 'synthetic.pdf', true) };
test('WEBUI-005 PDF metadata must match the controlled scoped download and requested path', () => {
  assert.equal(validPdf(pdfPreview, target, 'synthetic.pdf'), true);
  assert.equal(validPdf({ ...pdfPreview, downloadUrl: fileDownloadUrl(target, 'synthetic.pdf') }, target, 'synthetic.pdf'), true);
  for (const changed of [
    { kind: 'text' }, { path: 'other.pdf' }, { size: 0 }, { size: 33 * 1024 * 1024 }, { size: 5.5 }, { name: {} },
    { mimeType: 'text/html' }, { mimeType: undefined }, { downloadUrl: 'https://evil.example/synthetic.pdf' },
    { downloadUrl: fileDownloadUrl(alternative, 'synthetic.pdf', true) }, { downloadUrl: `${pdfPreview.downloadUrl}&path=other.pdf` },
    { downloadUrl: `${pdfPreview.downloadUrl}&token=synthetic` }, { downloadUrl: `${pdfPreview.downloadUrl}&inline=1` },
    { downloadUrl: `${pdfPreview.downloadUrl}#fragment` }, { downloadUrl: 'javascript:alert(1)' },
  ]) assert.equal(validPdf({ ...pdfPreview, ...changed }, target, 'synthetic.pdf'), false);
  assert.equal(validPdf(null, target, 'synthetic.pdf'), false);
});

test('WEBUI-005 actual PDF bytes need both PDF MIME and signature, not just an extension', async () => {
  const verify = evaluate<(blob: Blob) => Promise<boolean>>(declaration(files, 'verifiedPdfBlob'), 'verifiedPdfBlob');
  assert.equal(await verify(new Blob(['%PDF-1.7\nsynthetic'], { type: 'application/pdf' })), true);
  assert.equal(await verify(new Blob(['<html>synthetic</html>'], { type: 'application/pdf' })), false);
  assert.equal(await verify(new Blob(['%PDF-1.7'], { type: 'text/html' })), false);
  assert.equal(await verify(new Blob(['%PDF-1.7'])), false);
  assert.equal(await verify(new Blob(['%PDF'], { type: 'application/pdf' })), false);
});

test('WEBUI-005 production PDF preview validates before blob embedding and revokes on lifecycle changes', () => {
  assert.match(files, /api\.downloadFile\(scope, preview\.path, controller\.signal\)/);
  assert.match(files, /await verifiedPdfBlob\(blob\)/);
  assert.match(files, /URL\.revokeObjectURL\(url\)/);
  assert.match(files, /controller\.signal\.aborted \|\| recoveryEpoch\(\) !== epoch/);
  assert.match(files, /\}, \[preview, scope, epoch\]\)/);
  const iframe = findNode(files, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText() === 'iframe').getText();
  assert.match(iframe, /src=\{pdf\.url\}/); assert.match(iframe, /sandbox=""/); assert.match(iframe, /referrerPolicy="no-referrer"/);
  assert.doesNotMatch(iframe, /downloadUrl/);
});

for (const locale of ['en', 'zh-CN'] as const) {
  test(`WEBUI-006 both deletion variants translate title, description and confirm label in ${locale}`, () => {
    const translate = (key: TranslationKey, _language?: Locale, params?: Record<string, string>) => translateMessage(key, locale, params);
    const confirmation = evaluate<(title: string, delegated: boolean) => Record<string, string>>(declaration(main, 'sessionDeletionConfirmation'), 'sessionDeletionConfirmation', { translate });
    for (const delegated of [false, true]) {
      const result = confirmation('Synthetic <title>', delegated);
      assert.equal(result.title, translate('Delete session?'));
      assert.equal(result.confirmLabel, translate('Delete'));
      assert.ok(result.description!.includes('Synthetic <title>'));
      assert.equal(result.description!.includes('{title}'), false);
      if (locale === 'zh-CN') assert.match(result.description!, /将.*删除/);
    }
    assert.equal(main.match(/confirmAction\(sessionDeletionConfirmation\(/g)?.length, 2);
    assert.match(source('components/ui/confirm.tsx'), /confirmLabel \?\? t\('Delete'\)/);
  });
}

for (const locale of ['en', 'zh-CN'] as const) {
  test(`WEBUI-007 shared execution, transport, source and sync enums localize in ${locale}`, () => {
    const translate = (key: TranslationKey) => translateMessage(key, locale);
    const label = evaluate<(value: string, labeler: (key: TranslationKey) => string) => string>(
      `const ${declaration(shared, 'sharedStatusLabels')};\n${declaration(shared, 'sharedStatusLabel')}`, 'sharedStatusLabel',
    );
    for (const [value, key] of Object.entries({
      starting: 'Starting', running: 'run', waiting: 'waiting', finalizing: 'Finalizing', completed: 'Completed',
      failed: 'Failed', interrupted: 'Interrupted', unknown: 'Unknown', idle: 'idle', connected: 'Connected',
      disconnected: 'Disconnected', current: 'Current', syncing: 'Syncing', error: 'error', loading: 'Loading…',
      ready: 'Ready', stale: 'Stale', unavailable: 'Unavailable', connecting: 'Connecting', reconnecting: 'Reconnecting', unauthorized: 'Unauthorized',
    })) assert.equal(label(value, translate), translate(key as TranslationKey));
    assert.equal(label('Synthetic user title', translate), translate('Unknown'));
    assert.equal(label('__proto__', translate), translate('Unknown'));
    assert.equal(shared.match(/sharedStatusLabel\([^\n]+?, tr\)/g)?.length, 8);
  });
}

test('WEBUI-008 both native dialogs have bound localized accessible headings and cancellation paths', () => {
  for (const [state, titleId] of [['confirm', 'confirmTitleId'], ['catalogOpen', 'catalogTitleId']]) {
    assert.match(drawio, new RegExp(`aria-labelledby=\\{${titleId}\\}`));
    assert.match(drawio, new RegExp(`<h3 id=\\{${titleId}\\}>`));
    assert.match(drawio, new RegExp(`onCancel=\\{\\(\\) => set${state === 'confirm' ? 'Confirm\\(undefined' : 'CatalogOpen\\(false'}\\)`));
  }
  assert.match(drawio, /t\('Reload drawing\?'\)/); assert.match(drawio, /t\('Close editor\?'\)/);
  assert.equal(drawio.match(/<button autoFocus/g)?.length, 2);
});

test('WEBUI-008 showModal lifecycle restores connected trigger focus for both dialogs', () => {
  const effects: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText() === 'useEffect' && node.arguments[0]?.getText().includes('showModal()')) effects.push(node);
    ts.forEachChild(node, visit);
  };
  visit(parsed(drawio));
  assert.equal(effects.length, 2);
  for (const effect of effects) {
    let shows = 0, focuses = 0;
    class SyntheticElement { isConnected = true; focus() { focuses += 1; } }
    const trigger = new SyntheticElement();
    const open = evaluate<() => () => void>(`const effect = ${effect.arguments[0]!.getText()}`, 'effect', {
      confirm: 'close', catalogOpen: true, document: { activeElement: trigger }, HTMLElement: SyntheticElement,
      confirmDialog: { current: { showModal: () => { shows += 1; } } }, catalogDialog: { current: { showModal: () => { shows += 1; } } },
      setCatalog: () => undefined, setCatalogError: () => undefined,
      api: { workspaceNativeDrawioCatalog: async () => ({ drawings: [] }) }, scope: 'scope-a',
      recoveryScope: () => 'scope-a', recoveryEpoch: () => 1, validIdentity: () => true,
    });
    const close = open(); assert.equal(shows, 1); close(); assert.equal(focuses, 1);
    trigger.isConnected = false; close(); assert.equal(focuses, 1);
  }
});

test('WEBUI-009 production URL submit changes only the iframe tab, never the backend', () => {
  const attribute = findNode(desktop, node => ts.isJsxAttribute(node) && node.name.getText() === 'onSubmit'
    && node.getText().includes('const raw = browserUrlInput.trim()')) as ts.JsxAttribute;
  assert.ok(attribute.initializer && ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression);
  for (const mode of ['iframe', 'stream']) {
    const commands: unknown[] = [], updates: unknown[] = [];
    const handler = evaluate<(event: { preventDefault: () => void }) => void>(`const submit = ${attribute.initializer.expression.getText()}`, 'submit', {
      browserUrlInput: 'https://external.example/page', browserEngineMode: mode, browserTarget: target, activeBrowserTabId: 'tab-a',
      window: windowStub, apiUrl, desktopEmbedUrl: embed, t: (key: string) => key,
      setBrowserNotice: () => undefined, setBrowserUrlInput: (value: string) => updates.push(value),
      setBrowserTabs: (update: (tabs: unknown[]) => unknown[]) => updates.push(update([{ id: 'tab-a', title: 'Synthetic', url: 'about:home' }])),
      sendBrowserStreamCommand: (command: unknown) => commands.push(command),
    });
    handler({ preventDefault: () => undefined });
    assert.equal(updates.length, 2);
    assert.equal(commands.length, mode === 'iframe' ? 0 : 1);
    if (mode === 'stream') assert.deepEqual(normalize(commands[0]), { action: 'navigate', url: 'https://external.example/page' });
  }
});

function captureHarness() {
  let finishStart!: (handle: { stop: () => void }) => void;
  let finishSend!: () => void;
  let callbacks: Record<string, (value: any) => void> = {};
  let signal: AbortSignal | undefined;
  let stops = 0;
  const changes: unknown[] = [], sends: unknown[][] = [];
  const listeners = new Map<string, () => void>();
  const currentEpoch = { value: 1 };
  const context: Record<string, any> = {
    captureControllerRef: { current: null }, handleRef: { current: null }, captureAliveRef: { current: true },
    captureIdentityRef: { current: 'identity-a' }, captureIdentity: 'identity-a',
    captureScope: 'scope-a', captureEpoch: 1, scope: 'workspace-a', listening: false,
    recoveryScope: () => 'scope-a', recoveryEpoch: () => currentEpoch.value,
    latestOrchRef: { current: { moderatorSessionKey: 'session-a' } }, sttSettings: { provider: 'openai-whisper' },
    t: (key: string) => key,
    setListening: (value: boolean) => changes.push(value), setAudioLevel: (value: number) => changes.push(value),
    setStatusMessage: (value: string) => changes.push(value), setErrorMessage: (value: string) => changes.push(value),
    setLiveSegments: (value: unknown) => changes.push(value), setBatches: (value: unknown) => changes.push(value),
    upsertLiveSttSegment: () => [], buildModeratorBatchPrompt: () => 'Synthetic batch', emitModeratorFlow: () => undefined,
    sendMessageWithRecovery: (...args: unknown[]) => { sends.push(args); return new Promise<void>(resolveSend => { finishSend = resolveSend; }); },
    startModeratorLiveCapture: (_config: unknown, received: typeof callbacks, receivedSignal: AbortSignal) => {
      callbacks = received; signal = receivedSignal;
      return new Promise<{ stop: () => void }>(resolveStart => { finishStart = resolveStart; });
    },
    window: { addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name) },
  };
  const functions = evaluate<{ toggle: () => Promise<void>; cancel: () => void }>([
    declaration(moderator, 'cancelLiveCapture'), declaration(moderator, 'dispatchBatchToModerator'), declaration(moderator, 'toggleListening'),
  ].join('\n'), '({toggle: toggleListening, cancel: cancelLiveCapture})', context);
  context.cancelLiveCapture = functions.cancel;
  const effect = findNode(moderator, node => ts.isCallExpression(node) && node.expression.getText() === 'useEffect'
    && Boolean(node.arguments[0]?.getText().includes('captureAliveRef.current = true'))) as ts.CallExpression;
  const cleanup = evaluate<() => () => void>(`const effect = ${effect.arguments[0]!.getText()}`, 'effect', context)();
  changes.length = 0;
  return { context, changes, sends, listeners, functions, cleanup, currentEpoch,
    callbacks: () => callbacks, signal: () => signal, stops: () => stops,
    finishStart: () => finishStart({ stop: () => { stops += 1; } }), finishSend: () => finishSend(),
  };
}

for (const transition of ['stop', 'unmount', 'auth', 'pagehide', 'scope', 'session', 'provider', 'epoch']) {
  test(`WS-001 caller ${transition} cancels or fences pending capture, callbacks and late handles`, async () => {
    const harness = captureHarness();
    const pending = harness.functions.toggle();
    assert.ok(harness.signal());
    if (transition === 'stop') await harness.functions.toggle();
    if (transition === 'unmount') harness.cleanup();
    if (transition === 'auth') harness.listeners.get('agentopsdeck:auth-required')!();
    if (transition === 'pagehide') harness.listeners.get('pagehide')!();
    if (transition === 'scope' || transition === 'provider') harness.context.captureIdentityRef.current = 'identity-b';
    if (transition === 'session') harness.context.latestOrchRef.current = { moderatorSessionKey: 'session-b' };
    if (transition === 'epoch') harness.currentEpoch.value = 2;
    const count = harness.changes.length;
    harness.callbacks().onSegment!({ text: 'Synthetic segment' });
    harness.callbacks().onLevel!(0.5);
    harness.callbacks().onError!('Synthetic error');
    harness.callbacks().onBatch!({ text: 'Synthetic batch', reason: 'window' });
    assert.equal(harness.changes.length, count);
    assert.equal(harness.sends.length, 0);
    harness.finishStart(); await pending;
    assert.equal(harness.stops(), 1);
    assert.equal(harness.context.handleRef.current, null);
    if (['scope', 'session', 'provider', 'epoch'].includes(transition)) harness.cleanup();
    assert.equal(harness.signal()!.aborted, true);
    assert.equal(harness.changes.length, count);
  });
}

test('WS-001 caller dispatch uses captured session once and suppresses late completion after stop', async () => {
  const harness = captureHarness();
  const pending = harness.functions.toggle(); harness.finishStart(); await pending;
  harness.callbacks().onBatch!({ text: 'Synthetic batch', reason: 'window' });
  assert.equal(harness.sends.length, 1);
  assert.equal(harness.sends[0]![0], 'session-a');
  await harness.functions.toggle();
  const count = harness.changes.length;
  harness.finishSend(); await Promise.resolve(); await Promise.resolve();
  assert.equal(harness.changes.length, count);
  harness.callbacks().onBatch!({ text: 'Synthetic late batch', reason: 'window' });
  assert.equal(harness.sends.length, 1);
  assert.equal(harness.stops(), 1);
});

test('WS-001 both composer recognition lifetimes abort and detach on session, auth and pagehide', () => {
  const effects: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText() === 'useEffect'
      && node.arguments[0]?.getText().includes('recognition?.abort()')) effects.push(node);
    ts.forEachChild(node, visit);
  };
  visit(parsed(main)); assert.equal(effects.length, 2);
  for (const effect of effects) {
    assert.match(effect.arguments[1]!.getText(), /session.sessionKey, recoveryScope\(\), recoveryEpoch\(\)/);
    let aborts = 0;
    const recognitionRef = { current: { abort: () => { aborts += 1; } } as { abort: () => void } | null };
    const listeners = new Map<string, () => void>();
    const cleanup = evaluate<() => () => void>(`const effect = ${effect.arguments[0]!.getText()}`, 'effect', {
      setVoiceError: () => undefined, setVoiceState: () => undefined, getVoiceUnavailableReason: () => false, recognitionRef,
      discardVoiceInput: () => { recognitionRef.current?.abort(); recognitionRef.current = null; },
      window: { addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
        removeEventListener: (name: string) => listeners.delete(name) },
    })();
    assert.equal(listeners.size, 2); listeners.get('pagehide')!();
    assert.equal(aborts, 1); assert.equal(recognitionRef.current, null);
    cleanup(); assert.equal(listeners.size, 0);
  }
});

function directiveHarness(phase: 'notebook-read' | 'notebook-write' | 'board-read' | 'scout', notebookTarget = 'hub', notebookId = 'default') {
  const cfg = { moderatorSessionKey: 'moderator-a', scoutSessionKey: 'scout-a', notebookTarget, notebookId,
    taskboardId: 'board-a', systemPrompt: 'Synthetic guidance', autoSyncNotebook: true, autoSyncTaskboard: true, autoDispatchScout: true };
  const listeners = new Map<string, () => void>();
  const reads: string[] = [], writes: string[] = [], published: unknown[] = [];
  let interval!: () => void;
  let finish!: (value: unknown) => void;
  const currentEpoch = { value: 1 };
  const paused = () => new Promise(resolveRead => { finish = resolveRead; });
  const notebook = { resourceId: 'note-a', revision: 1, text: '' };
  const board = { resourceId: 'board-a', revision: 1, title: 'Synthetic board', tasks: [] };
  const context: Record<string, any> = {
    orchConfig: cfg, latestOrchRef: { current: cfg }, processedMessageIdsRef: { current: new Set() },
    directiveIdentity: 'directive-a', directiveIdentityRef: { current: 'directive-a' },
    scope: 'workspace-a', captureScope: 'account-a', captureEpoch: 1,
    recoveryScope: () => 'account-a', recoveryEpoch: () => currentEpoch.value,
    parseModeratorDirectives: () => ({ notes: phase.startsWith('notebook') ? ['Synthetic note'] : [],
      tasks: phase === 'scout' ? [] : [{ title: 'Synthetic task' }], scoutQueries: ['Synthetic query one', 'Synthetic query two'] }),
    appendModeratorNotes: () => ({ changed: true, text: 'Synthetic note' }),
    mergeModeratorTasks: () => ({ changed: true, tasks: [{ title: 'Synthetic task' }] }),
    writeCachedNotebookDocument: (...values: unknown[]) => published.push(values),
    writeCachedBoardDocument: (...values: unknown[]) => published.push(values),
    publishBoardSaved: (...values: unknown[]) => published.push(values),
    emitModeratorFlow: (value: unknown) => published.push(value),
    setAppliedDirectivesCount: (value: unknown) => published.push(value),
    CustomEvent: class { constructor(public type: string, public detail: unknown) {} },
    window: { addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
      setInterval: (callback_: () => void) => { interval = callback_; return 1; }, clearInterval: () => undefined,
      dispatchEvent: (event: unknown) => published.push(event) },
    api: {
      sessionMessages: async () => { reads.push('messages'); return { messages: [{ id: 'message-a', role: 'assistant', text: 'Synthetic directives' }] }; },
      cachedSessionMessages: () => undefined,
      workspaceBoard: async () => { reads.push('board'); return phase === 'board-read' ? paused() : board; },
      saveWorkspaceBoard: async () => { writes.push('board'); return board; },
    },
    sendMessageWithRecovery: async () => { writes.push('scout'); return phase === 'scout' ? paused() : { status: 'queued' }; },
  };
  for (const name of ['sessionNotebook', 'hubNotebook', 'hubNotebookById']) {
    context.api[name] = async () => { reads.push(name); return phase === 'notebook-read' ? paused() : notebook; };
  }
  for (const name of ['saveSessionNotebook', 'saveHubNotebook', 'saveHubNotebookById']) {
    context.api[name] = async () => { writes.push(name); return phase === 'notebook-write' ? paused() : notebook; };
  }
  const effect = findNode(moderator, node => ts.isCallExpression(node) && node.expression.getText() === 'useEffect'
    && Boolean(node.arguments[0]?.getText().includes('async function pollModeratorDirectives'))) as ts.CallExpression;
  const cleanup = evaluate<() => () => void>(`const effect = ${effect.arguments[0]!.getText()}`, 'effect', context)();
  const flush = () => new Promise<void>(resolveFlush => setImmediate(resolveFlush));
  return { context, reads, writes, published, listeners, cleanup, flush, currentEpoch, poll: () => interval(),
    finish: () => finish(phase === 'board-read' ? board : notebook) };
}

for (const transition of ['unmount', 'auth', 'pagehide', 'scope', 'epoch', 'retarget', 'disable']) {
  for (const phase of ['notebook-read', 'notebook-write', 'board-read', 'scout'] as const) {
    test(`WEB-PENDING-001 directive ${phase} fences ${transition} without subsequent writes or publication`, async () => {
      const harness = directiveHarness(phase);
      await harness.flush();
      if (transition === 'unmount') harness.cleanup();
      if (transition === 'auth') harness.listeners.get('agentopsdeck:auth-required')!();
      if (transition === 'pagehide') harness.listeners.get('pagehide')!();
      if (transition === 'scope') harness.context.directiveIdentityRef.current = 'directive-b';
      if (transition === 'epoch') harness.currentEpoch.value = 2;
      if (transition === 'retarget') harness.context.latestOrchRef.current = { ...harness.context.orchConfig, notebookId: 'note-b', scoutSessionKey: 'scout-b' };
      if (transition === 'disable') harness.context.latestOrchRef.current = { ...harness.context.orchConfig, autoSyncNotebook: false, autoDispatchScout: false };
      const writes = harness.writes.length, published = harness.published.length;
      assert.equal(writes, phase === 'notebook-write' || phase === 'scout' ? 1 : 0);
      harness.finish(); await harness.flush(); harness.poll(); await harness.flush();
      assert.equal(harness.writes.length, writes);
      assert.equal(harness.published.length, published);
      harness.cleanup(); assert.equal(harness.listeners.size, 0);
    });
  }
}

test('WEB-PENDING-001 notebook branches all stop before a stale write, and polls never overlap', async () => {
  for (const [target_, id] of [['hub', 'default'], ['hub', 'note-a'], ['session', 'moderator-a']]) {
    const harness = directiveHarness('notebook-read', target_, id);
    await harness.flush(); harness.poll(); harness.poll(); await harness.flush();
    assert.equal(harness.reads.filter(name => name === 'messages').length, 1);
    assert.equal(harness.reads.length, 2);
    harness.context.latestOrchRef.current = { ...harness.context.orchConfig, moderatorSessionKey: 'moderator-b' };
    harness.finish(); await harness.flush();
    assert.equal(harness.writes.length, 0); assert.equal(harness.published.length, 0);
    harness.cleanup();
  }
});

test('WEB-PENDING-001 current directives still save notebook and board, dispatch scouts and deduplicate', async () => {
  const harness = directiveHarness('notebook-read');
  await harness.flush(); harness.finish(); await harness.flush();
  assert.deepEqual(harness.writes, ['saveHubNotebook', 'board', 'scout', 'scout']);
  assert.ok(harness.published.length > 0);
  harness.poll(); await harness.flush();
  assert.equal(harness.writes.length, 4);
  harness.cleanup(); assert.equal(harness.listeners.size, 0);
});

test('WEB-PENDING-H002 delayed File.text across same-scope recoveryEpoch bump never mutates draft or sessionStorage', async () => {
  const inputNode = findNode(drawio, node => ts.isJsxSelfClosingElement(node)
    && node.attributes.properties.some(prop => ts.isJsxAttribute(prop) && prop.name.getText() === 'name' && prop.initializer?.getText().includes('workspacenativedrawio-input-2'))) as ts.JsxSelfClosingElement;
  const onChangeAttr = inputNode.attributes.properties.find(
    (prop): prop is ts.JsxAttribute => ts.isJsxAttribute(prop) && prop.name.getText() === 'onChange',
  );
  assert.ok(onChangeAttr?.initializer && ts.isJsxExpression(onChangeAttr.initializer) && onChangeAttr.initializer.expression);
  let currentScope: string | undefined = 'scope-a';
  let currentEpoch = 5;
  let resolveText!: (xml: string) => void;
  const draftChanges: unknown[] = [];
  const errors: string[] = [];
  const busyStates: boolean[] = [];
  const lock = { current: false };
  const alive = { current: true };
  const initialDraft = { title: 'Diagram A', xml: '<mxfile><diagram id="d1" name="Page-1"><mxGraphModel/></diagram></mxfile>', revision: 1, mutationId: 'm-1' };
  const draftRef = { current: initialDraft };
  const validIdentity = (expectedEpoch = currentEpoch) => alive.current && Boolean('scope-a') && currentScope === 'scope-a' && expectedEpoch === currentEpoch;
  const handler = evaluate<(event: { target: { files: Array<{ size: number; text: () => Promise<string> }>; value: string } }) => Promise<void>>(
    `const onChange = ${onChangeAttr.initializer.expression.getText()}`,
    'onChange',
    {
      NATIVE_DRAWIO_MAX_XML_BYTES: 1024 * 1024,
      draft: initialDraft,
      draftRef,
      disabled: false,
      lock,
      validIdentity,
      recoveryEpoch: () => currentEpoch,
      validateNativeDrawioXml,
      setBusy: (busy: boolean) => busyStates.push(busy),
      setError: (err: string) => errors.push(err),
      changeDraft: (next: unknown) => draftChanges.push(next),
    },
  );
  const pendingImport = handler({
    target: {
      value: 'selected.drawio',
      files: [{ size: 128, text: () => new Promise<string>(resolve => { resolveText = resolve; }) }],
    },
  });
  assert.equal(lock.current, true);
  // Simulate auth pause + same-account re-login bumping recoveryEpoch twice while returning to same scope string.
  currentScope = undefined;
  currentEpoch += 1;
  currentScope = 'scope-a';
  currentEpoch += 1;
  resolveText('<mxfile><diagram id="d2" name="Imported"><mxGraphModel/></diagram></mxfile>');
  await pendingImport;
  assert.equal(lock.current, false, 'import lock must always be released');
  assert.deepEqual(draftChanges, [], 'stale epoch import must not write draft or sessionStorage');
  assert.deepEqual(errors, [], 'stale epoch import must not overwrite current error state');
  assert.deepEqual(busyStates, [true], 'stale epoch import must not clobber newer busy state');
});

for (const locale of ['en', 'zh-CN'] as const) {
  test(`WEB-COMP-001 tool timeline accessibility and tooltip wrappers localize in ${locale}`, () => {
    const keys: Array<[TranslationKey, Record<string, string | number>]> = [
      ['{label} result detail', { label: 'exec_command' }],
      ['Copy {label} result', { label: 'exec_command' }],
      ['{count} tools', { count: 4 }],
      ['{label} {phase} {index} of {total}. Click to inspect.', { label: 'exec_command', phase: 'done', index: 1, total: 4 }],
      ['{label} {phase} #{index} · {tokens} context delta estimate · click to inspect', { label: 'exec_command', phase: 'done', index: 1, tokens: '+1.2k' }],
      ['{label} {phase} #{index} · click to inspect', { label: 'exec_command', phase: 'done', index: 1 }],
      ['Next tool after {elapsed}', { elapsed: '1.4s' }],
      ['{label} {phase} {index} / {total}', { label: 'exec_command', phase: 'done', index: 1, total: 4 }],
    ];
    for (const [key, vars] of keys) {
      const rendered = translateMessage(key, locale, vars);
      assert.ok(rendered.includes(String(Object.values(vars)[0])));
      if (locale === 'zh-CN') assert.notEqual(rendered, translateMessage(key, 'en', vars));
    }
    assert.doesNotMatch(messages, /aria-label=\{`\$\{entry\.label\} result detail`\}/);
    assert.doesNotMatch(messages, /aria-description=\{`\$\{entries\.length\} tools`\}/);
  });
}

test('WEB-COMP-002 explorer session open-window matching uses strict sessionKey without equal-title collision', () => {
  const openWindows = [
    { id: 'pane-1', kind: 'session' as const, sessionKey: 'local:session-alpha', title: 'Shared Title' },
    { id: 'pane-2', kind: 'session' as const, sessionKey: 'local:session-beta', title: 'Shared Title' },
    { id: 'pane-board', kind: 'taskboard' as const, sessionKey: 'os:taskboard:board-2', title: 'Taskboard', resourceId: 'board-2' },
  ];
  const targetBeta = findMatchingExplorerOpenWindow(openWindows, {
    kind: 'session',
    title: 'Shared Title',
    session: { sessionKey: 'local:session-beta', title: 'Shared Title', source: 'codex', status: 'idle' },
  });
  assert.equal(targetBeta?.id, 'pane-2');
  const closedGamma = findMatchingExplorerOpenWindow(openWindows, {
    kind: 'session',
    title: 'Shared Title',
    session: { sessionKey: 'local:session-gamma', title: 'Shared Title', source: 'codex', status: 'idle' },
  });
  assert.equal(closedGamma, undefined);
  const boardOne = findMatchingExplorerOpenWindow(openWindows, {
    kind: 'taskboard',
    title: 'Taskboard',
    resourceId: 'board-1',
  });
  assert.equal(boardOne, undefined);
  assert.match(desktop, /const openWin = findMatchingExplorerOpenWindow\(openWindows, item\);/);
});

test('WEB-COMP-003 & WEB-COMP-004 HUD 5s telemetry label and local-only Connector user hide copy match runtime behavior', () => {
  assert.doesNotMatch(desktop, /1\.5s Live/);
  assert.match(desktop, /t\('5s Live'\)/);
  assert.match(desktop, /t\('5s live telemetry \(pauses when hidden or offline\)'\)/);
  assert.equal(translateMessage('5s Live', 'zh-CN'), '5秒实时');
  assert.doesNotMatch(desktop, /Removed Connector user/);
  assert.match(desktop, /t\('Hide from local list \(does not remove runtime account\)'\)/);
  assert.match(desktop, /t\('Hidden Connector user locally \(runtime account unchanged\):'\)/);
  assert.equal(translateMessage('Hide from local list (does not remove runtime account)', 'zh-CN'), '从本地列表隐藏（不会删除运行时账户）');
});

test('Rules of Hooks: no React component or hook calls use* after an early return or inside conditionals', () => {
  const root = resolve(process.cwd(), 'src');
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((ent) => {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) return walk(full);
    return /\.(tsx|ts)$/.test(ent.name) && !/\.test\./.test(ent.name) ? [full] : [];
  });
  const hookName = /^use[A-Z]/;
  const violations: string[] = [];

  for (const file of walk(root)) {
    const code = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const checkBody = (fnNode: ts.FunctionLikeDeclaration, fnName: string) => {
      if (!fnNode.body || !ts.isBlock(fnNode.body)) return;
      let seenReturnLine: number | undefined;
      for (const stmt of fnNode.body.statements) {
        let hasReturn = false;
        const scanReturn = (n: ts.Node) => {
          if (n !== fnNode && ts.isFunctionLike(n)) return;
          if (ts.isReturnStatement(n)) hasReturn = true;
          ts.forEachChild(n, scanReturn);
        };
        const scanHooks = (n: ts.Node) => {
          if (n !== fnNode && ts.isFunctionLike(n)) return;
          if (ts.isCallExpression(n)) {
            const expr = n.expression;
            const name = ts.isIdentifier(expr) && hookName.test(expr.text)
              ? expr.text
              : ts.isPropertyAccessExpression(expr) && hookName.test(expr.name.text)
                ? expr.name.text
                : undefined;
            if (name) {
              const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
              if (seenReturnLine !== undefined) {
                violations.push(`${relative(root, file)}:${line} (${fnName}) calls ${name} after return at line ${seenReturnLine}`);
              }
              let p: ts.Node | undefined = n.parent;
              while (p && p !== fnNode) {
                if (ts.isIfStatement(p) || ts.isConditionalExpression(p) || ts.isSwitchStatement(p) || ts.isIterationStatement(p, false)) {
                  violations.push(`${relative(root, file)}:${line} (${fnName}) calls ${name} conditionally`);
                  break;
                }
                if (ts.isBinaryExpression(p) && p.right === n && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(p.operatorToken.kind)) {
                  violations.push(`${relative(root, file)}:${line} (${fnName}) calls ${name} conditionally`);
                  break;
                }
                p = p.parent;
              }
            }
          }
          ts.forEachChild(n, scanHooks);
        };
        scanHooks(stmt);
        scanReturn(stmt);
        if (hasReturn && seenReturnLine === undefined) {
          seenReturnLine = sf.getLineAndCharacterOfPosition(stmt.getStart()).line + 1;
        }
      }
    };
    const visit = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name) checkBody(n, n.name.text);
      else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isFunctionLike(n.initializer)) {
        checkBody(n.initializer, n.name.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  assert.deepEqual(violations, []);
});
