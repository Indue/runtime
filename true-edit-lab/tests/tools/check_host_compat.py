#!/usr/bin/env python3
"""Pre-deploy check against the live host's URL rules (app.noblepdf.com, GoDaddy Apache).

Measured on 2026-09-30 with read-only GET requests: every URL whose path ends in .json is
answered 403 before the filesystem is consulted (also for files that do not exist), while
.html, .js, .mjs, .css, .pdf and .txt files are served. A deployed file the host refuses
makes the lab fail closed live even though every local test passed, so this check:
  - allows only extensions the live host is known to serve;
  - requires the fixture manifest URL pinned in the suite and editor pages to name a file
    that is in deploy-files.txt, with an allowed extension and the pinned SHA-256.
Usage: python3 tests/tools/check_host_compat.py"""
import hashlib
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
APP = os.path.join(ROOT, 'public_html', 'app.noblepdf.com')
LAB = 'lab/true-text-edit/'
SERVED = {'.html', '.js', '.mjs', '.css', '.pdf', '.txt'}
FORBIDDEN = {'.json'}
bad = []
listed = {}
for line in open(os.path.join(ROOT, 'deploy', 'deploy-files.txt'), encoding='ascii'):
    if not line.strip():
        continue
    want, rel = line.split()
    listed[rel] = want
    ext = os.path.splitext(rel)[1].lower()
    if ext in FORBIDDEN:
        bad.append(f'{rel}: the live host answers 403 to every {ext} URL')
    elif ext not in SERVED:
        bad.append(f'{rel}: extension {ext or "(none)"} not verified on the live host')
for page in ('phase9-suite.js', 'phase9-editor.js'):
    s = open(os.path.join(APP, LAB, page), encoding='ascii').read()
    m = re.search(r"const MANIFEST = Object\.freeze\(\{ url: '\./([^'?]+)(\?v=\d+)?', sha256: '([0-9a-f]{64})' \}\);", s)
    if not m:
        bad.append(f'{page}: manifest pin line not found')
        continue
    rel = LAB + m.group(1)
    if rel not in listed:
        bad.append(f'{page}: manifest URL {rel} is not in deploy-files.txt')
    elif listed[rel] != m.group(3):
        bad.append(f'{page}: manifest pin {m.group(3)} != deploy-files.txt {listed[rel]}')
    elif hashlib.sha256(open(os.path.join(APP, rel), 'rb').read()).hexdigest() != m.group(3):
        bad.append(f'{page}: {rel} on disk does not match the pin')
    if os.path.splitext(rel)[1].lower() not in SERVED:
        bad.append(f'{page}: manifest URL {rel} uses an extension the live host does not serve')
print(f'{len(listed)} deploy files checked against the live host URL rules (served: {" ".join(sorted(SERVED))}; refused: {" ".join(sorted(FORBIDDEN))})')
for b in bad:
    print('FAIL', b)
sys.exit(1 if bad else 0)
