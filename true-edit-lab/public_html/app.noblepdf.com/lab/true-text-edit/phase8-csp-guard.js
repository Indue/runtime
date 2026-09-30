/* NoblePDF True Edit Phase 8 V2 lab: early CSP violation recorder.
   Loaded as the first script in <head>, directly after the CSP meta element,
   so it can record resources the policy blocks (for example host-injected
   monitoring scripts). Blocked requests never appear in Resource Timing, so
   without this recorder the privacy audit would be blind to them.
   Records only; it never loads anything and never changes the page. */
(function () {
  'use strict';
  var violations = [];
  var started = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
  function onViolation(e) {
    try {
      violations.push({
        directive: String(e.effectiveDirective || e.violatedDirective || ''),
        blocked: String(e.blockedURI || ''),
        source: String(e.sourceFile || ''),
        line: Number(e.lineNumber || 0),
        disposition: String(e.disposition || ''),
        sample: String(e.sample || '').slice(0, 80),
        t: (typeof performance !== 'undefined' && performance.now) ? Math.round(performance.now()) : 0
      });
    } catch (err) { /* recording must never throw */ }
  }
  document.addEventListener('securitypolicyviolation', onViolation, true);
  Object.defineProperty(window, '__phase8Guard', {
    value: Object.freeze({ version: 'phase8-csp-guard-v2.1', startedAt: started, violations: violations }),
    writable: false,
    configurable: false,
    enumerable: false
  });
}());
