// NoblePDF True Edit (Phase 9 lab): runtime privacy and integrity audit. Browser only.
// Extends the Phase 8 V2 audit: every unexpected script must be matched by a recorded
// CSP violation (otherwise it is assumed to have executed and the audit fails),
// cross-origin Resource Timing entries count as blocked only with a matching violation,
// eval must be blocked, the PDF.js library and worker must be the pinned bytes, and a
// controlling service worker is reported. ASCII only.
import { sha256Hex } from './phase8-verify.mjs?v=1';
import { PDFJS_PIN } from './te-render.mjs?v=1';

export const TE_ENV_VERSION = 'te-env-2';

// Resource Timing keeps only 250 entries by default and silently drops the rest; a suite
// run loads far more, so every later request would be missing from the audit (seen live:
// exactly 250 entries, nothing after the 16th fixture). The buffer is enlarged and a
// PerformanceObserver, which the buffer limit does not affect, records every entry from
// module start (buffered: true also delivers the entries loaded before). If neither can
// guarantee a complete list, the audit fails.
const RT = { entries: [], observer: null, overflow: false };
try { performance.setResourceTimingBufferSize(100000); } catch (e) { /* the observer below does not need it */ }
try { performance.addEventListener('resourcetimingbufferfull', () => { RT.overflow = true; }); } catch (e) { /* older browsers */ }
try {
  RT.observer = new PerformanceObserver((list) => { RT.entries.push(...list.getEntries()); });
  RT.observer.observe({ type: 'resource', buffered: true });
} catch (e) { RT.observer = null; }
function resourceEntries() {
  if (!RT.observer) return performance.getEntriesByType('resource');
  RT.entries.push(...RT.observer.takeRecords()); // entries not yet delivered to the callback
  return RT.entries.slice();
}

export async function environmentAudit({ expectedScripts }) {
  const out = { pass: true, fail: [], warn: [], lines: [], checks: [] };
  const guard = window.__phase8Guard;
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  if (!guard || !Array.isArray(guard.violations)) out.fail.push('CSP recorder (phase8-csp-guard.js) did not run');
  if (!meta) out.fail.push('CSP meta element missing');
  else {
    const csp = meta.getAttribute('content') || '';
    if (/unsafe-eval(?!')|'unsafe-eval'|'unsafe-inline'/.test(csp)) out.fail.push(`CSP allows eval or inline script: ${csp}`);
    if (!/script-src 'self' 'wasm-unsafe-eval'(;|$)/.test(csp)) out.fail.push(`unexpected script-src in CSP: ${csp}`);
  }
  // Our own eval probe (below) records an 'eval' violation; it is not a foreign attempt.
  const violations = guard ? guard.violations.filter((v) => v.blocked !== 'eval') : [];
  const expected = new Set(expectedScripts.map((u) => new URL(u, location.href)).map((u) => `${u.origin}${u.pathname}`));
  const inlineViolations = violations.filter((v) => /script-src/.test(v.directive) && (v.blocked === 'inline' || v.blocked === '')).length;
  let inlineUnexpected = 0;
  for (const s of document.scripts) {
    const src = s.src ? new URL(s.src, location.href) : null;
    const key = src ? `${src.origin}${src.pathname}` : '';
    if (src && expected.has(key)) continue;
    const beforeCsp = meta ? !!(s.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING) : true;
    const label = src ? src.href : `inline script (${(s.textContent || '').trim().slice(0, 40)})`;
    if (beforeCsp) { out.fail.push(`script before the CSP element executed without the policy: ${label}`); continue; }
    if (!src) { inlineUnexpected++; continue; }
    if (src.origin === location.origin) { out.fail.push(`unexpected same-origin script ran: ${label}`); continue; }
    const blocked = violations.some((v) => { try { return new URL(v.blocked, location.href).href.split('#')[0] === src.href.split('#')[0]; } catch (e) { return false; } });
    if (blocked) out.warn.push(`cross-origin script blocked by CSP (recorded violation): ${label}`);
    else out.fail.push(`cross-origin script without a matching CSP violation (assumed executed): ${label}`);
  }
  if (inlineUnexpected > inlineViolations) out.fail.push(`${inlineUnexpected} unexpected inline script(s) but only ${inlineViolations} inline CSP violation(s): at least one may have executed`);
  else if (inlineUnexpected) out.warn.push(`${inlineUnexpected} unexpected inline script(s) after the CSP element, each matched by a recorded CSP violation (blocked)`);
  if (!RT.observer && RT.overflow) out.fail.push('Resource Timing buffer overflowed and PerformanceObserver is unavailable: the network audit cannot see every request');
  const resources = resourceEntries().map((e) => {
    let origin = '(invalid)';
    try { origin = new URL(e.name, location.href).origin; } catch (err) { /* invalid */ }
    return { name: e.name, origin, type: e.initiatorType || '' };
  });
  const matches = (url) => violations.some((v) => {
    if (!v.blocked) return false;
    try { const b = new URL(v.blocked, location.href); const u = new URL(url, location.href); return b.origin === u.origin && (b.pathname === u.pathname || b.pathname === '/'); } catch (e) { return false; }
  });
  for (const r of resources.filter((x) => x.origin !== location.origin)) {
    if (matches(r.name)) out.warn.push(`cross-origin request blocked by CSP (listed by Resource Timing): ${r.name}`);
    else out.fail.push(`cross-origin resource loaded (no matching CSP violation): ${r.name}`);
  }
  let evalBlocked = false;
  try { new Function('return 1')(); } catch (e) { evalBlocked = true; }
  if (!evalBlocked) out.fail.push('eval is NOT blocked (CSP must not allow unsafe-eval)');
  const sw = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  if (sw) out.warn.push('a service worker controls this page (engine, PDF.js and fixture bytes are still hash-verified)');
  // PDF.js integrity: version, SRI attribute, pinned bytes of library and worker.
  const lib = globalThis.pdfjsLib;
  const tag = [...document.scripts].find((s) => s.src && new URL(s.src, location.href).pathname === PDFJS_PIN.lib);
  if (!lib || lib.version !== PDFJS_PIN.version) out.fail.push(`PDF.js version ${lib ? lib.version : 'missing'} (pinned ${PDFJS_PIN.version})`);
  if (!tag || tag.getAttribute('integrity') !== PDFJS_PIN.libSri) out.fail.push('PDF.js script tag lacks the pinned SRI integrity attribute');
  const shaOf = async (u) => { const r = await fetch(u, { cache: 'no-store', credentials: 'same-origin', redirect: 'error' }); if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return sha256Hex(new Uint8Array(await r.arrayBuffer())); };
  let libSha = '';
  let workerSha = '';
  try { libSha = await shaOf(PDFJS_PIN.lib); workerSha = await shaOf(PDFJS_PIN.worker); } catch (e) { out.fail.push(`PDF.js files unreadable: ${e.message}`); }
  if (libSha && libSha !== PDFJS_PIN.libSha256) out.fail.push(`pdf.min.js SHA-256 ${libSha} is not the pinned npm 3.11.174 build`);
  if (workerSha && workerSha !== PDFJS_PIN.workerSha256) out.fail.push(`pdf.worker.min.js SHA-256 ${workerSha} is not the pinned npm 3.11.174 build`);
  out.pass = out.fail.length === 0;
  out.serviceWorker = sw;
  out.evalBlocked = evalBlocked;
  out.violations = violations.length;
  out.lines = [
    `Origin: ${location.origin}`,
    `Resource Timing entries: ${resources.length} (cross-origin ${resources.filter((x) => x.origin !== location.origin).length}; ${RT.observer ? 'complete: PerformanceObserver since module start' : 'buffer only'}${RT.overflow ? '; buffer overflowed' : ''})`,
    `CSP-blocked attempts recorded: ${violations.length}`,
    `eval blocked by CSP: ${evalBlocked ? 'yes' : 'NO'}`,
    `PDF.js ${lib ? lib.version : 'missing'}; pdf.min.js ${libSha.slice(0, 12)}; worker ${workerSha.slice(0, 12)}; SRI attribute ${tag && tag.getAttribute('integrity') === PDFJS_PIN.libSri ? 'present' : 'MISSING'}; getDocument forces isEvalSupported=false`,
    `Service worker controlling this page: ${sw ? 'YES' : 'no'}`,
    `Verdict: ${out.pass ? 'PASS' : 'FAIL - editing and the suite stay blocked'}`,
    ...out.fail.map((x) => `FAIL  ${x}`),
    ...out.warn.map((x) => `WARN  ${x}`),
    '',
    ...resources.map((r) => `${r.origin === location.origin ? 'LOCAL   ' : 'EXTERNAL'} ${r.type.padEnd(14)} ${r.name}`),
  ];
  return out;
}
