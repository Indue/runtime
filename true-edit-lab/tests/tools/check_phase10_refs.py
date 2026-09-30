#!/usr/bin/env python3
"""Pre-deploy checks for the Phase 10 page:
  - every Phase 10 deploy file and required lab file uses an extension the live host serves
    (the host answers 403 to every *.json URL; .png is used only by the pinned favicon);
  - every same-origin file the page loads (HTML src/href, and the static import closure of its
    module graph) is either a Phase 10 deploy file or a pinned required file;
  - the exact URL policy in te-corpus-env.mjs (LAB_QUERIES) lists exactly those files, each
    with exactly the one query string the page uses for it (no file loaded with two queries,
    no policy entry the page does not load), so the network ledger neither misses a request
    the page makes nor accepts a query it does not make;
  - the engine query policy (?te=patched-<12 hex>) matches what te-engine.mjs builds from the
    page's label and 6-byte nonce;
  - Phase 10 imports te-env.mjs with the same URL (?v=2) as the frozen Phase 9 pages;
  - Phase 10 is self-contained for its styles: the page loads exactly phase10-base.css?v=1,
    phase9.css?v=1 and phase10.css?v=1, in that order, and phase8.css appears nowhere in the
    page, its module graph, the URL policy or either Phase 10 list (the live phase8.css is not
    the a3f9038 build; phase10-base.css is its frozen copy, checked by build_phase10_package.py);
  - every Phase 10 deploy file is a Phase 10-owned name (phase10.css, phase10-*, te-corpus*.mjs)
    and no Phase 9 list names it.
Usage: python3 tests/tools/check_phase10_refs.py"""
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
LABDIR = os.path.join(ROOT, 'public_html', 'app.noblepdf.com', 'lab', 'true-text-edit')
# .png: the pinned phase10-favicon.png only. Unlike .json/.txt/.pdf it was not probed on the
# live host on 2026-09-30; README-PHASE10-LAB.txt has a post-deploy check for it.
SERVED = {'.html', '.js', '.mjs', '.css', '.pdf', '.txt', '.png'}
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
for rel, h in list(deploy.items()) + list(req.items()):
    if h == 'ANY':
        bad.append(f'{rel}: pinned as ANY (Phase 10 requires an exact SHA-256)')
for rel in list(deploy) + [r for r in req if r.startswith('lab/')]:
    ext = os.path.splitext(rel)[1].lower()
    if ext not in SERVED:
        bad.append(f'{rel}: extension not served by the live host')
    if ext == '.png' and rel != 'lab/true-text-edit/phase10-favicon.png':
        bad.append(f'{rel}: .png is accepted only for the pinned favicon')
pinned = {r.split('/')[-1] for r in list(deploy) + list(req) if r.startswith('lab/true-text-edit/')}
html = open(os.path.join(LABDIR, 'phase10-corpus.html'), encoding='ascii').read()
used = {}  # file -> set of query strings the page uses for it


def use(name, query):
    used.setdefault(name, set()).add(query or '')


for m in re.finditer(r'(?:src|href)="([^"]+)"', html):
    u = m.group(1)
    if u.startswith('/vendor/'):
        if u.lstrip('/') not in req:
            bad.append(f'html loads {u}, which is not pinned')
        if '?' in u or '#' in u:
            bad.append(f'html loads {u} with a query or fragment (vendor files carry none)')
        continue
    path, _, q = u.partition('?')
    use(path, '?' + q if q else '')
sheets = re.findall(r'<link rel="stylesheet" href="([^"]+)"', html)
if sheets != ['phase10-base.css?v=1', 'phase9.css?v=1', 'phase10.css?v=1']:
    bad.append(f'the page must load exactly phase10-base.css?v=1, phase9.css?v=1, phase10.css?v=1 in that order (found {sheets})')
icons = re.findall(r'<link rel="icon"[^>]*href="([^"]+)"', html)
if icons != ['phase10-favicon.png?v=1']:
    bad.append(f'the page must declare exactly one icon, phase10-favicon.png?v=1 (found {icons})')
todo = [f for f in used if f.endswith('.js') or f.endswith('.mjs')]
env_imports = set()
while todo:
    f = todo.pop()
    src = open(os.path.join(LABDIR, f), encoding='ascii').read()
    for m in re.finditer(r"(?:import|export)[^'\"]*?from\s+'\./([^'?]+)(\?v=\d+)?'", src):
        name, q = m.group(1), m.group(2) or ''
        if name == 'te-env.mjs':
            env_imports.add(q)
        first = name not in used
        use(name, q)
        if first:
            todo.append(name)
for f in sorted(used):
    if f not in pinned:
        bad.append(f'the page loads {f}, which is neither a Phase 10 deploy file nor a pinned required file')
    if len(used[f]) != 1:
        bad.append(f'{f} is loaded with more than one query {sorted(used[f])}')
envsrc = open(os.path.join(LABDIR, 'te-corpus-env.mjs'), encoding='ascii').read()
block = re.search(r"export const LAB_QUERIES = Object\.freeze\(\{([^}]*)\}\);", envsrc)
policy = dict(re.findall(r"'([^']+)': '([^']*)'", block.group(1))) if block else {}
actual = {f: next(iter(q)) for f, q in used.items() if len(q) == 1}
if policy != actual:
    missing = sorted(set(actual) - set(policy))
    extra = sorted(set(policy) - set(actual))
    differ = sorted(f for f in set(policy) & set(actual) if policy[f] != actual[f])
    bad.append(f'LAB_QUERIES differs from what the page loads: missing {missing}, extra {extra}, different query {differ}')
for f, q in policy.items():
    if not re.fullmatch(r'\?v=\d+', q):
        bad.append(f'LAB_QUERIES {f}: {q!r} is not an exact ?v=N cache version')
if 'export const ENGINE_QUERY = /^\\?te=patched-[0-9a-f]{12}$/;' not in envsrc:
    bad.append('ENGINE_QUERY is not exactly /^\\?te=patched-[0-9a-f]{12}$/')
eng = open(os.path.join(LABDIR, 'te-engine.mjs'), encoding='ascii').read()
page = open(os.path.join(LABDIR, 'phase10-corpus.js'), encoding='ascii').read()
if 'const tag = `${label}-${nonce}`;' not in eng or 'pdfium.wasm?te=${tag}' not in eng or 'index.js?te=${tag}' not in eng:
    bad.append('te-engine.mjs no longer builds engine URLs as ?te=<label>-<nonce>')
if "label: 'patched'" not in page or 'crypto.getRandomValues(new Uint8Array(6))' not in page or ".toString(16).padStart(2, '0')" not in page:
    bad.append('phase10-corpus.js no longer loads the engine as label patched with a 6-byte hex nonce')
if env_imports != {'?v=2'}:
    bad.append(f'te-env.mjs must be imported as ?v=2 (the a3f9038 URL); found {sorted(env_imports)}')
if 'phase8.css' in html or 'phase8.css' in used or 'phase8.css' in policy or any(r.endswith('/phase8.css') for r in list(deploy) + list(req)):
    bad.append('phase8.css is referenced by the Phase 10 page, its module graph, the URL policy or a Phase 10 list')
for f in used:
    if f.endswith('.js') or f.endswith('.mjs') or f.endswith('.css'):
        if 'phase8.css' in open(os.path.join(LABDIR, f), encoding='ascii').read():
            bad.append(f'{f} references phase8.css')
phase9_listed = set()
for name in ('deploy-files.txt', 'required-unchanged.txt'):
    lp = os.path.join(ROOT, 'deploy', name)
    if os.path.isfile(lp):
        phase9_listed |= set(read_list(name))
for rel in deploy:
    base = rel[len('lab/true-text-edit/'):] if rel.startswith('lab/true-text-edit/') else ''
    if '/' in base or not (base == 'phase10.css' or base.startswith('phase10-') or base in ('te-corpus.mjs', 'te-corpus-env.mjs')):
        bad.append(f'{rel}: not a Phase 10-owned name; Phase 10 deploys only files it owns')
    if rel in phase9_listed:
        bad.append(f'{rel}: a Phase 9 list names it; Phase 10 must not deploy a Phase 9 file')
print(f'{len(deploy)} Phase 10 deploy files, {len(req)} required files (no ANY); the page loads {len(used)} lab files, each with one exact query, all pinned; URL policy {"matches" if policy == actual else "DIFFERS"}')
for b in bad:
    print('FAIL', b)
sys.exit(1 if bad else 0)
