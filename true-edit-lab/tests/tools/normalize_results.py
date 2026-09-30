#!/usr/bin/env python3
"""Rewrites tests/results/* so they are ASCII: JSON with \\uXXXX escapes, logs with
\\u{XXXX} escapes. Test output legitimately contains Greek and astral test strings."""
import json, os, sys
d = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'results')
for f in sorted(os.listdir(d)):
    p = os.path.join(d, f)
    raw = open(p, 'rb').read()
    if all(b < 0x80 for b in raw):
        continue
    text = raw.decode('utf-8')
    if f.endswith('.json'):
        out = json.dumps(json.loads(text), indent=1, ensure_ascii=True)
    else:
        out = ''.join(c if ord(c) < 0x80 else '\\u{%X}' % ord(c) for c in text)
    open(p, 'w', encoding='ascii').write(out + ('' if out.endswith('\n') else '\n'))
    print('normalized', f)
