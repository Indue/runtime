#!/usr/bin/env python3
"""Builds the Phase 10 corpus-harness deploy lists and package from this source tree.

  python3 tests/tools/build_phase10_package.py --lists-only   writes deploy/phase10-deploy-files.txt
                                                              and deploy/phase10-required-unchanged.txt
  python3 tests/tools/build_phase10_package.py --check        fails if the committed lists differ
                                                              from the tree (CI)
  python3 tests/tools/build_phase10_package.py OUT_DIR        also assembles OUT_DIR/<release>/,
                                                              its MANIFEST.sha256 and OUT_DIR/<release>.zip

Only the six NEW Phase 10 files are deployed. Everything they build on is already live and
listed in phase10-required-unchanged.txt with its pinned SHA-256: the Phase 9 lab modules
exactly as frozen at a3f9038 (taken from the Phase 9 deploy-files.txt and required-unchanged.txt,
so te-env.mjs must be the te-env-2 network-audit fix), the Run #10 engine and PDF.js 3.11.174.
The deploy script only reads (hash-checks) those. The Phase 9 package files are not changed."""
import hashlib
import os
import shutil
import sys
import zipfile

RELEASE = 'noblepdf-trueedit-phase10-corpus-lab-v1'
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
APP = os.path.join(ROOT, 'public_html', 'app.noblepdf.com')
LAB = 'lab/true-text-edit/'
# Deploy order: modules and scripts first, the page last.
PHASE10 = ['te-corpus.mjs', 'te-corpus-env.mjs', 'phase10.css', 'phase10-net-guard.js', 'phase10-corpus.js', 'phase10-corpus.html']
# Phase 9 lab files the Phase 10 page loads (pins come from the frozen Phase 9 lists).
PHASE9_DEPS = ['te-data.mjs', 'te-ttf.mjs', 'te-pdf.mjs', 'te-edit.mjs', 'te-engine.mjs', 'te-pipeline.mjs', 'te-render.mjs', 'te-env.mjs', 'phase9.css',
               'phase8-verify.mjs', 'phase8-csp-guard.js', 'phase8.css']
VENDOR = ['vendor/pdfium-2.15.1-setpositions/index.js', 'vendor/pdfium-2.15.1-setpositions/pdfium.wasm', 'vendor/pdfjs-3.11.174/pdf.min.js', 'vendor/pdfjs-3.11.174/pdf.worker.min.js']


def sha(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()


def phase9_pins():
    pins = {}
    for name in ('deploy-files.txt', 'required-unchanged.txt'):
        for line in open(os.path.join(ROOT, 'deploy', name), encoding='ascii'):
            if line.strip():
                h, rel = line.split()
                pins[rel] = h
    return pins


def lists():
    deploy = []
    for f in PHASE10:
        p = os.path.join(APP, LAB + f)
        if not os.path.isfile(p):
            sys.exit('missing ' + LAB + f)
        deploy.append(f'{sha(p)} {LAB}{f}\n')
    pins = phase9_pins()
    req = []
    for rel in [LAB + f for f in PHASE9_DEPS] + VENDOR:
        if rel not in pins:
            sys.exit(f'{rel} is not pinned by the Phase 9 lists')
        h = pins[rel]
        if h != 'ANY' and os.path.isfile(os.path.join(APP, rel)) and sha(os.path.join(APP, rel)) != h:
            sys.exit(f'{rel} in the source tree differs from its Phase 9 pin: Phase 9 files must stay frozen')
        req.append(f'{h} {rel}\n')
    return ''.join(deploy), ''.join(req)


def write_lists():
    d, r = lists()
    open(os.path.join(ROOT, 'deploy', 'phase10-deploy-files.txt'), 'w', encoding='ascii', newline='\n').write(d)
    open(os.path.join(ROOT, 'deploy', 'phase10-required-unchanged.txt'), 'w', encoding='ascii', newline='\n').write(r)
    print(f'phase10-deploy-files.txt: {d.count(chr(10))} files; phase10-required-unchanged.txt: {r.count(chr(10))} files')


def check_lists():
    d, r = lists()
    bad = []
    for name, want in (('phase10-deploy-files.txt', d), ('phase10-required-unchanged.txt', r)):
        p = os.path.join(ROOT, 'deploy', name)
        if not os.path.isfile(p) or open(p, encoding='ascii').read() != want:
            bad.append(f'deploy/{name} is out of date (run build_phase10_package.py --lists-only)')
    for b in bad:
        print('FAIL', b)
    print(f'{d.count(chr(10))} Phase 10 deploy files and {r.count(chr(10))} required files {"match" if not bad else "DO NOT match"} the committed lists')
    return not bad


def copy_tree(src, dst, skip=('node_modules', '.engine', '__pycache__', '.git', 'results')):
    for dd, dirs, files in os.walk(src):
        dirs[:] = sorted(x for x in dirs if x not in skip)
        for f in sorted(files):
            if f.endswith('.pyc'):
                continue
            s = os.path.join(dd, f)
            t = os.path.join(dst, os.path.relpath(s, src))
            os.makedirs(os.path.dirname(t), exist_ok=True)
            shutil.copy2(s, t)


def build(out):
    write_lists()
    pkg = os.path.join(out, RELEASE)
    if os.path.exists(pkg):
        shutil.rmtree(pkg)
    os.makedirs(pkg)
    # The whole lab tree ships so the tests run from the package; only phase10-deploy-files.txt is deployed.
    copy_tree(os.path.join(ROOT, 'public_html'), os.path.join(pkg, 'public_html'))
    # The Phase 9 lists ship for reference only (the required pins are derived from them).
    for f in ('phase10-lab-deploy.sh', 'phase10-lab-rollback.sh', 'phase10-deploy-files.txt', 'phase10-required-unchanged.txt', 'deploy-files.txt', 'required-unchanged.txt'):
        os.makedirs(os.path.join(pkg, 'deploy'), exist_ok=True)
        shutil.copy2(os.path.join(ROOT, 'deploy', f), os.path.join(pkg, 'deploy', f))
    copy_tree(os.path.join(ROOT, 'tests'), os.path.join(pkg, 'tests'))
    for doc in ('README-PHASE10-LAB.txt', 'AUDIT-REPORT-PHASE10.md'):
        shutil.copy2(os.path.join(ROOT, doc), os.path.join(pkg, doc))
    lines = []
    for dd, dirs, files in os.walk(pkg):
        dirs.sort()
        for f in sorted(files):
            p = os.path.join(dd, f)
            rel = os.path.relpath(p, pkg).replace(os.sep, '/')
            if rel != 'MANIFEST.sha256':
                lines.append(f'{sha(p)}  {rel}')
    open(os.path.join(pkg, 'MANIFEST.sha256'), 'w', encoding='ascii', newline='\n').write('\n'.join(lines) + '\n')
    zp = os.path.join(out, RELEASE + '.zip')
    if os.path.exists(zp):
        os.remove(zp)
    with zipfile.ZipFile(zp, 'w', zipfile.ZIP_DEFLATED) as z:
        for dd, dirs, files in os.walk(pkg):
            dirs.sort()
            for f in sorted(files):
                p = os.path.join(dd, f)
                z.write(p, os.path.join(RELEASE, os.path.relpath(p, pkg)))
    print(f'package {pkg} ({len(lines) + 1} files); zip {zp} ({os.path.getsize(zp)} bytes) sha256 {sha(zp)}')


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--lists-only':
        write_lists()
    elif len(sys.argv) > 1 and sys.argv[1] == '--check':
        sys.exit(0 if check_lists() else 1)
    elif len(sys.argv) > 1:
        build(os.path.abspath(sys.argv[1]))
    else:
        sys.exit(__doc__)
