#!/usr/bin/env python3
"""HARNESS ONLY. Headless-Chromium tests for the Phase 9 lab pages (suite and editor).

Starts tests/harness/server.mjs with the REAL Run #10 engine (REAL_PATCHED_DIR), opens
the pages in fresh browser contexts and drives them through the real UI: preflight,
suite run, clicks on the rendered page, typing, apply, undo, reset and download.
Every scenario has an explicit expectation; a crash is a failure, never a pass.

Usage (from the package root):
  V1_LAB_DIR=... PDFJS_DIR=... PDFIUM_DIR=... REAL_PATCHED_DIR=... \
    python3 tests/harness/run-phase9.py [SCENARIO_ID ...]
Writes tests/results/phase9-browser-results.json and .txt.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.abspath(os.path.join(HERE, '..', '..'))
RESULTS = os.path.join(PKG, 'tests', 'results')
PORT = int(os.environ.get('PORT', '8792'))
BASE = f'http://localhost:{PORT}'
SUITE = '/lab/true-text-edit/phase9-suite.html'
EDITOR = '/lab/true-text-edit/phase9-editor.html'
LAB_DIR = os.path.join(PKG, 'public_html', 'app.noblepdf.com', 'lab', 'true-text-edit')
MANIFEST_BYTES = open(os.path.join(LAB_DIR, 'fixtures-phase9', 'manifest.txt'), 'rb').read()
MANIFEST = json.loads(MANIFEST_BYTES.decode('utf-8'))
FX = {f['id']: f for f in MANIFEST['fixtures']}
N_COMMITTED = sum(1 for f in MANIFEST['fixtures'] if f['expect']['status'] == 'committed')
N_FAILED_CLOSED = len(MANIFEST['fixtures']) - N_COMMITTED
# The manifest URL and pin exactly as the deployed pages will request them.
PAGE_PINS = {}
for _page in ('phase9-suite.js', 'phase9-editor.js'):
    _m = re.search(r"const MANIFEST = Object\.freeze\(\{ url: '([^']+)', sha256: '([0-9a-f]{64})' \}\);", open(os.path.join(LAB_DIR, _page), encoding='ascii').read())
    if not _m:
        raise SystemExit(f'manifest pin line not found in {_page}')
    PAGE_PINS[_page] = (_m.group(1), _m.group(2))
DEPLOY_FILES = [line.split(' ', 1) for line in open(os.path.join(PKG, 'deploy', 'deploy-files.txt'), encoding='ascii').read().splitlines() if line.strip()]
TAMPERED_FIXTURE = 'euro-winansi'  # not the live control fixture
MANIFEST_SHA = hashlib.sha256(MANIFEST_BYTES).hexdigest()


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


def configure(engine='real', inject='none', pdfjs='ok', tamper='none'):
    # host=live: the harness server answers 403 to every *.json URL, as app.noblepdf.com does.
    return http_get('/__harness/scenario?' + urllib.parse.urlencode(dict(engine=engine, subst='0', inject=inject, pdfjs=pdfjs, stock='pinned', host='live', tamper=tamper)))


def new_page(browser, out):
    ctx = browser.new_context(viewport={'width': 1400, 'height': 2200}, accept_downloads=True)
    page = ctx.new_page()
    out['console'] = []
    page.on('console', lambda m: out['console'].append(f'{m.type}: {m.text}'[:300]))
    page.on('pageerror', lambda e: out['console'].append(f'pageerror: {e}'[:300]))
    return ctx, page


# ------------------------------------------------------------------ suite page
def suite_scenario(browser, sc):
    configure(sc.get('engine', 'real'), sc.get('inject', 'none'), sc.get('pdfjs', 'ok'), sc.get('tamper', 'none'))
    out = dict(id=sc['id'], note=sc['note'])
    ctx, page = new_page(browser, out)
    t0 = time.time()
    page.goto(BASE + SUITE, wait_until='load')
    page.wait_for_function("() => !document.getElementById('privacyStatus').textContent.startsWith('Checking')", timeout=60000)
    page.click('#runPreflight')
    page.wait_for_function("() => { const t = document.getElementById('preflightReport').textContent; return t.includes('Ready:') || t.includes('FAIL'); }", timeout=120000)
    page.wait_for_function("() => !document.getElementById('runPreflight').disabled", timeout=120000)
    out['ready'] = page.inner_text('#readyStatus').strip()
    out['identity'] = page.inner_text('#identityStatus').strip()
    out['privacy'] = page.inner_text('#privacyStatus').strip()
    out['preflight'] = page.inner_text('#preflightReport')
    out['fixtures'] = page.inner_text('#fixtureStatus').strip()
    if out['ready'] == 'YES' and sc.get('run_suite'):
        page.click('#runSuite')
        page.wait_for_function("() => !!document.documentElement.dataset.suiteResult", timeout=900000)
        out['suite_result'] = page.evaluate("() => document.documentElement.dataset.suiteResult")
        out['matched'] = page.inner_text('#matchedStatus').strip()
        out['committed'] = page.inner_text('#committedStatus').strip()
        out['failed_closed'] = page.inner_text('#blockedStatus').strip()
        out['decision'] = page.inner_text('#decisionStatus').strip()
        out['report'] = page.inner_text('#suiteReport')
    out['network'] = page.inner_text('#networkResults')
    out['seconds'] = round(time.time() - t0, 1)
    ctx.close()
    exp = sc['expect']
    probs = []
    if out['ready'] != exp['ready']:
        probs.append(f"ready {out['ready']} expected {exp['ready']}")
    if 'privacy' in exp and not out['privacy'].startswith(exp['privacy']):
        probs.append(f"privacy {out['privacy'][:80]!r} expected to start with {exp['privacy']}")
    if exp.get('min_warn') and out['network'].count('\nWARN') < exp['min_warn']:
        probs.append(f"expected at least {exp['min_warn']} WARN lines")
    if exp.get('fail_contains') and exp['fail_contains'] not in out['network'] + out['preflight']:
        probs.append(f"expected failure text {exp['fail_contains']!r}")
    if 'fixtures' in exp and out['fixtures'] != exp['fixtures']:
        probs.append(f"fixture status {out['fixtures']!r} expected {exp['fixtures']!r}")
    if exp['ready'] == 'YES' and f"Manifest {MANIFEST_SHA} (pinned)" not in out['preflight']:
        probs.append('preflight did not load and hash-verify the pinned manifest')
    if sc.get('run_suite') and exp['ready'] == 'YES':
        if out.get('suite_result') != exp['suite_result']:
            probs.append(f"suite result {out.get('suite_result')} expected {exp['suite_result']}")
        want = f"{len(MANIFEST['fixtures'])}/{len(MANIFEST['fixtures'])}"
        if exp['suite_result'] == 'pass':
            if out.get('matched') != want:
                probs.append(f"matched {out.get('matched')} expected {want}")
            if out.get('committed') != str(N_COMMITTED) or out.get('failed_closed') != str(N_FAILED_CLOSED):
                probs.append(f"committed {out.get('committed')} / failed closed {out.get('failed_closed')}, expected {N_COMMITTED} / {N_FAILED_CLOSED}")
            if 'live discrimination control PASS (rejected)' not in out.get('report', ''):
                probs.append('the SetPositions-disabled live control was not rejected')
        if exp.get('failing_fixture'):
            fails = [x for x in out.get('report', '').splitlines() if x.startswith('FAIL  ')]
            want_bad = f"{len(MANIFEST['fixtures']) - 1}/{len(MANIFEST['fixtures'])}"
            if out.get('matched') != want_bad or len(fails) != 1 or not fails[0].startswith(f"FAIL  {exp['failing_fixture']} ") or ' observed error ' not in fails[0]:
                probs.append(f"expected only {exp['failing_fixture']} to fail (hash check, status error) (matched {out.get('matched')}): {fails[:2]}")
    errs = [c for c in out['console'] if c.startswith('pageerror') or c.startswith('error')]
    if sc.get('inject', 'none') != 'none':  # the browser logs each CSP refusal of an injected script
        errs = [c for c in errs if not c.startswith('error: Refused to')]
    if errs and not exp.get('allow_console_errors'):
        probs.append('console errors: ' + ' | '.join(errs[:3]))
    out['problems'] = probs
    return out


# ------------------------------------------------------------------ live-host compatibility
FETCH_JS = """async (urls) => {
  const out = [];
  for (const u of urls) {
    try {
      const r = await fetch(u, { cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
      const b = new Uint8Array(await r.arrayBuffer());
      const h = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b)), (x) => x.toString(16).padStart(2, '0')).join('');
      out.push({ u, status: r.status, sha: h });
    } catch (e) { out.push({ u, status: 0, sha: String(e) }); }
  }
  return out;
}"""


def host_scenario(browser, sc):
    """Fetches, from the lab page itself and through the emulated live host, the exact manifest
    URL written in both pages and every file in deploy-files.txt. Any deployed asset the live
    host would refuse (for example a .json file) fails here, before a deploy."""
    configure('real')
    out = dict(id=sc['id'], note=sc['note'], steps=[])
    probs = []

    def check(cond, what):
        out['steps'].append(('OK   ' if cond else 'FAIL ') + what)
        if not cond:
            probs.append(what)

    ctx, page = new_page(browser, out)
    t0 = time.time()
    page.goto(BASE + SUITE, wait_until='load')
    urls = sorted({u for u, _ in PAGE_PINS.values()})
    check(len(urls) == 1 and len({p for _, p in PAGE_PINS.values()}) == 1, f'suite and editor use one manifest URL and pin {sorted(PAGE_PINS.values())}')
    got = page.evaluate(FETCH_JS, urls + ['./fixtures-phase9/manifest.json?v=1'])
    for g in got[:-1]:
        check(g['status'] == 200 and g['sha'] == MANIFEST_SHA, f"page manifest URL {g['u']} -> HTTP {g['status']}, sha {g['sha'][:16]} (pin {MANIFEST_SHA[:16]})")
    check(got[-1]['status'] == 403, f"the old .json path is refused by the emulated live host (HTTP {got[-1]['status']})")
    rels = [r for _, r in DEPLOY_FILES]
    got = page.evaluate(FETCH_JS, ['/' + r for r in rels])
    bad = [f"{g['u']} HTTP {g['status']}" for g, (want, _) in zip(got, DEPLOY_FILES) if g['status'] != 200 or g['sha'] != want]
    check(not bad and len(got) == len(DEPLOY_FILES), f'all {len(DEPLOY_FILES)} deploy-files.txt entries served with their pinned SHA-256 through the emulated live host' + (f': {bad[:5]}' if bad else ''))
    ctx.close()
    out['seconds'] = round(time.time() - t0, 1)
    out['problems'] = probs
    return out


# ------------------------------------------------------------------ editor page
def editor_open(page, fixture_id):
    page.select_option('#fixture', fixture_id)
    page.wait_for_function("id => document.getElementById('docStatus').textContent.startsWith(id + ':')", arg=fixture_id, timeout=120000)


def editor_click(page, text):
    pt = page.evaluate("t => window.__phase9Editor.pointFor(t)", text)
    if not pt:
        raise RuntimeError(f'no point for {text!r}')
    page.mouse.click(pt['x'], pt['y'])
    page.wait_for_timeout(250)


def editor_apply(page):
    page.click('#apply')
    page.wait_for_function("() => { const t = document.getElementById('result').textContent; return !t.startsWith('Planning') && t !== '-'; }", timeout=300000)
    page.wait_for_function("() => !document.getElementById('fixture').disabled", timeout=120000)
    return page.inner_text('#result').strip()


def replaced(obj, find, repl):
    i = obj.index(find)
    return obj[:i] + repl + obj[i + len(find):]


def sha(b):
    return hashlib.sha256(b).hexdigest()


def editor_scenario(browser, sc):
    configure('real', sc.get('inject', 'none'), tamper=sc.get('tamper', 'none'))
    out = dict(id=sc['id'], note=sc['note'], steps=[])
    ctx, page = new_page(browser, out)
    probs = []
    t0 = time.time()

    def check(cond, what):
        out['steps'].append(('OK   ' if cond else 'FAIL ') + what)
        if not cond:
            probs.append(what)

    page.goto(BASE + EDITOR, wait_until='load')
    page.wait_for_function("() => !document.getElementById('privacyStatus').textContent.startsWith('Checking')", timeout=60000)
    page.click('#start')
    page.wait_for_function("() => { const t = document.getElementById('engineStatus').textContent; return t.startsWith('Run #10') || t.startsWith('Blocked'); }", timeout=120000)
    status = page.inner_text('#engineStatus')
    kind = sc['kind']
    if kind == 'manifest-tampered':
        check(status.startswith('Blocked') and 'fixture manifest does not match its pin' in status, f'tampered manifest refused at startup ({status[:90]})')
        check(page.is_disabled('#fixture'), 'no fixture can be opened')
        status = ''
    else:
        check(status.startswith('Run #10 engine verified'), f'engine verified ({status[:70]})')
    if status.startswith('Run #10') and kind == 'edit-cycle':
        fx = FX['invoice-number-longer']
        obj = fx['edit']['object']
        editor_open(page, fx['id'])
        orig = page.evaluate("() => window.__phase9Editor.originalSha()")
        check(orig == fx['sha256']['before'], 'original bytes are the pinned fixture')
        editor_click(page, obj)
        check(page.input_value('#text') == obj, f'click on the rendered page selected {obj!r}')
        page.fill('#text', replaced(obj, fx['edit']['find'], fx['edit']['replace']))
        res = editor_apply(page)
        check(res.startswith('Committed'), f'edit committed ({res[:90]})')
        st = page.evaluate("() => window.__phase9Editor.state()")
        w1 = page.evaluate("() => window.__phase9Editor.workingSha()")
        check(st['undo'] == 1 and w1 != orig, 'working document replaced, one undo step')
        with page.expect_download() as dl:
            page.click('#download')
        data = open(dl.value.path(), 'rb').read()
        check(sha(data) == w1, 'download equals the verified working document')
        check(data.count(b'%%EOF') == 1 and b'/Prev' not in data, 'download is a single revision (one %%EOF, no /Prev)')
        new_obj = replaced(obj, fx['edit']['find'], fx['edit']['replace'])
        editor_click(page, new_obj)
        check(page.input_value('#text') == new_obj, 'the edited text is selectable again after re-render')
        page.fill('#text', new_obj[:-1])
        res = editor_apply(page)
        check(res.startswith('Committed'), f'second edit (pure deletion, widened) committed ({res[:90]})')
        check(page.evaluate("() => window.__phase9Editor.state().undo") == 2, 'two undo steps')
        page.click('#undo')
        page.wait_for_function("() => document.getElementById('result').textContent.startsWith('Undone')", timeout=60000)
        check(page.evaluate("() => window.__phase9Editor.workingSha()") == w1, 'undo restores the first verified result')
        page.click('#undo')
        page.wait_for_function("() => window.__phase9Editor.state().undo === 0", timeout=60000)
        page.wait_for_timeout(300)
        check(page.evaluate("() => window.__phase9Editor.workingSha()") == orig, 'second undo restores the original')
        page.click('#suggest')
        res = editor_apply(page)
        check(res.startswith('Committed'), 'suggested edit committed again')
        page.click('#reset')
        page.wait_for_function("() => document.getElementById('result').textContent.startsWith('Reset')", timeout=60000)
        check(page.evaluate("() => window.__phase9Editor.workingSha()") == orig and page.evaluate("() => window.__phase9Editor.state().undo") == 0, 'reset restores the original and clears undo')
    elif status.startswith('Run #10') and kind == 'suggest-commit':
        for fid in sc['fixtures']:
            fx = FX[fid]
            editor_open(page, fid)
            orig = page.evaluate("() => window.__phase9Editor.originalSha()")
            editor_click(page, fx['edit']['object'])
            check(page.input_value('#text') == fx['edit']['object'], f'{fid}: click selected the target object')
            page.click('#suggest')
            res = editor_apply(page)
            check(res.startswith('Committed'), f'{fid}: committed ({res[:100]})')
            check(page.evaluate("() => window.__phase9Editor.workingSha()") != orig, f'{fid}: working document changed')
    elif status.startswith('Run #10') and kind == 'blocked':
        for fid, code in sc['fixtures']:
            fx = FX[fid]
            editor_open(page, fid)
            orig = page.evaluate("() => window.__phase9Editor.originalSha()")
            hint = page.inner_text('#hint')
            obj = fx['edit']['object']
            if code in hint:
                check(True, f'{fid}: page-level gate shown before any click ({code})')
            if obj:
                pt = page.evaluate("t => window.__phase9Editor.pointFor(t)", obj)
                if pt:
                    page.mouse.click(pt['x'], pt['y'])
                else:
                    page.click('#suggest')
                page.wait_for_timeout(300)
            reasons = page.inner_text('#reasons') + ' ' + page.inner_text('#hint')
            check(code in reasons, f'{fid}: reason {code} shown ({reasons[:120]!r})')
            check(page.is_disabled('#apply'), f'{fid}: apply stays disabled')
            check(page.evaluate("() => window.__phase9Editor.workingSha()") == orig, f'{fid}: working document untouched')
    elif status.startswith('Run #10') and kind == 'rejected':
        fx = FX['rejected-untouched-grouping']
        editor_open(page, fx['id'])
        orig = page.evaluate("() => window.__phase9Editor.originalSha()")
        editor_click(page, fx['edit']['object'])
        page.click('#suggest')
        res = editor_apply(page)
        check(res.startswith('Rejected by verification'), f'rejected by verification ({res[:90]})')
        check('V12' in page.inner_text('#reasons'), 'the failing check is V12 (PDF.js grouping of an untouched object)')
        check(page.evaluate("() => window.__phase9Editor.workingSha()") == orig and page.evaluate("() => window.__phase9Editor.state().undo") == 0, 'failed edit did not replace the working document')
    elif status.startswith('Run #10') and kind == 'miss':
        editor_open(page, 'invoice-number-longer')
        box = page.locator('#page').bounding_box()
        page.mouse.click(box['x'] + 20, box['y'] + box['height'] - 20)
        page.wait_for_timeout(300)
        check('No text there' in page.inner_text('#hint'), 'click on empty page area selects nothing')
        check(page.is_disabled('#apply'), 'apply disabled without a selection')
    elif status.startswith('Run #10') and kind == 'fixture-tampered':
        fid = sc['fixture']
        page.select_option('#fixture', fid)
        page.wait_for_function("() => document.getElementById('result').textContent.startsWith('Could not load') || document.getElementById('result').textContent.startsWith('Loaded')", timeout=120000)
        res = page.inner_text('#result')
        check(res.startswith('Could not load') and 'do not match the manifest' in res, f'{fid}: tampered fixture refused ({res[:90]})')
        check(not page.inner_text('#docStatus').startswith(fid + ':'), f'{fid}: no working document was created from the tampered bytes')
        check(page.is_disabled('#apply'), f'{fid}: apply stays disabled')
        check(page.evaluate("() => window.__phase9Editor.state().workingLength") == 0, f'{fid}: no working bytes held')
    elif kind == 'manifest-tampered':
        pass
    elif kind == 'env-fail':
        check(True, 'n/a')
    out['privacy'] = page.inner_text('#privacyStatus')
    out['network'] = page.inner_text('#networkResults')
    errs = [c for c in out['console'] if c.startswith('pageerror') or c.startswith('error')]
    if sc.get('inject', 'none') != 'none':
        errs = [c for c in errs if not c.startswith('error: Refused to')]
        check(out['privacy'].startswith('PASS') and out['network'].count('\nWARN') >= 2, 'host-style injected scripts were blocked and recorded as warnings')
    if errs:
        probs.append('console errors: ' + ' | '.join(errs[:3]))
    out['seconds'] = round(time.time() - t0, 1)
    out['problems'] = probs
    ctx.close()
    return out


SCENARIOS = [
    dict(id='S01', page='suite', run_suite=True, note='Suite page, real engine, no injection: every fixture must match and the live control must pass', expect=dict(ready='YES', privacy='PASS', suite_result='pass')),
    dict(id='S02', page='suite', inject='after', note='Host-style cross-origin + inline scripts after the CSP meta: blocked, recorded as warnings, still ready', expect=dict(ready='YES', privacy='PASS', min_warn=2)),
    dict(id='S03', page='suite', inject='before', note='Cross-origin script before the CSP meta (it executes): must fail closed', expect=dict(ready='NO', privacy='FAIL', fail_contains='before the CSP element')),
    dict(id='S04', page='suite', engine='emulated', note='Engine bytes that are not Run #10: must not load', expect=dict(ready='NO', privacy='PASS', fail_contains='SHA-256')),
    dict(id='S05', page='suite', pdfjs='badversion', note='PDF.js bytes that differ from the pin: must fail closed', expect=dict(ready='NO', privacy='FAIL', fail_contains='pinned', allow_console_errors=True)),
    dict(id='S06', page='suite', inject='inline', note='Inline script after the CSP meta only: blocked, matched by a recorded violation, warning', expect=dict(ready='YES', privacy='PASS', min_warn=1)),
    dict(id='E01', page='editor', kind='edit-cycle', note='Editor: click, edit, commit, download, second edit (deletion), undo x2, suggested edit, reset'),
    dict(id='E02', page='editor', kind='suggest-commit', fixtures=['cid-astral', 'ttf-astral-tw', 'state-tz150', 'rotated-30', 'invoice-status-fit'], note='Editor: astral CID, astral simple font with Tw, Tz 150, rotated text and width-preserving fit commit through the real click path'),
    dict(id='E03', page='editor', kind='blocked', fixtures=[('blocked-signed', 'signed-document'), ('blocked-type3', 'font-type3'), ('blocked-form-xobject', 'text-in-form-xobject'), ('blocked-actualtext', 'marked-content-actualtext'), ('blocked-vertical', 'font-vertical')], note='Editor: blocked documents and targets fail closed with the expected reason'),
    dict(id='E04', page='editor', kind='rejected', note='Editor: an edit that verification rejects never replaces the working document'),
    dict(id='E05', page='editor', kind='miss', note='Editor: a click on empty space selects nothing'),
    dict(id='E06', page='editor', kind='suggest-commit', inject='after', fixtures=['invoice-number-longer', 'ttf-custom-encoding'], note='Editor with host-style scripts injected after the CSP meta: blocked as warnings, editing still verified'),
    dict(id='H01', page='host', note='Live-host compatibility: the exact manifest URL of both pages and every deployed file load with their pins through the emulated host (403 for every *.json URL); the old manifest.json path is refused'),
    dict(id='S07', page='suite', tamper='manifest', note='Tampered fixture manifest (one byte): preflight must fail closed', expect=dict(ready='NO', privacy='PASS', fixtures='MISMATCH', fail_contains='DOES NOT MATCH PIN')),
    dict(id='S08', page='suite', tamper=TAMPERED_FIXTURE + '-before.pdf', run_suite=True, note='Tampered fixture PDF (one byte): that fixture must fail on its hash, the suite must stay blocked', expect=dict(ready='YES', privacy='PASS', suite_result='blocked', failing_fixture=TAMPERED_FIXTURE)),
    dict(id='E07', page='editor', kind='manifest-tampered', tamper='manifest', note='Editor with a tampered fixture manifest: startup refused, nothing can be opened'),
    dict(id='E08', page='editor', kind='fixture-tampered', tamper=TAMPERED_FIXTURE + '-before.pdf', fixture=TAMPERED_FIXTURE, note='Editor with a tampered fixture PDF: the fixture is refused before a working document exists'),
]


def main():
    wanted = set(sys.argv[1:])
    scenarios = [s for s in SCENARIOS if not wanted or s['id'] in wanted]
    os.makedirs(RESULTS, exist_ok=True)
    server = start_server()
    results = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            for sc in scenarios:
                try:
                    out = suite_scenario(browser, sc) if sc['page'] == 'suite' else host_scenario(browser, sc) if sc['page'] == 'host' else editor_scenario(browser, sc)
                except Exception as e:  # a crash is a failure, never a pass
                    out = dict(id=sc['id'], note=sc['note'], problems=[f'harness error: {e}'])
                out['verdict'] = 'OK' if not out['problems'] else 'UNEXPECTED'
                results.append(out)
                extra = f"ready={out.get('ready')} suite={out.get('suite_result')} matched={out.get('matched')}" if sc['page'] == 'suite' else f"steps={sum(1 for s in out.get('steps', []) if s.startswith('OK'))}/{len(out.get('steps', []))}"
                print(f"{out['id']} {out['verdict']:10} {sc['page']:6} {extra} {out.get('seconds')}s {'; '.join(out['problems'])[:600]}", flush=True)
            browser.close()
    finally:
        server.terminate()
    suffix = '' if not wanted else '-' + '-'.join(sorted(wanted))
    with open(os.path.join(RESULTS, f'phase9-browser-results{suffix}.json'), 'w', encoding='utf-8') as f:
        json.dump(results, f, indent=1)
    lines = []
    for r in results:
        lines.append(f"{r['id']} [{r['verdict']}] {r['note']}")
        for s in r.get('steps', []):
            lines.append('    ' + s)
        if r.get('report'):
            lines.extend('    | ' + x for x in r['report'].splitlines()[:8])
        if r['problems']:
            lines.append('    PROBLEMS: ' + '; '.join(r['problems']))
    with open(os.path.join(RESULTS, f'phase9-browser-results{suffix}.txt'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    bad = [r for r in results if r['verdict'] != 'OK']
    print('PHASE 9 BROWSER OK' if not bad else f'PHASE 9 BROWSER: {len(bad)} unexpected')
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
