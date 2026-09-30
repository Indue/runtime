#!/bin/sh
# Runs the complete local CI sequence for the True Edit lab package and writes logs to
# tests/results/. Exit status is non-zero if any step fails.
# Prerequisites (once): cd tests && npm install ; sh tests/tools/fetch-engine.sh
# Browser steps need: pip install playwright && python3 -m playwright install chromium
# Usage (from the package root): sh tests/run-all.sh [--no-browser]
set -u
cd "$(dirname "$0")/.." || exit 2
R=tests/results
mkdir -p "$R"
FAILED=""
step() {
  name=$1; shift
  printf '%-44s' "$name"
  if "$@" > "$R/$name.log" 2>&1; then echo PASS; else echo "FAIL (see $R/$name.log)"; FAILED="$FAILED $name"; fi
}
step unit-tests node --test tests/node/unit.test.mjs
step setpositions-api-tests node --test tests/node/setpositions-api.test.mjs
for v in 3 4 6; do step "node-suite-pdfjs$v" node tests/node/run-suite.mjs --pdfjs "$v" --json "$R/node-suite-pdfjs$v.json"; done
step faults node tests/node/faults.mjs --json "$R/faults.json"
for v in 3 4 6; do step "thresholds-pdfjs$v" node tests/node/thresholds.mjs --pdfjs "$v" --json "$R/thresholds-pdfjs$v.json"; done
step fixture-manifest python3 tests/tools/verify_manifest.py
step host-compat python3 tests/tools/check_host_compat.py
step deploy-rollback sh tests/tools/deploy_test.sh
if [ "${1:-}" != "--no-browser" ]; then
  step v2-harness-matrix python3 tests/harness/run-matrix.py
  step phase9-browser python3 tests/harness/run-phase9.py
fi
python3 tests/tools/normalize_results.py > /dev/null
step ascii-check python3 tests/tools/check_ascii.py
if [ -n "$FAILED" ]; then echo "FAILED:$FAILED"; exit 1; fi
echo "ALL STEPS PASSED"
