import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unsafeTextCategory } from './publication-check.mjs';

export function normalizeUpstreamPatch(patch) {
  const sourceBrand = ['claw', 'pool'].join('');
  const brandPattern = new RegExp(sourceBrand, 'gi');
  return patch
    .replace(new RegExp(`\\b${sourceBrand.toUpperCase()}_[A-Z0-9_]+\\b`, 'g'), name =>
      /_(VERSION|BUILD)$/.test(name) ? name.replace(brandPattern, 'AGENTOPSDECK') : name.replace(new RegExp(`^${sourceBrand}_`, 'i'), 'AOD_'))
    .replace(brandPattern, name => name === name.toUpperCase() ? 'AGENTOPSDECK' : name[0] === name[0].toUpperCase() ? 'AgentOpsDeck' : 'agentopsdeck')
    .replace(/\bAGENTOPSDECK_[A-Z0-9_]+\b/g, name => /^(AGENTOPSDECK_VERSION|AGENTOPSDECK_BUILD)$/.test(name) ? name : name.replace('AGENTOPSDECK_', 'AOD_'))
    .replace(/\.agentopsdeck|\.agentopsdeck/g, '.agentopsdeck')
    .replace(/agentopsdeck-parallel/g, 'agentopsdeck-local')
    .replace(/AgentOpsDeck/g, 'AgentOpsDeck')
    .replace(/(?<!AOD_)OPENCLAW_GATEWAY_(WS_URL|ADMIN_RPC_URL|OWNER_TOKEN|PASSWORD)/g, 'AOD_OPENCLAW_GATEWAY_$1')
    .replace(/(?<!AOD_)OPENCLAW_DEFAULT_AGENT_ID/g, 'AOD_OPENCLAW_DEFAULT_AGENT_ID')
    .replace(/agentopsdeck_session/g, 'agentopsdeck_session')
    .replace(/agentopsdeck_access/g, 'agentopsdeck_access')
    .replace(/x-agentopsdeck-key/g, 'x-agentopsdeck-key')
    .replace(/agentopsdeck\.locale/g, 'agentopsdeck.locale')
    .replace(/agentopsdeck-shell/g, 'agentopsdeck-shell')
    .replace(/agentopsdeck-operator/g, 'agentopsdeck-operator')
    .replace(/agentopsdeck-sbx-/g, 'aod-sbx-')
    .replace(/agentopsdeck\.(sandbox|profile|owner|env)/g, 'agentopsdeck.$1')
    .replace(/\/run\/agentopsdeck-secrets/g, '/run/agentopsdeck-secrets');
}

export function prepareUpstreamPatch(source, commit) {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit)) throw new Error('FULL_COMMIT_REQUIRED');
  const git = args => execFileSync('git', args, { cwd: resolve(source), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
  const parents = git(['rev-list', '--parents', '-n', '1', commit]).trim().split(' ');
  if (parents.length !== 2) throw new Error('SINGLE_PARENT_COMMIT_REQUIRED');
  const patch = git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', parents[1], commit, '--',
    'apps/server/src', 'apps/web/src', 'packages/shared/src', ':(exclude)packages/shared/src/protocol.ts', ':(exclude)packages/shared/src/build-info.generated.ts']);
  if (!patch.trim()) throw new Error('NO_ELIGIBLE_SOURCE_CHANGE');
  if (/^Binary files |^GIT binary patch/m.test(patch)) throw new Error('BINARY_PORT_REQUIRES_REVIEW');
  const normalized = normalizeUpstreamPatch(patch);
  if (unsafeTextCategory(normalized)) throw new Error('UNSAFE_SOURCE_PATCH');
  return normalized;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('SOURCE_AND_COMMIT_REQUIRED');
    process.stdout.write(prepareUpstreamPatch(process.argv[2], process.argv[3]));
  } catch {
    console.error('UPSTREAM_PATCH_REFUSED: review the source and single-parent commit privately.');
    process.exitCode = 1;
  }
}
