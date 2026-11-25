import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverScriptTests, runScriptTests } from './run-script-tests.mjs';
import { discoverTests, runSourceTests } from './run-source-tests.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const TEST_TAXONOMY = [
  {
    id: 'agent',
    target: 'server',
    title: 'Agent 适配器与运行时 (Agent Runtimes)',
    description: 'Codex、Claude Code、GitHub Copilot、Antigravity、OpenClaw Gateway 与 Hermes 运行时适配器',
    subcategories: [
      { id: 'agent:codex', title: 'Codex 运行时与 App Server', description: 'apps/server/src/codex/**' },
      { id: 'agent:claude', title: 'Claude Code 适配器与 Worker', description: 'apps/server/src/claude/**' },
      { id: 'agent:copilot', title: 'GitHub Copilot 适配器与环境', description: 'apps/server/src/copilot/**' },
      { id: 'agent:antigravity', title: 'Google Antigravity CLI 协议与隔离环境', description: 'apps/server/src/antigravity/**' },
      { id: 'agent:gateway', title: 'OpenClaw Gateway 与 Hermes', description: 'apps/server/src/{openclaw,gateway,hermes}/**' },
    ],
  },
  {
    id: 'core',
    target: 'server',
    title: '核心架构与异步编排 (Core Architecture)',
    description: 'Hub、Connector 异步表面、事件投影刷新与 Application 顶层编排',
    subcategories: [
      { id: 'core:hub', title: 'Hub 核心状态、看板与协作', description: 'apps/server/src/hub/**' },
      { id: 'core:connector', title: 'Connector 异步读取、控制与终端', description: 'apps/server/src/connector/**' },
      { id: 'core:projection', title: '状态投影与刷新调度', description: 'apps/server/src/{projection,refresh}/**' },
      { id: 'core:application', title: 'Application 组装与角色入口', description: 'apps/server/src/*.test.ts' },
    ],
  },
  {
    id: 'api',
    target: 'server',
    title: 'HTTP 路由、消息与指令流水线 (API, Routes & Commands)',
    description: 'REST/SSE 路由、消息归一化/发送、斜杠指令与系统诊断',
    subcategories: [
      { id: 'api:routes', title: 'HTTP/SSE 路由层', description: 'apps/server/src/routes/**' },
      { id: 'api:messages', title: '消息发送、归一化与工具解析', description: 'apps/server/src/{messages,tools}/**' },
      { id: 'api:commands', title: '指令队列与执行控制', description: 'apps/server/src/commands/**' },
      { id: 'api:system', title: '系统状态、诊断与基础工具', description: 'apps/server/src/{system,diagnostics,utils}/**' },
    ],
  },
  {
    id: 'storage',
    target: 'server',
    title: '存储、认证与生命周期 (Storage, Auth & Lifecycle)',
    description: 'SQLite 异步存储/准入控制、Access Key/Passkey 认证与进程生命周期',
    subcategories: [
      { id: 'storage:db', title: 'SQLite 存储、快照与准入控制', description: 'apps/server/src/storage/**' },
      { id: 'storage:auth', title: '认证、会话权限与 Passkey', description: 'apps/server/src/auth/**' },
      { id: 'storage:lifecycle', title: '生命周期、维护锁与恢复守卫', description: 'apps/server/src/lifecycle/**' },
    ],
  },
  {
    id: 'web',
    target: 'web',
    title: '前端工作台与交互 (Frontend & Workspace)',
    description: '前端工作台布局/卡片、实时消息流、会话控制、SWR 缓存与 UI 组件',
    subcategories: [
      { id: 'web:workspace', title: '工作台布局、看板、笔记与共享卡片', description: 'workspace-*, notebook-*, *layout*, pane-*, board-view-*' },
      { id: 'web:messages', title: '消息流、历史分页、SSE 与智能刷新', description: 'message-*, history-*, optimistic-*, completion-*, live-session, event-stream, refresh-control' },
      { id: 'web:sessions', title: '会话状态、草稿、运行时控制与用量', description: 'session-*, codex-*, creation-target, goal-*, tool-*, usage-*, source-*, terminal-*' },
      { id: 'web:cache-auth', title: '前端缓存预算、存储恢复与认证访问', description: 'cache-*, directory-cache, auth-*, passkey-*, startup-auth, member-*, api-base, async-transport-*' },
      { id: 'web:ui', title: '通用 UI、国际化、诊断与媒体组件', description: 'i18n, browser-diagnostics, module-load-error, composer-*, git-tree 等' },
    ],
  },
];

export function classifyServerTest(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  if (normalized.startsWith('codex/')) return 'agent:codex';
  if (normalized.startsWith('claude/')) return 'agent:claude';
  if (normalized.startsWith('copilot/')) return 'agent:copilot';
  if (normalized.startsWith('antigravity/')) return 'agent:antigravity';
  if (normalized.startsWith('openclaw/') || normalized.startsWith('gateway/') || normalized.startsWith('hermes/') || normalized.startsWith('execution/')) return 'agent:gateway';

  if (normalized.startsWith('hub/')) return 'core:hub';
  if (normalized.startsWith('connector/')) return 'core:connector';
  if (normalized.startsWith('projection/') || normalized.startsWith('refresh/')) return 'core:projection';
  if (!normalized.includes('/')) return 'core:application';

  if (normalized.startsWith('routes/')) return 'api:routes';
  if (normalized.startsWith('messages/') || normalized.startsWith('tools/')) return 'api:messages';
  if (normalized.startsWith('commands/')) return 'api:commands';
  if (normalized.startsWith('system/') || normalized.startsWith('diagnostics/') || normalized.startsWith('utils/')) return 'api:system';

  if (normalized.startsWith('storage/')) return 'storage:db';
  if (normalized.startsWith('auth/')) return 'storage:auth';
  if (normalized.startsWith('lifecycle/')) return 'storage:lifecycle';

  throw new Error(`Unclassified server test path: ${relativePath}`);
}

export function classifyWebTest(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  const name = normalized.replace(/^lib\//, '');
  if (/^(workspace-|notebook-|saved-layouts|current-layout|layout-|device-layout|display-layout|pane-|board-view|card-version-history|multi-screen-projection|desktop-os-mode)/.test(name)) {
    return 'web:workspace';
  }
  if (/^(message-|history-|progressive-tail-|optimistic-|completion-|live-session|event-stream|refresh-control|request-governor|shared-read-recovery|shared-session-live|conditional-history|receipt-recovery|queue-observation)/.test(name)) {
    return 'web:messages';
  }
  if (/^(session-|hot-sessions|codex-|creation-target|new-session|remote-draft|quick-chat|multi-reading|command-recovery|connection-control|channel-routes|gateway-display|goal-|tool-|token-usage|usage-|source-|terminal-)/.test(name)) {
    return 'web:sessions';
  }
  if (/^(cache-|directory-cache|auth-|passkey-|startup-auth|member-|api-base|async-transport)/.test(name)) {
    return 'web:cache-auth';
  }
  return 'web:ui';
}

export function classifyScriptTest(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  if (/^(ci-|check-web-i18n|web-bundle-budget|web-legal-comments|write-build-info)/.test(normalized)) return 'scripts:ci';
  if (/^(run-|compile-|compiled-|source-shadow|verify-full-|test-modules)/.test(normalized)) return 'scripts:runner';
  return 'scripts:release';
}

export function resolveModuleFiles(target, sources, selectors = []) {
  assert.ok(['server', 'web', 'scripts'].includes(target), `Unknown target: ${target}`);
  if (!selectors.length) return [...sources].sort();
  const classify = target === 'server' ? classifyServerTest : target === 'web' ? classifyWebTest : classifyScriptTest;
  const validCategories = new Set(
    target === 'scripts'
      ? ['scripts', 'scripts:ci', 'scripts:runner', 'scripts:release']
      : TEST_TAXONOMY.filter(cat => cat.target === target).flatMap(cat => [cat.id, ...cat.subcategories.map(sub => sub.id)]),
  );

  const selected = new Set();
  for (const raw of selectors) {
    assert.ok(typeof raw === 'string' && raw.trim().length > 0, 'Empty test selector');
    const token = raw.trim().replaceAll('\\', '/');
    if (sources.includes(token)) {
      selected.add(token);
      continue;
    }
    if (validCategories.has(token)) {
      const matched = sources.filter(file => {
        const sub = classify(file);
        return sub === token || sub.startsWith(`${token}:`);
      });
      assert.ok(matched.length > 0, `Category ${token} matched zero tests`);
      for (const file of matched) selected.add(file);
      continue;
    }
    throw new Error(`Unknown module selector or test path for ${target}: ${token}`);
  }
  return [...selected].sort();
}

export async function buildInventory(root = repository) {
  const serverFiles = await discoverTests(join(root, 'apps/server/src'));
  const webFiles = await discoverTests(join(root, 'apps/web/src'));
  const scriptFiles = await discoverScriptTests(join(root, 'scripts'));

  const counts = {};
  for (const file of serverFiles) {
    const sub = classifyServerTest(file);
    const major = sub.split(':')[0];
    counts[major] = (counts[major] ?? 0) + 1;
    counts[sub] = (counts[sub] ?? 0) + 1;
  }
  for (const file of webFiles) {
    const sub = classifyWebTest(file);
    counts.web = (counts.web ?? 0) + 1;
    counts[sub] = (counts[sub] ?? 0) + 1;
  }
  for (const file of scriptFiles) {
    const sub = classifyScriptTest(file);
    counts.scripts = (counts.scripts ?? 0) + 1;
    counts[sub] = (counts[sub] ?? 0) + 1;
  }
  return { serverFiles, webFiles, scriptFiles, counts };
}

export async function printInventory(root = repository) {
  const { serverFiles, webFiles, scriptFiles, counts } = await buildInventory(root);
  console.log(`AgentOpsDeck Modular Test Inventory (Server: ${serverFiles.length}, Web: ${webFiles.length}, Scripts: ${scriptFiles.length})\n`);
  for (const category of TEST_TAXONOMY) {
    console.log(`[${category.id}] ${category.title} (${counts[category.id] ?? 0} files, target=${category.target})`);
    for (const sub of category.subcategories) {
      console.log(`  - ${sub.id.padEnd(18)} ${String(counts[sub.id] ?? 0).padStart(4)} files  (${sub.title}: ${sub.description})`);
    }
    console.log('');
  }
  console.log(`[scripts] 构建、CI 与发布脚手架 (${counts.scripts ?? 0} files, target=scripts)`);
  console.log(`  - scripts:ci         ${String(counts['scripts:ci'] ?? 0).padStart(4)} files  (CI 策略、构建与 i18n 守卫)`);
  console.log(`  - scripts:runner     ${String(counts['scripts:runner'] ?? 0).padStart(4)} files  (测试运行器与分批执行校验)`);
  console.log(`  - scripts:release    ${String(counts['scripts:release'] ?? 0).padStart(4)} files  (候选发布、升级、备份与探针脚本)`);
}

export async function runModuleCli(args = process.argv.slice(2), root = repository) {
  if (!args.length || args[0] === '--list' || args[0] === 'list') {
    await printInventory(root);
    return;
  }
  const serverCategories = new Set(['agent', 'core', 'api', 'storage']);
  const first = args[0];

  if (first === 'server' || first === 'web') {
    const sources = await discoverTests(join(root, 'apps', first, 'src'));
    const selected = resolveModuleFiles(first, sources, args.slice(1));
    await runSourceTests(first, selected);
    return;
  }

  if (first === 'scripts' || first.startsWith('scripts:')) {
    const selectors = first === 'scripts' ? args.slice(1) : args;
    const sources = await discoverScriptTests(join(root, 'scripts'));
    const selected = resolveModuleFiles('scripts', sources, selectors);
    await runScriptTests(selected);
    return;
  }

  const major = first.split(':')[0];
  if (serverCategories.has(major)) {
    const sources = await discoverTests(join(root, 'apps/server/src'));
    const selected = resolveModuleFiles('server', sources, args);
    await runSourceTests('server', selected);
    return;
  }

  if (major === 'web') {
    const sources = await discoverTests(join(root, 'apps/web/src'));
    const selected = resolveModuleFiles('web', sources, args);
    await runSourceTests('web', selected);
    return;
  }

  throw new Error(
    `Usage: node scripts/test-modules.mjs [--list | <category[:subcategory]>... | server <selectors...> | web <selectors...> | scripts <selectors...>]`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runModuleCli();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
