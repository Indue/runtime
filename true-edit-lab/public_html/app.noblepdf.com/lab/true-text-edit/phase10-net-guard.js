/* NoblePDF True Edit Phase 10 lab: early network ledger and upload guard. ASCII only.
   Loaded as the second script in <head>, directly after phase8-csp-guard.js and before
   PDF.js and every module, so nothing on the page can make a request it does not see.
   - Records every fetch, XMLHttpRequest and sendBeacon call: method, absolute URL and
     whether a request body was attached.
   - Refuses (and records) any request that carries a body or uses a method other than GET
     or HEAD, every sendBeacon, WebSocket and EventSource. The corpus page never needs any
     of them; the CSP (connect-src 'self', form-action 'none') blocks cross-origin requests
     and form posts independently of this guard.
   - Records every Resource Timing entry from page start with a PerformanceObserver, which
     the Resource Timing buffer limit does not affect.
   It never sends anything and never changes the page. */
(function () {
  'use strict';
  var calls = [];
  var refused = [];
  var entries = [];
  var state = { observer: false, overflow: false };
  function now() { try { return Math.round(performance.now()); } catch (e) { return 0; } }
  function abs(u) { try { return new URL(String(u), location.href).href; } catch (e) { return String(u); } }
  function note(kind, method, url, body) {
    var r = { kind: kind, method: String(method || 'GET').toUpperCase(), url: abs(url), body: !!body, t: now(), refused: '' };
    calls.push(r);
    return r;
  }
  function refuse(r, why) { r.refused = why; refused.push(r); }
  function readOnly(m) { return m === 'GET' || m === 'HEAD'; }
  function snap(e) { return { name: String(e.name), type: String(e.initiatorType || ''), start: Math.round(e.startTime || 0) }; }
  try { performance.setResourceTimingBufferSize(100000); } catch (e) { /* the observer does not need it */ }
  try { performance.addEventListener('resourcetimingbufferfull', function () { state.overflow = true; }); } catch (e) { /* older browsers */ }
  var observer = null;
  try {
    observer = new PerformanceObserver(function (list) { var l = list.getEntries(); for (var i = 0; i < l.length; i++) entries.push(snap(l[i])); });
    observer.observe({ type: 'resource', buffered: true });
    state.observer = true;
  } catch (e) { observer = null; }

  var nativeFetch = window.fetch;
  var guardedFetch = function (input, init) {
    var req = (typeof Request !== 'undefined' && input instanceof Request) ? input : null;
    var method = (init && init.method) || (req && req.method) || 'GET';
    var body = !!(init && init.body !== undefined && init.body !== null) || !!(req && req.body);
    var r = note('fetch', method, req ? req.url : input, body);
    if (body || !readOnly(r.method)) { refuse(r, 'request body or non-GET method'); return Promise.reject(new TypeError('Phase 10 upload guard: request refused')); }
    return nativeFetch.apply(this, arguments);
  };
  Object.defineProperty(window, 'fetch', { value: guardedFetch, writable: false, configurable: false, enumerable: true });

  var X = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  var xhrInfo = new WeakMap();
  var guardedSend = null;
  if (X) {
    var nativeOpen = X.open;
    var nativeSend = X.send;
    guardedSend = function (body) {
      var i = xhrInfo.get(this) || { method: 'GET', url: '' };
      var r = note('xhr', i.method, i.url, body !== undefined && body !== null);
      if (r.body || !readOnly(r.method)) { refuse(r, 'request body or non-GET method'); throw new TypeError('Phase 10 upload guard: request refused'); }
      return nativeSend.apply(this, arguments);
    };
    Object.defineProperty(X, 'open', { value: function (method, url) { xhrInfo.set(this, { method: method, url: url }); return nativeOpen.apply(this, arguments); }, writable: false, configurable: false });
    Object.defineProperty(X, 'send', { value: guardedSend, writable: false, configurable: false });
  }
  if (navigator.sendBeacon) {
    Object.defineProperty(navigator, 'sendBeacon', { value: function (url, data) { refuse(note('beacon', 'POST', url, data !== undefined && data !== null), 'sendBeacon is never allowed'); return false; }, writable: false, configurable: false });
  }
  function blockCtor(name) {
    if (!window[name]) return;
    Object.defineProperty(window, name, { value: function (url) { refuse(note(name, 'OPEN', url, false), name + ' is never allowed'); throw new TypeError('Phase 10 upload guard: ' + name + ' refused'); }, writable: false, configurable: false });
  }
  blockCtor('WebSocket');
  blockCtor('EventSource');

  Object.defineProperty(window, '__phase10Net', {
    value: Object.freeze({
      version: 'phase10-net-guard-1',
      calls: function () { return calls.slice(); },
      refused: function () { return refused.slice(); },
      entries: function () {
        if (observer) { var l = observer.takeRecords(); for (var i = 0; i < l.length; i++) entries.push(snap(l[i])); return entries.slice(); }
        return performance.getEntriesByType('resource').map(snap);
      },
      observerActive: function () { return state.observer; },
      overflowed: function () { return state.overflow; },
      fetchIntact: function () { return window.fetch === guardedFetch; },
      xhrIntact: function () { return !X || X.send === guardedSend; }
    }),
    writable: false,
    configurable: false,
    enumerable: false
  });
}());
