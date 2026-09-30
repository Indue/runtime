#!/usr/bin/env python3
"""Pre-deploy checks for the Phase 10 page:
  - every Phase 10 deploy file and required lab file uses an extension the live host serves
    (the host answers 403 to every *.json URL);
  - every same-origin file the page loads (HTML src/href, and the static import closure of its
    module graph) is either a Phase 10 deploy file or a pinned required file;
  - that set equals the allowlist in te-corpus-env.mjs (LAB_FILES), so the network ledger
    neither misses a file the page needs nor allows one it does not load;
  - Phase 10 imports te-env.mjs with the same URL (?v=2) as the frozen Phase 9 pages.
Usage: python3 tests/tools/check_phase10_refs.py"""
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
LABDIR = os.path.join(ROOT, 'public_html', 'app.noblepdf.com', 'lab', 'true-text-edit')
SERVED = {'.html', '.js', '.mjs', '.css', '.pdf', '.txt'}
bad = []


def read_list(name):
    out = {}
    for line in open(os.path.join(ROOT, 'deploy', name), encoding='ascii'):
        if line.strip():
            h, rel = line.split()
            out[rel] = h
    return out


deploy = read_list('phase10-deploy-files.txt')
req = read_list('phase10-required-unchanged.txt')
for rel in list(deploy) + [r for r in req if r.startswith('lab/')]:
    if os.path.splitext(rel)[1].lower() not in SERVED:
        bad.append(f'{rel}: extension not served by the live host')
pinned = {r.split('/')[-1] for r in list(deploy) + list(req) if r.startswith('lab/true-text-edit/')}
html = open(os.path.join(LABDIR, 'phase10-corpus.html'), encoding='ascii').read()
refs = set()
for m in re.finditer(r'(?:src|href)="([^"]+)"', html):
    u = m.group(1)
    if u.startswith('/vendor/'):
        if u.lstrip('/') not in req:
            bad.append(f'html loads {u}, which is not pinned')
        continue
    refs.add(u.split('?')[0])
todo = [r for r in refs if r.endswith('.js') or r.endswith('.mjs')]
seen = set(refs)
imports_env = set()
while todo:
    f = todo.pop()
    src = open(os.path.join(LABDIR, f), encoding='ascii').read()
    for m in re.finditer(r"(?:import|export)[^'\"]*?from\s+'\./([^'?]+)(\?v=\d+)?'", src):
        name = m.group(1)
        if name == 'te-env.mjs':
            imports_env.add(m.group(2))
        if name not in seen:
            seen.add(name)
            todo.append(name)
for f in sorted(seen):
    if f not in pinned:
        bad.append(f'the page loads {f}, which is neither a Phase 10 deploy file nor a pinned required file')
allow = re.search(r"const LAB_FILES = \[([^\]]*)\]", open(os.path.join(LABDIR, 'te-corpus-env.mjs'), encoding='ascii').read())
allowed = set(re.findall(r"'([^']+)'", allow.group(1))) if allow else set()
page_set = seen | {'phase10-corpus.html'}
if allowed != page_set:
    bad.append(f'te-corpus-env.mjs LAB_FILES differs from the files the page loads: missing {sorted(page_set - allowed)}, extra {sorted(allowed - page_set)}')
if imports_env != {'?v=2'}:
    bad.append(f'te-env.mjs must be imported as ?v=2 (the a3f9038 URL); found {sorted(imports_env)}')
print(f'{len(deploy)} Phase 10 deploy files, {len(req)} required files; the page loads {len(page_set)} lab files, all pinned; ledger allowlist {"matches" if allowed == page_set else "DIFFERS"}')
for b in bad:
    print('FAIL', b)
sys.exit(1 if bad else 0)
