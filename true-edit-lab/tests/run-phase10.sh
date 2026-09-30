#!/bin/sh
# Runs the Phase 10 corpus-harness test sequence and writes logs to tests/results/phase10-*.
# The frozen Phase 9 sequence is tests/run-all.sh (unchanged; run it as well).
# Prerequisites (once): cd tests && npm install ; sh tests/tools/fetch-engine.sh
# Browser step needs: pip install playwright==1.56.0 && python3 -m playwright install chromium
# Usage (from the package root): sh tests/run-phase10.sh [--no-browser]
set -u
cd "$(dirname "$0")/.." || exit 2
R=tests/results
mkdir -p "$R"
FAILED=""
step() {
  name=$1; shift
  printf '%-44s' "$name"
  if "$@" > "$R/$name.log" 2>&1; then echo PASS; else
    echo "FAIL (see $R/$name.log)"; FAILED="$FAILED $name"
    # CI shows only this output: include the end of the failing log.
    echo "----- last 150 lines of $R/$name.log -----"; tail -n 150 "$R/$name.log"; echo "----- end of $name -----"
  fi
}
step phase10-phase9-frozen python3 tests/tools/check_phase9_frozen.py
step phase10-lists python3 tests/tools/build_phase10_package.py --check
step phase10-refs-host-compat python3 tests/tools/check_phase10_refs.py
step phase10-node-tests node --test tests/node/phase10-corpus.test.mjs
step phase10b-clip-tests node --test tests/node/phase10b-clip.test.mjs
step phase10-deploy-rollback sh tests/tools/phase10_deploy_test.sh
if [ "${1:-}" != "--no-browser" ]; then
  step phase10-browser python3 tests/harness/run-phase10.py
fi
python3 tests/tools/normalize_results.py > /dev/null
step phase10-ascii-check python3 tests/tools/check_ascii.py
if [ -n "$FAILED" ]; then echo "FAILED:$FAILED"; exit 1; fi
echo "ALL PHASE 10 STEPS PASSED"
