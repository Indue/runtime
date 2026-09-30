#!/usr/bin/env python3
"""Fills the generated sections of AUDIT-REPORT-PHASE9.md from the fixture manifest and
tests/results/*.json (so the acceptance matrix always matches the recorded runs).
Usage: python3 tests/tools/render_report.py   (reads AUDIT-REPORT-PHASE9.template.md)"""
import json
import os
import re

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
RES = os.path.join(ROOT, 'tests', 'results')
LAB = os.path.join(ROOT, 'public_html', 'app.noblepdf.com', 'lab', 'true-text-edit')
manifest = json.load(open(os.path.join(LAB, 'fixtures-phase9', 'manifest.txt')))
load = lambda n: json.load(open(os.path.join(RES, n)))
suites = {v: {r['id']: r for r in load(f'node-suite-pdfjs{v}.json')['rows']} for v in (3, 4, 6)}
browser = {r['id']: r for r in load('phase9-browser-results.json')}
s01 = browser.get('S01', {}).get('report', '')
chrome = {}
for line in s01.splitlines():
    m = re.match(r'^(PASS|FAIL)\s+(\S+)\s+expected', line)
    if m:
        renders = re.findall(r'(X0\d) (\d+) of \d+ pixels differ', line)
        chrome[m.group(2)] = (m.group(1), ', '.join(f'{x} {n} px' for x, n in renders))


def node_cell(fid):
    return '/'.join('PASS' if suites[v].get(fid, {}).get('ok') else 'FAIL' for v in (3, 4, 6))


def supported():
    out = ['| Fixture | Covers | SetPositions discriminating | Node PDF.js 3 / 4 / 6 | Chromium suite | Renders differing (vs original outside edit, vs reference) |', '|---|---|---|---|---|---|']
    for f in manifest['fixtures']:
        if f['expect']['status'] != 'committed':
            continue
        e = f['expect']
        disc = f"yes ({e['naturalDelta']:.2f} pt)" if e.get('discriminating') else 'no (by design)'
        c = chrome.get(f['id'], ('not run', ''))
        out.append(f"| {f['id']} | {', '.join(f.get('covers', []))} | {disc} | {node_cell(f['id'])} | {c[0]} | {c[1]} |")
    return '\n'.join(out)


def blocked():
    out = ['| Fixture | Expected outcome | Required reason(s) | Observed reasons (PDF.js 3 run) | Node PDF.js 3 / 4 / 6 | Chromium suite |', '|---|---|---|---|---|---|']
    for f in manifest['fixtures']:
        if f['expect']['status'] == 'committed':
            continue
        r = suites[3].get(f['id'], {})
        obs = ', '.join(sorted(set(r.get('reasons', []))))
        c = chrome.get(f['id'], ('not run', ''))
        out.append(f"| {f['id']} | {f['expect']['status']} | {', '.join(f['expect']['reasons'])} | {obs} | {node_cell(f['id'])} | {c[0]} |")
    return '\n'.join(out)


def faults():
    out = ['| Class | Fault | Discriminating fixtures (counted) | Rejected | Not discriminating (not counted) | Caught by | Result |', '|---|---|---|---|---|---|---|']
    for r in load('faults.json'):
        ok = not r['acceptedBad'] and r['evidence'] > 0
        out.append(f"| {r['id']} | {r['name']} | {r['evidence']} | {r['rejected']} | {r['nonDiscriminating']} | {', '.join(r.get('caughtBy', [])) or 'n/a'} | {'PASS' if ok else 'FAIL'} |")
    return '\n'.join(out)


def thresholds():
    t = {v: {r['id']: r for r in load(f'thresholds-pdfjs{v}.json')['rows']} for v in (3, 4, 6)}
    out = ['| Text state | PDFium split at (+em / -em) | PDF.js 3.11.174 (+ / -) | PDF.js 4.10.38 | PDF.js 6.3.289 | Policy interval (em) | Old lint accepted | Verdict |', '|---|---|---|---|---|---|---|---|']
    for k, r in t[3].items():
        pj = lambda v: f"{t[v][k]['pdfjsPos']} / {t[v][k]['pdfjsNeg']}"
        verdict = 'informational (pre-regeneration form)' if r['safe'] is None else ('safe' if all(t[v][k]['safe'] for v in (3, 4, 6)) else 'UNSAFE')
        old = f"[{r['legacyAccepts']['lo']}, {r['legacyAccepts']['hi']}]" + (' UNSAFE' if r['legacyUnsafe'] else '')
        out.append(f"| {k} | {r['pdfiumPos']} / {r['pdfiumNeg'] if r['pdfiumNeg'] is not None else 'none down to -1'} | {pj(3)} | {pj(4)} | {pj(6)} | [{r['policy']['lo']}, {r['policy']['hi']}] | {old} | {verdict} |")
    return '\n'.join(out)


def browser_table():
    out = ['| Scenario | What it checks | Result |', '|---|---|---|']
    for k, r in browser.items():
        out.append(f"| {k} | {r['note']} | {'PASS' if r['verdict'] == 'OK' else 'FAIL'} |")
    return '\n'.join(out)


tpl = open(os.path.join(ROOT, 'AUDIT-REPORT-PHASE9.template.md'), encoding='ascii').read()
for key, fn in (('SUPPORTED', supported), ('BLOCKED', blocked), ('FAULTS', faults), ('THRESHOLDS', thresholds), ('BROWSER', browser_table)):
    tpl = tpl.replace(f'@@{key}@@', fn())
tpl = tpl.replace('@@MANIFEST_SHA@@', __import__('hashlib').sha256(open(os.path.join(LAB, 'fixtures-phase9', 'manifest.txt'), 'rb').read()).hexdigest())
out = tpl.encode('ascii', 'backslashreplace').decode('ascii')
open(os.path.join(ROOT, 'AUDIT-REPORT-PHASE9.md'), 'w', encoding='ascii', newline='\n').write(out)
print('wrote AUDIT-REPORT-PHASE9.md', len(out), 'chars')
