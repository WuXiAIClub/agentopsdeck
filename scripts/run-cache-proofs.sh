#!/usr/bin/env bash
# Reproducible runner for the COD-055 cache + hydration verification proofs.
# Bundles the TS proofs into an isolated 0700 temp directory with repo-local
# esbuild so concurrent runs never collide and failed runs always clean up.
set -euo pipefail
cd "$(dirname "$0")/.."

ESBUILD="$(find node_modules -path '*esbuild@*/node_modules/esbuild/bin/esbuild' | head -1)"
if [[ -z "${ESBUILD}" ]]; then echo "esbuild not found (run pnpm install)" >&2; exit 1; fi

umask 077
PROOF_TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/agentopsdeck-cache-proofs.XXXXXX")"
chmod 700 "${PROOF_TMP_ROOT}"
cleanup() {
  rm -rf "${PROOF_TMP_ROOT}"
}
trap cleanup EXIT

run_proof() {
  local src="$1"
  local name="$2"
  local out="${PROOF_TMP_ROOT}/${name}.bundle.mjs"
  "${ESBUILD}" "${src}" --bundle --platform=node --format=esm \
    --tsconfig=tsconfig.base.json --outfile="${out}" --log-level=warning
  node "${out}"
}

if [[ "$#" -gt 0 ]]; then
  for proof_src in "$@"; do
    proof_name="$(basename "${proof_src}" .mts)"
    run_proof "${proof_src}" "${proof_name}"
  done
  exit 0
fi

echo "== Cache logic proof =="
run_proof scripts/verify-cache.mts verify-cache
echo
echo "== Hydration timeline proof =="
run_proof scripts/verify-hydration.mts verify-hydration
