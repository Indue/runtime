#!/usr/bin/env python3
"""Proves the Phase 9 lab package is byte-identical to its frozen baseline (a3f9038).

Every file listed in the Phase 9 package manifest (MANIFEST.sha256, written by
build_package.py at a3f9038) must still have exactly that SHA-256: lab pages and modules,
fixtures, deploy scripts and lists, the Phase 9 tests and harness, the workflow copy and the
Phase 9 docs. Generated test output under tests/results/ is skipped (every run rewrites it).
The repository-root workflow must equal the package copy. When git is available, the diff
from a3f9038 must not modify or delete any file outside the Phase 10 additions.
Usage: python3 tests/tools/check_phase9_frozen.py"""
import hashlib
import os
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
BASELINE = 'a3f9038c11b0b82eba94ed965818e8698ca1e491'
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
bad = []
n = 0
if not os.path.isfile(os.path.join(ROOT, 'README-PHASE9-LAB.txt')):
    # Inside the Phase 10 deploy package MANIFEST.sha256 is the Phase 10 package manifest; the
    # Phase 9 baseline is proven in the repository CI (true-edit-phase10-corpus.yml), not here.
    print('NOT APPLICABLE: this tree is not the Phase 9 package (no README-PHASE9-LAB.txt); run this check in the repository')
    sys.exit(0)
for line in open(os.path.join(ROOT, 'MANIFEST.sha256'), encoding='ascii'):
    if not line.strip():
        continue
    want, rel = line.split(None, 1)
    rel = rel.strip()
    if rel.startswith('tests/results/'):
        continue
    p = os.path.join(ROOT, rel)
    n += 1
    if not os.path.isfile(p):
        bad.append(f'{rel}: missing')
    elif sha(p) != want:
        bad.append(f'{rel}: changed')
root_wf = os.path.join(ROOT, '..', '.github', 'workflows', 'true-edit-phase9-lab.yml')
if os.path.isfile(root_wf) and open(root_wf, 'rb').read() != open(os.path.join(ROOT, '.github', 'workflows', 'true-edit-phase9-lab.yml'), 'rb').read():
    bad.append('.github/workflows/true-edit-phase9-lab.yml (repository root) differs from the package copy')
git = ''
try:
    top = subprocess.run(['git', 'rev-parse', '--show-toplevel'], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    has = subprocess.run(['git', 'cat-file', '-e', BASELINE + '^{commit}'], cwd=top, capture_output=True).returncode == 0
    if has:
        out = subprocess.run(['git', 'diff', '--name-status', BASELINE, '--', '.'], cwd=top, capture_output=True, text=True, check=True).stdout
        changed = [ln for ln in out.splitlines() if ln and not ln.startswith('A\t')]
        for ln in changed:
            status, path = ln.split('\t', 1)
            if '/tests/results/' in path and path.rsplit('/', 1)[-1].startswith('phase10-'):
                continue
            bad.append(f'git: {status} {path} (only additions are allowed on top of {BASELINE[:7]})')
        git = f'; git diff from {BASELINE[:7]}: {len(out.splitlines())} path(s), {len(changed)} modified or deleted'
    else:
        git = f'; git baseline {BASELINE[:7]} not available (shallow clone): manifest check only'
except Exception as e:  # no git: the manifest check alone still applies
    git = f'; git unavailable ({e.__class__.__name__})'
print(f'{n} Phase 9 package files checked against MANIFEST.sha256 (tests/results skipped){git}')
for b in bad:
    print('FAIL', b)
sys.exit(1 if bad else 0)
