# Test-focused CI

**English · [简体中文](ci.zh-CN.md) · [Documentation](README.md)**

[GitHub Actions](../.github/workflows/ci.yml) is the primary CI. It triggers on
pull requests, pushes to `main` and manual dispatch. Hosted Ubuntu runners use
Node/pnpm versions declared in the workflow, pinned actions, read-only repository
permissions and credential-free checkout. No provider account, self-hosted runner,
local proxy, service restart, deployment or artifact publication is required.

The validation job performs frozen install, security, i18n, API drift checks,
build/typecheck, the complete script suite and all browser source-unit tests.
Both pipelines also run `pnpm check:review` to reject missing, duplicate or stale
file-review evidence. This is an inventory/evidence gate, not semantic approval:
`pnpm check:review:complete` remains the separate, stricter release-review gate.
Incomplete reviews and open findings must not be described as publication-ready.
Twelve independent backend shards partition every discovered `*.test.ts` file
exactly once via the existing isolated source runner. Fail-fast is disabled so a
failed shard does not conceal other shard results. Tests do not load operator
homes or keys. Native/real-provider integration and physical browser interaction
are outside this workflow, not silently counted as passing.

After source checks, the validation job runs `pnpm audit --prod --audit-level=high`.
It also runs `pnpm audit --audit-level=high` with `NODE_ENV=development`, covering
build/test dependencies instead of silently inheriting a production-only scope.
These registry-backed checks block green CI on high/critical dependency
advisories; it is not an exploitability verdict. Targeted remediation on
November 22, 2026 reduced the locked production and development-inclusive audits
from 35 production advisories to zero, and the local high-severity gate passed.
The script suite also guards reviewed dependency floors. Keep the registry gate
enabled: this local result is not proof that remote GitHub CI has run or that
license/artifact and deployment acceptance gates are complete.

An optional [GitLab test mirror](../.gitlab-ci.yml) runs the same source gates and
suites on an untagged compatible runner. It does not mirror private upstream
history or deploy. The advanced historical GitLab contract lives only in
[`scripts/fixtures/gitlab-ci.json`](../scripts/fixtures/gitlab-ci.json) for regression
testing CI utilities; it is not the active pipeline.

## Local equivalent

```sh
pnpm install --frozen-lockfile --prod=false
export NODE_ENV=development
pnpm check:security
pnpm check:i18n
pnpm check:api
pnpm check:review
pnpm --workspace-concurrency=1 -r build
pnpm --workspace-concurrency=1 -r typecheck
node scripts/run-script-tests.mjs
node scripts/run-source-tests.mjs web
pnpm audit --prod --audit-level=high
pnpm audit --audit-level=high
node scripts/github-source-tests.mjs 1 12
```

The last command runs **one** shard only; execute shards 1–12 or run
`node scripts/run-source-tests.mjs server` for full backend coverage.
Keep test/build output private until checked for unexpected sensitive diagnostics.
Configured remote CI is not remotely verified until this source is authorized
for publication/push and the real GitHub jobs complete.
