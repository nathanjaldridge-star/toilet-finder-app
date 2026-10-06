// Hedged Overpass client shared by the web app and the Android app. The preferred mirror goes first, the next
// one starts after staggerMs if nothing has answered, and so on; a failure starts the next one immediately.
// The first valid response wins and the rest are aborted. fetch/AbortController are injected (tests, RN, web).
(function (root) {
  var Data = (typeof require !== 'undefined' && typeof module !== 'undefined') ? require('./data.js') : root.Data;

  function host(ep) { return ep.replace(/^https:\/\/([^\/]+).*/, '$1'); }

  function create(opts) {
    opts = opts || {};
    var fetchFn = opts.fetch || (typeof fetch !== 'undefined' ? fetch.bind(null) : null);
    var AC = opts.AbortController || (typeof AbortController !== 'undefined' ? AbortController : null);
    var staggerMs = opts.staggerMs != null ? opts.staggerMs : 3500, attemptMs = opts.attemptMs != null ? opts.attemptMs : 22000;
    var endpoints = (opts.endpoints || Data.ENDPOINTS).slice();
    var state = { lastGood: null };

    function attempt(ep, body, outer) {
      var ctl = new AC();
      var t = setTimeout(function () { ctl.abort(); }, attemptMs);
      if (outer) outer.addEventListener('abort', function () { ctl.abort(); });
      return fetchFn(ep, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' }, body: body, signal: ctl.signal })
        .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.text(); })
        .then(function (v) { clearTimeout(t); return v; }, function (e) { clearTimeout(t); throw e; });
    }

    // -> Promise<{elements, endpoint, ms, attempts, remark}>; rejects with err.attempts
    function query(queryText) {
      var eps = endpoints.slice();
      if (state.lastGood && eps.indexOf(state.lastGood) > 0) { eps.splice(eps.indexOf(state.lastGood), 1); eps.unshift(state.lastGood); }
      var attempts = [], stop = new AC(), t0 = Date.now(), body = 'data=' + encodeURIComponent(queryText);
      return new Promise(function (resolve, reject) {
        var done = false, failed = 0, started = 0, timers = [];
        function finish(fn, v) { if (done) return; done = true; timers.forEach(clearTimeout); stop.abort(); fn(v); }
        function startNext() {
          if (done || started >= eps.length) return;
          var ep = eps[started++];
          timers.forEach(clearTimeout);
          timers = started < eps.length ? [setTimeout(startNext, staggerMs)] : [];
          var a = { endpoint: ep, host: host(ep), result: 'pending', ms: null }, s = Date.now();
          attempts.push(a);
          attempt(ep, body, stop.signal).then(function (txt) {
            var json; try { json = JSON.parse(txt); } catch (e) { throw new Error('not JSON (' + String(txt).slice(0, 40).replace(/\s+/g, ' ') + ')'); }
            var els = Data.checkResponse(json);
            a.ms = Date.now() - s; a.result = 'ok';
            state.lastGood = ep;
            finish(resolve, { elements: els, endpoint: ep, ms: Date.now() - t0, attempts: attempts, remark: json.remark || null });
          }).catch(function (e) {
            if (done) { if (a.result === 'pending') a.result = 'cancelled'; return; }
            a.ms = Date.now() - s; a.result = (e && e.name === 'AbortError') ? 'timeout' : (e && e.message) || 'error';
            failed++;
            if (failed >= eps.length) {
              var err = new Error('all ' + eps.length + ' Overpass mirrors failed (' + attempts.map(function (x) { return x.host + ': ' + x.result; }).join(', ') + ')');
              err.attempts = attempts;
              finish(reject, err);
            } else startNext();
          });
        }
        startNext();
      });
    }

    return { query: query, state: state, host: host };
  }

  var api = { create: create, host: host };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Overpass = api;
})(typeof self !== 'undefined' ? self : this);
