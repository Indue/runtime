#!/usr/bin/env python3
"""Pins the SHA-256 of fixtures-phase9/manifest.json into phase9-suite.js and
phase9-editor.js (replaces the placeholder or a previous pin). Run after every
fixture regeneration. Usage: python3 tests/tools/pin_manifest.py"""
import hashlib, os, re, sys
here = os.path.dirname(os.path.abspath(__file__))
lab = os.path.join(here, '..', '..', 'public_html', 'app.noblepdf.com', 'lab', 'true-text-edit')
sha = hashlib.sha256(open(os.path.join(lab, 'fixtures-phase9', 'manifest.json'), 'rb').read()).hexdigest()
pat = re.compile(r"(const MANIFEST = Object\.freeze\(\{ url: '\./fixtures-phase9/manifest\.json\?v=1', sha256: ')([0-9a-f]{64}|__MANIFEST_SHA256__)('\s*\}\);)")
for name in ('phase9-suite.js', 'phase9-editor.js'):
    p = os.path.join(lab, name)
    s = open(p, encoding='ascii').read()
    s2, n = pat.subn(lambda m: m.group(1) + sha + m.group(3), s)
    if n != 1:
        sys.exit('pin line not found exactly once in ' + name)
    open(p, 'w', encoding='ascii').write(s2)
    print('pinned', name, sha)
