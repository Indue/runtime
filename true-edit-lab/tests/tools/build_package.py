#!/usr/bin/env python3
"""Builds the lab deploy package from this source tree.

  python3 tests/tools/build_package.py --lists-only   writes deploy/deploy-files.txt and
                                                      deploy/required-unchanged.txt
  python3 tests/tools/build_package.py OUT_DIR        also assembles OUT_DIR/<release>/,
                                                      MANIFEST.sha256 and OUT_DIR/<release>.zip

Only NEW or CHANGED lab files are deployed (Phase 8 V2.1.1 + Phase 9). Files that the
lab needs but that are already live are listed in required-unchanged.txt with their
pinned SHA-256; the deploy script only reads them."""
import hashlib
import os
import shutil
import sys
import zipfile

RELEASE = 'noblepdf-trueedit-phase9-lab-v3'
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
APP = os.path.join(ROOT, 'public_html', 'app.noblepdf.com')
LAB = 'lab/true-text-edit/'
MODULES = ['te-data.mjs', 'te-ttf.mjs', 'te-pdf.mjs', 'te-edit.mjs', 'te-engine.mjs', 'te-pipeline.mjs', 'te-suite.mjs', 'te-render.mjs', 'te-env.mjs']
SCRIPTS = ['phase9.css', 'phase9-suite.js', 'phase9-editor.js', 'phase8-v2.js']
HTML = ['phase9-suite.html', 'phase9-editor.html', 'phase8-v2.html']
REQUIRED = [
    ('2af28659a83b5691ed1193bd0819a6a1339036fb08505826d561c7541762baf2', 'vendor/pdfium-2.15.1-setpositions/index.js'),
    ('c4f54bda9bc730c0aeb6579254f0431fa95886478cd19967555be6ea2a35ce11', 'vendor/pdfium-2.15.1-setpositions/pdfium.wasm'),
    ('0e31ce6c207b371384392242c560b5e88d90221843dfbbaebf3f5cff1e22f2e0', 'vendor/pdfium-2.15.1/index.js'),
    ('5e4cd023c3dad4a895b3571ca573d3fc51bac6de48360d95283134385b954eaa', 'vendor/pdfium-2.15.1/pdfium.wasm'),
    ('5b5799e6f8c680663207ac5b42ee14eed2a406fa7af48f50c154f0c0b1566946', 'vendor/pdfjs-3.11.174/pdf.min.js'),
    ('feabdf309770ed24bba31a5467836cdc8cf639c705af27d52b585b041bb8527b', 'vendor/pdfjs-3.11.174/pdf.worker.min.js'),
    ('67721e5d2862fdaae76c51fadc19951e9922586cdd71d97a8736578f77dc35d5', LAB + 'phase8-verify.mjs'),
    ('8dd27a70889f0bce12c076bb7bbc8073807ffd6a00f6a0f83b01331b12c71a7d', LAB + 'phase8-csp-guard.js'),
    ('01476e596e146ec3cbe62516ed51333bfa4c7fb02ef288e8c7e8b84cb931ce9a', LAB + 'phase8-layout.mjs'),
    ('12f6055ccf4221a931cb4b8e48a16ba9150a782b229b6ee76adec3e16acab305', LAB + 'fixtures-phase8/pure-tj-before.pdf'),
    ('17202332e5b3531f568ea5166fe687368bca9dc5ef732d305876c3a4ed8882f9', LAB + 'fixtures-phase8/pure-tj-reference.pdf'),
    ('ANY', LAB + 'phase8.css'),
]


def sha(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()


def deploy_files():
    fx = sorted(os.listdir(os.path.join(APP, LAB, 'fixtures-phase9')))
    fx = [f for f in fx if f != 'manifest.json'] + ['manifest.json']
    rels = [LAB + 'fixtures-phase9/' + f for f in fx] + [LAB + m for m in MODULES] + [LAB + s for s in SCRIPTS] + [LAB + h for h in HTML]
    for r in rels:
        if not os.path.isfile(os.path.join(APP, r)):
            sys.exit('missing ' + r)
    return rels


def write_lists():
    rels = deploy_files()
    with open(os.path.join(ROOT, 'deploy', 'deploy-files.txt'), 'w', encoding='ascii', newline='\n') as f:
        for r in rels:
            f.write(f'{sha(os.path.join(APP, r))} {r}\n')
    with open(os.path.join(ROOT, 'deploy', 'required-unchanged.txt'), 'w', encoding='ascii', newline='\n') as f:
        for h, r in REQUIRED:
            if h != 'ANY' and os.path.isfile(os.path.join(APP, r)) and sha(os.path.join(APP, r)) != h:
                sys.exit(f'source tree copy of {r} does not match its pin')
            f.write(f'{h} {r}\n')
    print(f'deploy-files.txt: {len(rels)} files; required-unchanged.txt: {len(REQUIRED)} files')
    return rels


def copy_tree(src, dst, skip_dirs=('node_modules', '.engine', '__pycache__', '.git')):
    for d, dirs, files in os.walk(src):
        dirs[:] = sorted(x for x in dirs if x not in skip_dirs)
        for f in sorted(files):
            if f.endswith('.pyc'):
                continue
            s = os.path.join(d, f)
            t = os.path.join(dst, os.path.relpath(s, src))
            os.makedirs(os.path.dirname(t), exist_ok=True)
            shutil.copy2(s, t)


def build(out):
    rels = write_lists()
    pkg = os.path.join(out, RELEASE)
    if os.path.exists(pkg):
        shutil.rmtree(pkg)
    os.makedirs(pkg)
    for r in rels:
        t = os.path.join(pkg, 'public_html', 'app.noblepdf.com', r)
        os.makedirs(os.path.dirname(t), exist_ok=True)
        shutil.copy2(os.path.join(APP, r), t)
    copy_tree(os.path.join(ROOT, 'deploy'), os.path.join(pkg, 'deploy'))
    copy_tree(os.path.join(ROOT, 'tests'), os.path.join(pkg, 'tests'))
    copy_tree(os.path.join(ROOT, '.github'), os.path.join(pkg, '.github'))
    for doc in ('README-PHASE9-LAB.txt', 'AUDIT-REPORT-PHASE9.md', 'AUDIT-REPORT-PHASE9.template.md'):
        shutil.copy2(os.path.join(ROOT, doc), os.path.join(pkg, doc))
    # Files the lab needs that are already live: shipped in the same tree so tests, CI and
    # the local harness run from the package, but NOT listed in deploy-files.txt. The deploy
    # script only verifies the live copies against required-unchanged.txt.
    for r in (LAB + 'phase8-layout.mjs', LAB + 'phase8-verify.mjs', LAB + 'phase8-csp-guard.js', LAB + 'phase8.css', LAB + 'fixtures-phase8/pure-tj-before.pdf', LAB + 'fixtures-phase8/pure-tj-reference.pdf'):
        t = os.path.join(pkg, 'public_html', 'app.noblepdf.com', r)
        os.makedirs(os.path.dirname(t), exist_ok=True)
        shutil.copy2(os.path.join(APP, r), t)
    lines = []
    for d, dirs, files in os.walk(pkg):
        dirs.sort()
        for f in sorted(files):
            p = os.path.join(d, f)
            rel = os.path.relpath(p, pkg).replace(os.sep, '/')
            if rel == 'MANIFEST.sha256':
                continue
            lines.append(f'{sha(p)}  {rel}')
    with open(os.path.join(pkg, 'MANIFEST.sha256'), 'w', encoding='ascii', newline='\n') as f:
        f.write('\n'.join(lines) + '\n')
    zp = os.path.join(out, RELEASE + '.zip')
    if os.path.exists(zp):
        os.remove(zp)
    with zipfile.ZipFile(zp, 'w', zipfile.ZIP_DEFLATED) as z:
        for d, dirs, files in os.walk(pkg):
            dirs.sort()
            for f in sorted(files):
                p = os.path.join(d, f)
                z.write(p, os.path.join(RELEASE, os.path.relpath(p, pkg)))
    print(f'package {pkg} ({len(lines) + 1} files); zip {zp} ({os.path.getsize(zp)} bytes) sha256 {sha(zp)}')


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--lists-only':
        write_lists()
    elif len(sys.argv) > 1:
        build(os.path.abspath(sys.argv[1]))
    else:
        sys.exit(__doc__)
