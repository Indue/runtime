#!/usr/bin/env python3
"""Fails if any text file in the package contains a non-ASCII byte (NoblePDF rule: no
em dash U+2014, keep files ASCII). Binary fixtures and engines are skipped.
Usage: python3 tests/tools/check_ascii.py [ROOT]"""
import os, sys
root = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', '..'))
SKIP_DIRS = {'node_modules', '.engine', '.git', '__pycache__'}
BINARY = {'.pdf', '.wasm', '.zip', '.png', '.ttf', '.otf', '.pyc'}
bad = 0
count = 0
for d, dirs, files in os.walk(root):
    dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
    for f in files:
        p = os.path.join(d, f)
        if os.path.splitext(f)[1].lower() in BINARY:
            continue
        count += 1
        data = open(p, 'rb').read()
        if all(b < 0x80 for b in data):
            continue
        text = data.decode('utf-8', 'replace')
        for n, line in enumerate(text.splitlines(), 1):
            if any(ord(c) > 0x7f for c in line):
                bad += 1
                what = 'EM DASH' if '\u2014' in line else 'non-ASCII'
                print(f'{what}: {os.path.relpath(p, root)}:{n}: {line.encode("ascii", "backslashreplace").decode()[:160]}')
                break
print(f'checked {count} text files, {bad} with non-ASCII content')
sys.exit(1 if bad else 0)
