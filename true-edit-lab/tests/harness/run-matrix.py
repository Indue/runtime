#!/usr/bin/env python3
"""HARNESS ONLY. Headless-Chromium test matrix for the Phase 8 V1 and V2 lab pages.

Starts tests/harness/server.mjs, then for every scenario configures the fake engine
and injection mode, opens the page in a fresh browser context, clicks preflight and
(if ready) the proof, and compares the observed gate results with expectations.

Usage (from the package root):
  V1_LAB_DIR=/path/to/v1/lab/true-text-edit PDFJS_DIR=... PDFIUM_DIR=... \
    python3 tests/harness/run-matrix.py [SCENARIO_ID ...]
Writes tests/results/harness-results.json and tests/results/harness-results.txt.
"""
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.abspath(os.path.join(HERE, '..', '..'))
RESULTS = os.path.join(PKG, 'tests', 'results')
PORT = int(os.environ.get('PORT', '8765'))
BASE = f'http://localhost:{PORT}'
V1_PAGE = '/lab/true-text-edit/phase8.html'
V2_PAGE = '/lab/true-text-edit/phase8-v2.html'

# expect keys: ready (YES/NO), pre_fail (exact set of failed preflight ids when not ready),
# pre_fail_includes, decision (PASS/BLOCK), fail (exact set), fail_includes, min_warn, v1_decision
SCENARIOS = [
    dict(id='H01', page='v1', engine='noop', note='V1 with SetPositions as a silent no-op (finding F1)', expect=dict(v1_decision='PHASE 8 LIVE PASS')),
    dict(id='H02', page='v1', engine='fallback', note='V1 when the engine glue ignores the supplied wasm and fetches its own', expect={}),
    dict(id='H03', page='v1', engine='neighbourshift', note='V1 with the neighbour line moved by 0.02 pt', expect={}),
    dict(id='H04', page='v1', engine='orphan', note='V1 with the old content stream left as an unreferenced object', expect={}),
    dict(id='H05', page='v1', engine='emulated', inject='before', note='V1 with a cross-origin script injected before the CSP meta', expect={}),
    dict(id='H06', page='v1', engine='emulated', inject='after', note='V1 with host-style scripts after the CSP meta (blocked by CSP)', expect={}),
    dict(id='H10', page='v2', engine='emulated', subst='0', note='V2 with the real Run #10 hashes against a fake engine', expect=dict(ready='NO', pre_fail={'P05', 'P06', 'P07', 'P08'})),
    dict(id='H11', page='v2', engine='emulated', subst='1', note='V2 against an emulated working patch (harness hashes substituted), proof run twice', repeat=2, expect=dict(ready='YES', decision='PASS', fail=set())),
    dict(id='H12', page='v2', engine='noop', subst='1', note='V2 with SetPositions as a silent no-op', expect=dict(ready='YES', decision='BLOCK', fail={'L02', 'L03', 'L04', 'L05'})),
    dict(id='H13', page='v2', engine='incremental', subst='1', note='V2 with an incremental append save', expect=dict(ready='YES', decision='BLOCK', fail={'L06', 'A13', 'A14'})),
    dict(id='H14', page='v2', engine='orphan', subst='1', note='V2 with an unreferenced old content stream', expect=dict(ready='YES', decision='BLOCK', fail={'L06', 'A14'})),
    dict(id='H15', page='v2', engine='hiddenold', subst='1', note='V2 with invisible old text kept under the new text', expect=dict(ready='YES', decision='BLOCK', fail_includes={'A05', 'A08', 'A14'})),
    dict(id='H16', page='v2', engine='overlay', subst='1', note='V2 with a hidden image overlay object', expect=dict(ready='YES', decision='BLOCK', fail={'A08', 'A14'})),
    dict(id='H17', page='v2', engine='neighbourshift', subst='1', note='V2 with the neighbour line moved by 0.02 pt', expect=dict(ready='YES', decision='BLOCK', fail_includes={'A07'})),
    dict(id='H18', page='v2', engine='glyphdrift', subst='1', note='V2 with one glyph misplaced by 0.05 pt', expect=dict(ready='YES', decision='BLOCK', fail_includes={'A06', 'L02'})),
    dict(id='H19', page='v2', engine='fallback', subst='1', note='V2 when the engine glue ignores the verified bytes', expect=dict(ready='NO', pre_fail={'P07'})),
    dict(id='H20', page='v2', engine='emulated', subst='1', inject='after', note='V2 with host-style cross-origin and inline scripts after the CSP meta', expect=dict(ready='YES', decision='PASS', fail=set(), min_warn=2)),
    dict(id='H21', page='v2', engine='emulated', subst='1', inject='before', note='V2 with a cross-origin script injected before the CSP meta', expect=dict(ready='NO', pre_fail_includes={'P10'})),
    dict(id='H22', page='v2', engine='emulated', subst='1', pdfjs='badversion', note='V2 with a PDF.js build reporting a different version', expect=dict(ready='NO', pre_fail_includes={'P02'})),
    dict(id='H23', page='v2', engine='real', subst='0', note='V2.1.1 with the REAL Run #10 engine (hash-verified copy) and the pinned stock engine', expect=dict(ready='YES', decision='PASS', fail=set())),
    dict(id='H24', page='v2', engine='real', subst='0', stock='unpinned', note='V2.1.1 when the stock glue differs from STOCK_PINNED', expect=dict(ready='NO', pre_fail_includes={'P09'})),
]


def http_get(path):
    with urllib.request.urlopen(BASE + path, timeout=10) as r:
        return json.loads(r.read().decode('utf-8'))


def start_server():
    env = dict(os.environ, PORT=str(PORT))
    proc = subprocess.Popen(['node', os.path.join(HERE, 'server.mjs')], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for _ in range(100):
        try:
            http_get('/__harness/info')
            return proc
        except Exception:
            if proc.poll() is not None:
                raise RuntimeError('harness server exited: ' + proc.stdout.read().decode('utf-8', 'replace'))
            time.sleep(0.2)
    raise RuntimeError('harness server did not start')


def table_rows(page):
    return page.eval_on_selector_all('#gatesBody tr', 'rows => rows.map(r => Array.from(r.cells).map(c => c.textContent))')


def run_scenario(browser, sc):
    params = dict(engine=sc['engine'], subst=sc.get('subst', '0'), inject=sc.get('inject', 'none'), pdfjs=sc.get('pdfjs', 'ok'), stock=sc.get('stock', 'pinned'))
    harness = http_get('/__harness/scenario?' + urllib.parse.urlencode(params))
    ctx = browser.new_context()
    page = ctx.new_page()
    console = []
    page.on('console', lambda m: console.append(f'{m.type}: {m.text}'[:300]))
    page.on('pageerror', lambda e: console.append(f'pageerror: {e}'[:300]))
    url = BASE + (V1_PAGE if sc['page'] == 'v1' else V2_PAGE)
    t0 = time.time()
    page.goto(url, wait_until='load')
    page.wait_for_timeout(400)
    page.click('#runPreflight')
    page.wait_for_function("() => !document.getElementById('runPreflight').disabled && !document.getElementById('preflightReport').textContent.startsWith('Running')", timeout=240000)
    out = dict(id=sc['id'], page=sc['page'], params=params, note=sc['note'], harness=harness)
    out['ready'] = page.inner_text('#readyStatus').strip()
    out['preflight_report'] = page.inner_text('#preflightReport')
    out['preflight_rows'] = table_rows(page) if sc['page'] == 'v2' else []
    if out['ready'] == 'YES':
        page.click('#runProof')
        page.wait_for_function("() => { const d = document.getElementById('decisionStatus').textContent.trim(); return d && d !== '-' && !document.getElementById('runProof').disabled; }", timeout=300000)
        out['decision'] = page.inner_text('#decisionStatus').strip()
        out['legacy_status'] = page.inner_text('#legacyStatus').strip()
        out['anchored_status'] = page.inner_text('#anchoredStatus').strip()
        out['rows'] = table_rows(page)
        out['report'] = page.inner_text('#verificationReport')
        for n in range(2, sc.get('repeat', 1) + 1):
            page.click('#runProof')
            page.wait_for_function("() => { const d = document.getElementById('decisionStatus').textContent.trim(); return d && d !== '-' && !document.getElementById('runProof').disabled; }", timeout=300000)
            out[f'decision_run{n}'] = page.inner_text('#decisionStatus').strip()
            out[f'failed_run{n}'] = sorted(failed_ids(table_rows(page)))
    page.wait_for_timeout(300)
    out['network'] = page.inner_text('#networkResults')
    out['privacy'] = page.inner_text('#privacyStatus')
    out['console'] = console[-40:]
    out['seconds'] = round(time.time() - t0, 1)
    ctx.close()
    return out


def failed_ids(rows):
    return {r[0] for r in rows if len(r) >= 5 and r[3].strip() == 'FAIL'}


def evaluate(sc, out):
    exp = sc['expect']
    problems = []
    if sc['page'] == 'v1':
        if 'v1_decision' in exp and out.get('decision') != exp['v1_decision']:
            problems.append(f"V1 decision {out.get('decision')!r} != {exp['v1_decision']!r}")
        return problems
    if 'ready' in exp and out['ready'] != exp['ready']:
        problems.append(f"ready {out['ready']} != {exp['ready']}")
    pre_failed = failed_ids(out['preflight_rows'])
    out['preflight_failed'] = sorted(pre_failed)
    if 'pre_fail' in exp and pre_failed != exp['pre_fail']:
        problems.append(f'preflight failed {sorted(pre_failed)} != {sorted(exp["pre_fail"])}')
    if 'pre_fail_includes' in exp and not exp['pre_fail_includes'] <= pre_failed:
        problems.append(f'preflight failed {sorted(pre_failed)} missing {sorted(exp["pre_fail_includes"] - pre_failed)}')
    if out['ready'] == 'YES':
        failed = failed_ids(out.get('rows', []))
        out['failed'] = sorted(failed)
        decision = 'PASS' if out.get('decision', '').startswith('PHASE 8 V2 PASS') else 'BLOCK'
        out['decision_class'] = decision
        if 'decision' in exp and decision != exp['decision']:
            problems.append(f"decision {decision} != {exp['decision']}")
        if 'fail' in exp and failed != exp['fail']:
            problems.append(f'failed {sorted(failed)} != {sorted(exp["fail"])}')
        for n in range(2, sc.get('repeat', 1) + 1):
            if out.get(f'decision_run{n}') != out.get('decision') or out.get(f'failed_run{n}') != sorted(failed):
                problems.append(f"run {n} differs: {out.get(f'decision_run{n}')!r} {out.get(f'failed_run{n}')}")
        if 'fail_includes' in exp and not exp['fail_includes'] <= failed:
            problems.append(f'failed {sorted(failed)} missing {sorted(exp["fail_includes"] - failed)}')
    if 'min_warn' in exp:
        warns = out['network'].count('WARN  ')
        if warns < exp['min_warn']:
            problems.append(f'warnings {warns} < {exp["min_warn"]}')
    return problems


def main():
    wanted = set(sys.argv[1:])
    scenarios = [s for s in SCENARIOS if not wanted or s['id'] in wanted]
    if not os.environ.get('V1_LAB_DIR'):
        skipped = [s['id'] for s in scenarios if s['page'] == 'v1']
        scenarios = [s for s in scenarios if s['page'] != 'v1']
        if skipped:
            print('SKIP (V1_LAB_DIR not set, V1 page not in this package): ' + ' '.join(skipped))
    os.makedirs(RESULTS, exist_ok=True)
    server = start_server()
    results = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            for sc in scenarios:
                try:
                    out = run_scenario(browser, sc)
                    out['problems'] = evaluate(sc, out)
                except Exception as e:  # a crash is a harness failure, never a pass
                    out = dict(id=sc['id'], page=sc['page'], note=sc['note'], problems=[f'harness error: {e}'])
                out['verdict'] = 'OK' if not out['problems'] else 'UNEXPECTED'
                results.append(out)
                print(f"{out['id']} {out['verdict']:10} {sc['page']} {sc['engine']:15} ready={out.get('ready')} decision={out.get('decision')!r} "
                      f"failed={out.get('failed', out.get('preflight_failed'))} {out.get('seconds')}s {'; '.join(out['problems'])}", flush=True)
            browser.close()
    finally:
        server.terminate()
    suffix = '' if not wanted else '-' + '-'.join(sorted(wanted))
    with open(os.path.join(RESULTS, f'harness-results{suffix}.json'), 'w', encoding='utf-8') as f:
        json.dump(results, f, indent=1, default=sorted)
    lines = []
    for r in results:
        lines.append(f"{r['id']} [{r['verdict']}] {r['page'].upper()} engine={r.get('params', {}).get('engine')} "
                     f"subst={r.get('params', {}).get('subst')} inject={r.get('params', {}).get('inject')} pdfjs={r.get('params', {}).get('pdfjs')}")
        lines.append(f"    {r['note']}")
        lines.append(f"    ready={r.get('ready')} decision={r.get('decision')!r} legacy={r.get('legacy_status')!r} anchored={r.get('anchored_status')!r}")
        if r['page'] == 'v2':
            lines.append(f"    preflight failed={r.get('preflight_failed')} proof failed={r.get('failed')}")
        else:
            v1rows = [f"{row[0]}: legacy={row[1][:40]!r} anchored={row[2][:60]!r}" for row in r.get('rows', [])]
            lines.extend('    ' + x for x in v1rows)
        if r['problems']:
            lines.append('    PROBLEMS: ' + '; '.join(r['problems']))
    with open(os.path.join(RESULTS, f'harness-results{suffix}.txt'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    bad = [r['id'] for r in results if r['verdict'] != 'OK']
    print('MATRIX', 'OK' if not bad else f'UNEXPECTED {bad}')
    return 0 if not bad else 1


if __name__ == '__main__':
    sys.exit(main())
