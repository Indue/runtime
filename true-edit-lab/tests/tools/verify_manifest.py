#!/usr/bin/env python3
"""Checks fixtures-phase9/manifest.txt against the files on disk and the pins in the
suite and editor pages. Usage: python3 tests/tools/verify_manifest.py"""
import hashlib, json, os, re, sys
here = os.path.dirname(os.path.abspath(__file__))
lab = os.path.join(here, '..', '..', 'public_html', 'app.noblepdf.com', 'lab', 'true-text-edit')
fx = os.path.join(lab, 'fixtures-phase9')
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
m = json.load(open(os.path.join(fx, 'manifest.txt')))
bad = []
listed = {'manifest.txt'}
for f in m['fixtures']:
    for k in ('before', 'reference'):
        name = f.get(k)
        if not name:
            continue
        listed.add(name)
        if sha(os.path.join(fx, name)) != f['sha256'][k]:
            bad.append(f'{f["id"]}: {name} hash mismatch')
extra = sorted(set(os.listdir(fx)) - listed)
if extra:
    bad.append('files not in the manifest: ' + ', '.join(extra))
msha = sha(os.path.join(fx, 'manifest.txt'))
for page in ('phase9-suite.js', 'phase9-editor.js'):
    s = open(os.path.join(lab, page), encoding='ascii').read()
    pins = re.findall(r"manifest\.txt\?v=1', sha256: '([0-9a-f]{64})'", s)
    if pins != [msha]:
        bad.append(f'{page}: manifest pin {pins} != {msha}')
n = len(m['fixtures'])
sup = sum(1 for f in m['fixtures'] if f['expect']['status'] == 'committed')
print(f'{n} fixtures ({sup} supported with references, {n - sup} blocked/rejected); manifest {msha}')
for b in bad:
    print('FAIL', b)
sys.exit(1 if bad else 0)
