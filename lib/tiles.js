// Static worldwide toilet tiles (built weekly from OpenStreetMap by tools/dataset, hosted on GitHub Pages).
// Shared by the web app and the Android app. A tile covers DEG x DEG degrees and is named
// floor(lat/DEG)_floor(lon/DEG).json; a missing tile (HTTP 404) simply has no toilets. Rows are expanded into
// Overpass-shaped elements so Data.normalise handles tiles and Overpass results the same way.
(function (root) {
  var BASE = 'https://nathanjaldridge-star.github.io/toilet-finder-data/v1/';
  var DEG = 0.5;
  var TYPES = { n: 'node', w: 'way', r: 'relation' };

  function key(lat, lon, deg) { deg = deg || DEG; return Math.floor(lat / deg) + '_' + Math.floor(lon / deg); }

  // Tile keys covering a bbox {s,w,n,e}; null when more than `max` tiles would be needed (zoomed too far out).
  function keysForBbox(b, max, deg) {
    deg = deg || DEG; max = max || 12;
    var s = Math.floor(b.s / deg), n = Math.floor(b.n / deg), w = Math.floor(b.w / deg), e = Math.floor(b.e / deg);
    if ((n - s + 1) * (e - w + 1) > max) return null;
    var out = [];
    for (var i = s; i <= n; i++) for (var j = w; j <= e; j++) out.push(i + '_' + j);
    return out;
  }

  // {t: [[type, id, lat, lon, tags]], p: [[type, id, lat, lon, [s,w,n,e]|0, tags]]} -> Overpass-like elements
  function expand(tile) {
    var els = [];
    ((tile && tile.t) || []).forEach(function (r) {
      els.push({ type: TYPES[r[0]] || r[0], id: r[1], lat: r[2], lon: r[3], tags: r[4] || {} });
    });
    ((tile && tile.p) || []).forEach(function (r) {
      var el = { type: TYPES[r[0]] || r[0], id: r[1], lat: r[2], lon: r[3], tags: r[5] || {} };
      if (r[4]) el.bounds = { minlat: r[4][0], minlon: r[4][1], maxlat: r[4][2], maxlon: r[4][3] };
      els.push(el);
    });
    return els;
  }

  // opts: {fetch, base, timeoutMs, headers, AbortController}
  // load(bbox) -> Promise<{elements, keys, fetched, cached, missing, failed, ms, base}>; rejects (err.failed) when
  // the bbox needs too many tiles or every tile it needs failed to download, so the caller can fall back to Overpass.
  function create(opts) {
    opts = opts || {};
    var fetchFn = opts.fetch || (typeof fetch !== 'undefined' ? fetch.bind(null) : null);
    var AC = opts.AbortController || (typeof AbortController !== 'undefined' ? AbortController : null);
    var base = opts.base || BASE, timeoutMs = opts.timeoutMs || 15000;
    var cache = {}, inflight = {}, state = { index: null, lastOk: null, lastError: null };

    function getJson(url) {
      var ctl = AC ? new AC() : null, t = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs) : null;
      return fetchFn(url, { headers: opts.headers || { Accept: 'application/json' }, signal: ctl ? ctl.signal : undefined })
        .then(function (res) {
          if (res.status === 404) return null;
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function (v) { if (t) clearTimeout(t); return v; }, function (e) { if (t) clearTimeout(t); throw e; });
    }

    function tile(k) {
      if (cache[k]) return Promise.resolve({ tile: cache[k], cached: true });
      if (!inflight[k]) {
        inflight[k] = getJson(base + 'tiles/' + k + '.json').then(function (j) {
          delete inflight[k];
          cache[k] = j || { v: 1, k: k, t: [], p: [], missing: true };
          return { tile: cache[k], cached: false };
        }, function (e) { delete inflight[k]; throw e; });
      }
      return inflight[k];
    }

    function index() {
      return getJson(base + 'index.json').then(function (j) { state.index = j; return j; });
    }

    function load(bbox) {
      var t0 = Date.now(), keys = keysForBbox(bbox, opts.maxTiles);
      if (!keys) { var big = new Error('area too large for tiles'); big.failed = []; return Promise.reject(big); }
      var res = { elements: [], keys: keys, fetched: 0, cached: 0, missing: 0, failed: [], ms: 0, base: base };
      return Promise.all(keys.map(function (k) {
        return tile(k).then(function (r) {
          if (r.cached) res.cached++; else res.fetched++;
          if (r.tile.missing) res.missing++;
          var els = expand(r.tile);
          for (var i = 0; i < els.length; i++) res.elements.push(els[i]);
        }, function (e) { res.failed.push(k + ': ' + ((e && e.name === 'AbortError') ? 'timeout' : (e && e.message) || 'error')); });
      })).then(function () {
        res.ms = Date.now() - t0;
        if (res.failed.length === keys.length) {
          var err = new Error('tiles failed (' + res.failed.join(', ') + ')'); err.failed = res.failed;
          state.lastError = err.message; throw err;
        }
        state.lastOk = Date.now();
        return res;
      });
    }

    return { load: load, index: index, state: state, base: base, cache: cache };
  }

  var api = { BASE: BASE, DEG: DEG, key: key, keysForBbox: keysForBbox, expand: expand, create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Tiles = api;
})(typeof self !== 'undefined' ? self : this);
