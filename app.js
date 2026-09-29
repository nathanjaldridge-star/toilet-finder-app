(function () {
  'use strict';
  var APP_VERSION = 'tf-v3';
  var HACKNEY = { lat: 51.5450, lon: -0.0553 };
  var RADIUS = 1500;           // first load: this far around you (m); list also shows this far around the reference point
  var MIN_ZOOM = 13;           // below this the visible area is too big to query
  var MAX_SPAN = 0.06;         // max latitude span (deg, ~6.7 km) of one query
  var LIST_MAX = 80;
  var STAGGER_MS = 3500, ATTEMPT_MS = 22000;
  var LS = { cache: 'tf.cache.v3', ratings: 'tf.ratings.v1', reports: 'tf.reports.v1', hours: 'tf.hours.v1' };
  var demo = /[?&]demo=1/.test(location.search);

  var state = {
    pos: HACKNEY, ref: HACKNEY, usingFallback: true, geoNote: 'not asked yet',
    store: {}, parents: {}, covered: [],
    filters: { accessible: false, urinals: false },
    map: null, markers: null, meMarker: null, userMoved: false,
    busy: false, ready: false, pending: null, error: null, lastGoodEndpoint: null, fromCache: false,
    diag: { endpoint: null, at: null, ms: null, fetched: 0, bbox: null, attempts: [], lastError: null, fetches: 0, parents: null, objectChecks: {} }
  };
  var $ = function (id) { return document.getElementById(id); };

  function load(key, dflt) { try { return JSON.parse(localStorage.getItem(key)) || dflt; } catch (e) { return dflt; } }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // ---- ratings, reports and hours you add (localStorage, keyed by OSM id like "node/123") ----
  function getRatings(id) { return load(LS.ratings, {})[id] || []; }
  function addRating(id, n) { var all = load(LS.ratings, {}); all[id] = [n]; save(LS.ratings, all); }
  function avgRating(id) {
    var r = getRatings(id);
    if (!r.length) return null;
    return r.reduce(function (a, b) { return a + b; }, 0) / r.length;
  }
  function getReports(id) { return load(LS.reports, {})[id] || {}; }
  function toggleReport(id, kind) {
    var all = load(LS.reports, {}), r = all[id] || {};
    if (r[kind]) delete r[kind]; else r[kind] = Date.now();
    all[id] = r; save(LS.reports, all);
  }
  function getMyHours(id) { return load(LS.hours, {})[id] || null; }
  function setMyHours(id, text) {
    var all = load(LS.hours, {});
    if (text) all[id] = { text: text, at: Date.now() }; else delete all[id];
    save(LS.hours, all);
  }

  // ---- fetching ----
  function fetchWithTimeout(url, opts, ms, outer) {
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, ms);
    if (outer) outer.addEventListener('abort', function () { ctl.abort(); });
    opts.signal = ctl.signal;
    return fetch(url, opts).finally(function () { clearTimeout(t); });
  }

  // Hedged request across mirrors: the preferred mirror goes first, the next one starts after STAGGER_MS if
  // nothing has answered, and so on. First valid response wins and the rest are aborted.
  function overpass(queryText) {
    var eps = Data.ENDPOINTS.slice();
    if (state.lastGoodEndpoint && eps.indexOf(state.lastGoodEndpoint) > 0) { eps.splice(eps.indexOf(state.lastGoodEndpoint), 1); eps.unshift(state.lastGoodEndpoint); }
    var attempts = [], stop = new AbortController(), t0 = Date.now();
    return new Promise(function (resolve, reject) {
      var done = false, failed = 0, started = 0, timers = [];
      function finish(fn, v) { if (done) return; done = true; timers.forEach(clearTimeout); stop.abort(); fn(v); }
      function startNext() {
        if (done || started >= eps.length) return;
        var ep = eps[started++];
        timers.forEach(clearTimeout);
        if (started < eps.length) timers = [setTimeout(startNext, STAGGER_MS)];
        var a = { endpoint: ep, host: ep.replace(/^https:\/\/([^\/]+).*/, '$1'), result: 'pending', ms: null }, s = Date.now();
        attempts.push(a);
        fetchWithTimeout(ep, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(queryText) }, ATTEMPT_MS, stop.signal)
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.text();
          })
          .then(function (txt) {
            var json; try { json = JSON.parse(txt); } catch (e) { throw new Error('not JSON (' + txt.slice(0, 40).replace(/\s+/g, ' ') + ')'); }
            var els = Data.checkResponse(json);
            a.ms = Date.now() - s; a.result = 'ok';
            finish(resolve, { elements: els, endpoint: ep, ms: Date.now() - t0, attempts: attempts, remark: json.remark || null });
          })
          .catch(function (e) {
            if (done) { if (a.result === 'pending') a.result = 'cancelled'; return; }
            a.ms = Date.now() - s; a.result = (e && e.name === 'AbortError') ? 'timeout' : (e && e.message) || 'error';
            failed++;
            if (failed >= eps.length) finish(reject, Object.assign(new Error('all ' + eps.length + ' Overpass mirrors failed (' + attempts.map(function (x) { return x.host + ': ' + x.result; }).join(', ') + ')'), { attempts: attempts }));
            else startNext(); // a mirror failed: start the next one immediately
          });
      }
      startNext();
    });
  }

  // Phase 1: toilets (fast, must succeed). Phase 2: nearby parent features with opening_hours, used to infer
  // hours for toilets with none (best-effort: failure only means no "inferred" hours).
  async function fetchArea(bbox) {
    if (demo) {
      var r0 = await fetch('sample-data.json');
      var els = (await r0.json()).elements;
      return { elements: els, endpoint: 'demo sample-data.json', ms: 0, attempts: [], remark: null, parents: 'demo', afterToilets: function () { return Promise.resolve([]); } };
    }
    var r = await overpass(Data.buildLightQuery(bbox));
    r.afterToilets = function () {
      return overpass(Data.buildParentsQuery(bbox)).then(function (p) {
        r.parents = 'ok via ' + p.endpoint.replace(/^https:\/\/([^\/]+).*/, '$1') + ' in ' + p.ms + ' ms';
        r.attempts = r.attempts.concat(p.attempts);
        return p.elements;
      }, function (e) {
        r.parents = 'FAILED (' + ((e && e.message) || 'error') + ')';
        r.attempts = r.attempts.concat((e && e.attempts) || []);
        return [];
      });
    };
    return r;
  }

  function ingest(elements) {
    var n = Data.normalise(elements);
    var added = Data.mergeInto(state.store, n.toilets);
    n.parents.forEach(function (p) { state.parents[p.id] = p; });
    recomputeInferred();
    return { added: added, count: n.toilets.length };
  }
  function recomputeInferred() {
    var ps = Object.keys(state.parents).map(function (k) { return state.parents[k]; });
    Object.keys(state.store).forEach(function (k) {
      var t = state.store[k];
      t.inferred = t.hours ? null : Data.inferHours(t, ps);
    });
  }
  function storeList() { return Object.keys(state.store).map(function (k) { return state.store[k]; }); }

  function saveCache() {
    var ts = storeList();
    if (!ts.length) return;
    var used = {};
    ts.forEach(function (t) { if (t.inferred) used[t.inferred.id] = 1; });
    save(LS.cache, { at: Date.now(), pos: state.pos, toilets: ts.slice(0, 400), parents: Object.keys(used).map(function (k) { return state.parents[k]; }).filter(Boolean), covered: state.covered.slice(-6) });
  }

  // Load bbox (queued if a fetch is in flight). opts.force ignores coverage.
  function loadBbox(bbox, opts) {
    opts = opts || {};
    if (!opts.force && state.covered.some(function (c) { return Data.bboxContains(c, bbox); })) return Promise.resolve();
    if (state.busy) { state.pending = { bbox: bbox, opts: opts }; return Promise.resolve(); }
    state.busy = true; state.error = null;
    setStatus();
    var t0 = Date.now();
    return fetchArea(bbox).then(function (r) {
      var res = ingest(r.elements);
      state.covered.push(bbox);
      state.fromCache = false;
      var d = state.diag;
      d.endpoint = r.endpoint; d.at = Date.now(); d.ms = r.ms; d.fetched = res.count; d.bbox = Data.bboxStr(bbox);
      d.attempts = r.attempts; d.fetches++; d.parents = demo ? 'demo' : 'loading…'; d.lastError = r.remark ? 'server remark: ' + r.remark : null;
      if (r.endpoint && !demo) state.lastGoodEndpoint = r.endpoint;
      saveCache();
      state.busy = false; setStatus(); render(); // toilets are on screen now; parent hours come next
      state.busy = true;
      return r.afterToilets().then(function (pels) {
        d.parents = r.parents; d.attempts = r.attempts;
        if (pels && pels.length) { var n = Data.normalise(pels); n.parents.forEach(function (p) { state.parents[p.id] = p; }); recomputeInferred(); saveCache(); }
      });
    }).catch(function (e) {
      state.error = (e && e.message) || 'fetch failed';
      state.diag.lastError = state.error + ' at ' + new Date().toLocaleTimeString();
      state.diag.attempts = (e && e.attempts) || state.diag.attempts;
      if (!storeList().length) loadCacheFallback();
    }).then(function () {
      state.busy = false;
      var p = state.pending; state.pending = null;
      setStatus(); render();
      if (p) return loadBbox(p.bbox, p.opts);
    });
  }

  function loadCacheFallback() {
    var c = load(LS.cache, null);
    if (!c || !(c.toilets || []).length) return;
    Data.mergeInto(state.store, c.toilets);
    (c.parents || []).forEach(function (p) { state.parents[p.id] = p; });
    recomputeInferred();
    state.fromCache = c.at;
    if (c.pos) { state.ref = c.pos; state.usingFallback = false; state.pos = c.pos; }
  }

  // ---- fresh tags for one object, from the OSM API (as you open a toilet) ----
  function refreshObject(id) {
    var t = state.store[id], chk = state.diag.objectChecks;
    if (!t || demo || id.indexOf('/') < 0) return Promise.resolve();
    if (chk[id] && Date.now() - chk[id].at < 5 * 60000) return Promise.resolve();
    chk[id] = { at: Date.now(), result: 'checking' };
    return fetchWithTimeout('https://api.openstreetmap.org/api/0.6/' + id + '.json', {}, 8000)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        var el = (j.elements || [])[0];
        if (!el || !el.tags) throw new Error('no tags');
        var n = Data.normalise([Object.assign({ center: { lat: t.lat, lon: t.lon } }, el)]).toilets[0];
        if (n) {
          var changed = n.hours !== t.hours;
          n.lat = t.lat; n.lon = t.lon;
          state.store[id] = n;
          recomputeInferred();
          chk[id] = { at: Date.now(), result: changed ? 'hours updated' : 'unchanged' };
        } else chk[id] = { at: Date.now(), result: 'no longer amenity=toilets' };
      })
      .catch(function (e) { chk[id] = { at: Date.now(), result: 'failed: ' + e.message }; })
      .then(function () { render(); if (!$('sheet').hidden && $('sheet').dataset.id === id && $('sheet').dataset.mode !== 'diag') openSheet(id, true); });
  }

  // ---- view model ----
  function shorten(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  function decorate(t) {
    var rep = getReports(t.id), now = new Date();
    var mine = getMyHours(t.id);
    var status, label, src, rankStatus, oh;
    if (t.hours) {
      src = 'osm'; oh = Hours.openNow(t.hours, now, t);
      status = oh.status; label = oh.status === 'unknown' ? 'Hours: ' + shorten(t.hours, 40) : oh.label;
    } else if (mine) {
      src = 'you'; oh = Hours.openNow(mine.text, now, t);
      status = oh.status; label = (oh.status === 'unknown' ? 'Hours (yours): ' + shorten(mine.text, 34) : oh.label + ' · your hours');
      rankStatus = 'unknown';
    } else if (t.inferred) {
      src = 'inferred'; oh = Hours.openNow(t.inferred.hours, now, t);
      status = oh.status; rankStatus = 'unknown';
      label = oh.status === 'unknown' ? 'Hours not listed · nearby ' + shorten(t.inferred.from, 24) + ': ' + shorten(t.inferred.hours, 24)
        : oh.label + ' · inferred from nearby ' + shorten(t.inferred.from, 28);
    } else {
      src = 'none'; status = 'unknown'; label = 'Hours not listed in OpenStreetMap';
    }
    if (rep.closed) { status = 'closed'; label = 'Reported closed (by you)'; rankStatus = null; }
    return Object.assign({}, t, {
      status: status, rankStatus: rankStatus || status, hoursLabel: label, hoursSrc: src, hoursApprox: !!(oh && oh.approx),
      avg: avgRating(t.id), ratingCount: getRatings(t.id).length,
      distance: Rank.haversine(state.ref.lat, state.ref.lon, t.lat, t.lon), reports: rep
    });
  }

  function visible() {
    var items = storeList().map(decorate).filter(function (t) { return t.distance <= Math.max(RADIUS, mapRadius()); });
    if (state.filters.accessible) items = items.filter(function (t) { return t.wheelchair === 'yes'; });
    if (state.filters.urinals) items = items.filter(function (t) { return t.fac && t.fac.urinal; });
    return Rank.rank(items).slice(0, LIST_MAX);
  }
  function mapRadius() {
    if (!state.map) return 0;
    var b = state.map.getBounds();
    return Rank.haversine(b.getCenter().lat, b.getCenter().lng, b.getNorth(), b.getEast()) * 1.0;
  }

  function feeLabel(t) { return t.fee === 'yes' ? 'Paid' : t.fee === 'no' ? 'Free' : 'Fee unknown'; }
  function facIcons(t, size) {
    return Facilities.badges(t.fac).map(function (n) { return '<span class="fac' + (n === 'accessibleLimited' ? ' limited' : '') + '">' + Icons.svg(n, { size: size || 18 }) + '</span>'; }).join('');
  }
  function facRow(t, size) { var h = facIcons(t, size); return h ? '<span class="facs">' + h + '</span>' : ''; }
  function emptyMsg() {
    if (state.error) return 'Could not load toilets: ' + esc(state.error) + '. Tap Retry above.';
    if (state.busy) return 'Loading toilets…';
    var f = [];
    if (state.filters.accessible) f.push('accessible');
    if (state.filters.urinals) f.push('urinals');
    return 'No toilets found' + (f.length ? ' with the ' + f.join(' + ') + ' filter on' : ' here') + '. Try "Search this area" after moving the map.';
  }
  function pillClass(t) { return t.status + (t.hoursSrc === 'inferred' || t.hoursSrc === 'you' || t.hoursApprox ? ' soft' : '') + (t.hoursSrc === 'none' ? ' none' : ''); }

  function render() {
    var items = visible();
    var ul = $('list');
    if (!items.length) {
      ul.innerHTML = '<li class="empty">' + emptyMsg() + '</li>';
    } else {
      ul.innerHTML = items.map(function (t) {
        return '<li class="card" data-id="' + esc(t.id) + '" tabindex="0">' +
          '<div class="row"><span class="name">' + esc(t.name) + '</span><span class="dist">' + Rank.formatDistance(t.distance) + '</span></div>' +
          '<div class="meta"><span class="pill ' + pillClass(t) + '">' + esc(t.hoursLabel) + '</span>' +
          '<span class="pill">' + (t.avg == null ? 'unrated' : '★ ' + Rank.ratingLabel(t.avg, t.ratingCount)) + '</span>' +
          '<span class="pill">' + feeLabel(t) + '</span>' + facRow(t) +
          (t.reports.broken ? '<span class="pill warn">Reported broken</span>' : '') + '</div></li>';
      }).join('');
    }
    renderMap(items);
    setStatus();
  }

  // ---- map ----
  function initMap() {
    if (typeof L === 'undefined') { $('map').innerHTML = '<p class="empty">Map unavailable offline.</p>'; return; }
    state.map = L.map('map').setView([state.pos.lat, state.pos.lon], 15);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(state.map);
    state.markers = L.layerGroup().addTo(state.map);
    var timer = null;
    state.map.on('dragstart zoomstart', function () { state.userMoved = true; });
    state.map.on('moveend', function () {
      clearTimeout(timer);
      timer = setTimeout(onViewChanged, 800); // debounce
    });
  }
  function currentView() {
    var b = state.map.getBounds();
    return { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() };
  }
  function onViewChanged(force) {
    if (!state.map || !state.ready) return; // wait for the first location fix + load
    if (state.userMoved) { var c = state.map.getCenter(); state.ref = { lat: c.lat, lon: c.lng }; }
    if (state.map.getZoom() < MIN_ZOOM) { render(); setStatus(); return; }
    loadBbox(Data.clampBbox(Data.padBbox(currentView(), 0.25), MAX_SPAN), { force: force === true });
    render();
  }
  function renderMap(items) {
    if (!state.map) return;
    state.markers.clearLayers();
    if (state.meMarker) state.map.removeLayer(state.meMarker);
    state.meMarker = L.marker([state.pos.lat, state.pos.lon], { icon: L.divIcon({ className: '', html: '<div class="pin me"></div>', iconSize: [16, 16] }), title: state.usingFallback ? 'Default location (Hackney)' : 'You are here' }).addTo(state.map);
    items.forEach(function (t) {
      var m = L.marker([t.lat, t.lon], { icon: L.divIcon({ className: '', html: '<div class="pin ' + t.rankStatus + (t.hoursSrc === 'none' ? ' none' : '') + '">' + Icons.svg(t.wheelchair === 'yes' ? 'accessible' : (t.fac && t.fac.urinal && !t.fac.female && !t.fac.unisex) ? 'urinal' : 'unisex', { size: 16, label: t.name }) + '</div>', iconSize: [26, 26] }), title: t.name });
      m.on('click', function () { openSheet(t.id); });
      m.addTo(state.markers);
    });
  }

  // ---- detail sheet ----
  function sheetFacilities(t) {
    var b = Facilities.badges(t.fac);
    var out = b.map(function (n) { return '<span class="fac-line">' + Icons.svg(n, { size: 22 }) + '<span>' + Icons.labels[n] + '</span></span>'; });
    if (t.wheelchair === 'no') out.push('<span class="fac-line muted">Not wheelchair accessible</span>');
    else if (!t.wheelchair) out.push('<span class="fac-line muted">Wheelchair access unknown</span>');
    return out.join('');
  }
  function hoursBlock(t) {
    var h = '';
    var chk = state.diag.objectChecks[t.id];
    if (t.hours) {
      h += '<div><strong>' + esc(t.hours) + '</strong></div>';
      if (t.hoursChecked) h += '<div class="hint">Hours last checked on OpenStreetMap: ' + esc(t.hoursChecked) + '</div>';
      if (t.hoursApprox) h += '<div class="hint">Sunrise/sunset/dusk times are approximate (calculated for this location).</div>';
    } else {
      h += '<div>Hours not listed in OpenStreetMap.</div>';
      if (t.inferred) {
        h += '<div class="inferred"><strong>Inferred from nearby ' + esc(t.inferred.from) + '</strong> (' + esc(t.inferred.kind ? t.inferred.kind.replace('=', ': ') : 'feature') + ', ' + t.inferred.distance + ' m away): ' + esc(t.inferred.hours) +
          '<div class="hint">This is a guess: the toilets may follow the same hours as the place around them, but nobody has confirmed it.</div></div>';
      }
    }
    var mine = getMyHours(t.id);
    if (mine) h += '<div class="mine">Your hours: <strong>' + esc(mine.text) + '</strong> <span class="hint">(saved on this device only' + (t.hours ? '; OpenStreetMap hours take priority' : '') + ')</span></div>';
    if (chk) h += '<div class="hint">OSM live check: ' + esc(chk.result) + '</div>';
    return h;
  }
  function osmLinks(t) {
    var base = 'https://www.openstreetmap.org/' + t.id;
    return '<a class="btn" target="_blank" rel="noopener" href="' + esc(base) + '">View on OSM</a>' +
      '<a class="btn" target="_blank" rel="noopener" href="https://www.openstreetmap.org/edit?editor=id&amp;' + esc(t.id.replace('/', '=')) + '">Improve on OpenStreetMap</a>';
  }
  function openSheet(id, keepScroll) {
    var t = visible().filter(function (x) { return x.id === id; })[0] || (state.store[id] && decorate(state.store[id]));
    if (!t) return;
    var mine = getRatings(id)[0], my = getMyHours(id);
    var stars = [1, 2, 3, 4, 5].map(function (n) { return '<button data-star="' + n + '" class="' + (mine === n ? 'sel' : '') + '" aria-label="Rate ' + n + ' out of 5">' + n + '</button>'; }).join('');
    var inner = $('sheetBody').parentNode, top = inner.scrollTop;
    $('sheetBody').innerHTML =
      '<h2>' + esc(t.name) + '</h2>' +
      '<div class="meta"><span class="pill ' + pillClass(t) + '">' + esc(t.hoursLabel) + '</span><span class="pill">' + feeLabel(t) + '</span></div>' +
      '<dl><dt>Distance</dt><dd>' + Rank.formatDistance(t.distance) + '</dd>' +
      '<dt>Cleanliness</dt><dd>' + (t.avg == null ? 'unrated' : Rank.ratingLabel(t.avg, t.ratingCount) + ' (' + t.ratingCount + ' rating' + (t.ratingCount > 1 ? 's' : '') + ' on this device)') + '</dd>' +
      '<dt>Hours</dt><dd>' + hoursBlock(t) + '</dd>' +
      (t.access ? '<dt>Access</dt><dd>' + esc(t.access) + '</dd>' : '') +
      '<dt>Facilities</dt><dd>' + sheetFacilities(t) + '</dd>' +
      (t.operator ? '<dt>Operator</dt><dd>' + esc(t.operator) + '</dd>' : '') + '</dl>' +
      '<div class="addhours"><label for="hoursIn"><strong>' + (t.hours ? 'Think the hours are wrong?' : 'Add hours') + '</strong></label>' +
      '<div class="hrow"><input id="hoursIn" type="text" inputmode="text" autocomplete="off" autocapitalize="off" placeholder="e.g. Mo-Su 08:00-20:00" value="' + esc(my ? my.text : '') + '">' +
      '<button class="btn" data-savehours="1">Save</button>' + (my ? '<button class="btn" data-clearhours="1">Clear</button>' : '') + '</div>' +
      '<div class="hint" id="hoursMsg">Saved on this device only. Use OpenStreetMap format (Mo-Fr 07:00-19:00; Sa,Su 09:00-17:00, or 24/7), or free text. To fix it for everyone use "Improve on OpenStreetMap".</div></div>' +
      '<strong>Rate cleanliness</strong><div class="stars">' + stars + '</div><div class="hint">1 = grim, 5 = spotless. Anonymous; saved on this device.</div>' +
      '<div class="actions"><button class="btn danger ' + (t.reports.closed ? 'on' : '') + '" data-report="closed">' + (t.reports.closed ? '✓ Reported closed' : 'Report closed') + '</button>' +
      '<button class="btn danger ' + (t.reports.broken ? 'on' : '') + '" data-report="broken">' + (t.reports.broken ? '✓ Reported broken' : 'Report broken') + '</button>' +
      osmLinks(t) + '</div>';
    $('sheet').dataset.id = id; $('sheet').dataset.mode = 'toilet';
    $('sheet').hidden = false;
    if (keepScroll) inner.scrollTop = top;
    if (!keepScroll) refreshObject(id);
  }
  function closeSheet() { $('sheet').hidden = true; }
  function saveHoursFromSheet() {
    var id = $('sheet').dataset.id, v = $('hoursIn').value.trim();
    setMyHours(id, v);
    render(); openSheet(id, true);
    var p = v && Hours.parse(v);
    $('hoursMsg').textContent = !v ? 'Cleared.' : p.ok ? 'Saved on this device. Understood as: ' + Hours.openNow(v, new Date(), state.store[id]).label + '.' : 'Saved as free text (could not read it as a schedule, so no open/closed status).';
  }

  // ---- diagnostics ("Data status": tap the logo 5 times, or the footer link) ----
  function ago(ts) { if (!ts) return 'never'; var s = Math.round((Date.now() - ts) / 1000); return new Date(ts).toLocaleTimeString() + ' (' + (s < 90 ? s + ' s' : Math.round(s / 60) + ' min') + ' ago)'; }
  function diagText() {
    var d = state.diag, st = Data.stats(storeList()), mine = load(LS.hours, {});
    var myCount = storeList().filter(function (t) { return !t.hours && mine[t.id]; }).length;
    var lines = [
      'Toilet Finder ' + APP_VERSION + (demo ? ' (DEMO data)' : ''),
      'Endpoint used: ' + (d.endpoint || 'none yet'),
      'Nearby-hours lookup (for inferred hours): ' + (d.parents || 'n/a'),
      'Fetched last time: ' + d.fetched + ' toilets (bbox ' + (d.bbox || 'n/a') + ')',
      'Toilets loaded in total: ' + st.total,
      'With opening_hours in OSM: ' + st.withHours + ' (' + (st.total ? Math.round(100 * st.withHours / st.total) : 0) + '%)',
      'No hours, inferred from nearby feature: ' + st.inferred,
      'No hours at all: ' + (st.total - st.withHours - st.inferred) + ' (you added hours to ' + myCount + ' of these on this device)',
      'Nearby hours-features held: ' + Object.keys(state.parents).length,
      'Fetched at: ' + ago(d.at) + (d.ms != null ? ', took ' + d.ms + ' ms' : ''),
      'Fetches this session: ' + d.fetches + (state.fromCache ? ' · SHOWING SAVED COPY from ' + new Date(state.fromCache).toLocaleString() : ''),
      'Last error: ' + (d.lastError || 'none'),
      'Location: ' + (state.usingFallback ? 'fallback Hackney' : 'device') + ' (' + state.geoNote + ')',
      'Map zoom: ' + (state.map ? state.map.getZoom() : 'n/a') + ', areas loaded: ' + state.covered.length,
      'Mirror attempts: ' + ((d.attempts || []).map(function (a) { return a.host + ' ' + a.result + (a.ms != null ? ' ' + a.ms + 'ms' : ''); }).join('; ') || 'n/a'),
      'Now: ' + new Date().toString()
    ];
    return lines.join('\n');
  }
  function openDiag() {
    $('sheetBody').innerHTML = '<h2>Data status</h2><pre id="diagPre" class="diag">' + esc(diagText()) + '</pre>' +
      '<div class="actions"><button class="btn" data-diag="copy">Copy</button><button class="btn" data-diag="refetch">Re-fetch now</button><button class="btn" data-diag="clear">Clear saved data</button></div>' +
      '<div class="hint" id="diagMsg">Tell Nathan\'s assistant what this says.</div>';
    $('sheet').dataset.mode = 'diag'; $('sheet').dataset.id = '';
    $('sheet').hidden = false;
  }

  // ---- status bar ----
  function setStatus(msgOverride, warn) {
    var s = $('status'), txt, isWarn = false, canRetry = false;
    if (msgOverride) { txt = msgOverride; isWarn = !!warn; }
    else {
      var st = Data.stats(storeList());
      var where = state.usingFallback ? 'Location unavailable – showing Hackney' : 'Near you';
      if (state.map && state.map.getZoom() < MIN_ZOOM) { txt = 'Zoom in to load toilets for this area.'; isWarn = true; }
      else if (state.busy) txt = (storeList().length ? 'Updating opening hours…' : 'Loading toilets…') + (storeList().length ? ' (' + st.total + ' shown)' : '');
      else if (state.error) { txt = 'Could not load toilet data: ' + state.error + (st.total ? ' · showing ' + st.total + (state.fromCache ? ' saved' : ' loaded') + ' toilets' : ''); isWarn = true; canRetry = true; }
      else {
        txt = (demo ? 'DEMO sample data · ' : '') + st.total + ' toilets · ' + st.withHours + ' with hours in OpenStreetMap' + (st.inferred ? ' · ' + st.inferred + ' inferred' : '') +
          (state.userMoved ? ' · distances from map centre' : ' · ' + where);
        isWarn = (state.usingFallback && !state.userMoved) || demo;
      }
      if (state.fromCache && !state.error) { txt += ' · saved copy from ' + new Date(state.fromCache).toLocaleString(); isWarn = true; }
    }
    $('statusText').textContent = txt;
    s.className = isWarn ? 'warn' : '';
    $('retry').hidden = !canRetry;
  }

  // ---- boot ----
  function getPosition() {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) { state.geoNote = 'geolocation unsupported'; return resolve(null); }
      navigator.geolocation.getCurrentPosition(
        function (p) { state.geoNote = 'ok, accuracy ' + Math.round(p.coords.accuracy) + ' m'; resolve({ lat: p.coords.latitude, lon: p.coords.longitude }); },
        function (err) { state.geoNote = 'denied/unavailable: ' + (err && err.message || err && err.code); resolve(null); },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
    });
  }

  async function locate(recentre) {
    setStatus('Finding your location…');
    var p = await getPosition();
    state.usingFallback = !p;
    state.pos = p || state.pos;
    state.ref = state.pos; state.userMoved = false;
    if (state.map) state.map.setView([state.pos.lat, state.pos.lon], Math.max(state.map.getZoom(), 15), { animate: false });
    await loadBbox(Data.bboxAround(state.pos, RADIUS), { force: recentre });
    state.ready = true;
    render();
  }

  document.addEventListener('DOMContentLoaded', function () {
    initMap();
    Array.prototype.forEach.call(document.querySelectorAll('.chip[data-filter]'), function (chip) {
      chip.addEventListener('click', function () {
        var k = chip.dataset.filter;
        state.filters[k] = !state.filters[k];
        chip.setAttribute('aria-pressed', String(state.filters[k]));
        render();
      });
    });
    $('list').addEventListener('click', function (e) { var c = e.target.closest('.card'); if (c) openSheet(c.dataset.id); });
    $('list').addEventListener('keydown', function (e) { if (e.key === 'Enter') { var c = e.target.closest('.card'); if (c) openSheet(c.dataset.id); } });
    $('closeSheet').addEventListener('click', closeSheet);
    $('sheet').addEventListener('click', function (e) { if (e.target === $('sheet')) closeSheet(); });
    $('sheetBody').addEventListener('click', function (e) {
      var id = $('sheet').dataset.id;
      var star = e.target.closest('[data-star]'), rep = e.target.closest('[data-report]');
      if (star) { addRating(id, +star.dataset.star); render(); openSheet(id, true); }
      if (rep) { toggleReport(id, rep.dataset.report); render(); openSheet(id, true); }
      if (e.target.closest('[data-savehours]')) saveHoursFromSheet();
      if (e.target.closest('[data-clearhours]')) { setMyHours(id, ''); render(); openSheet(id, true); }
      var dg = e.target.closest('[data-diag]');
      if (dg) {
        var k = dg.dataset.diag;
        if (k === 'copy') {
          var txt = diagText();
          (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(function () { $('diagMsg').textContent = 'Copied.'; }, function () { $('diagMsg').textContent = 'Could not copy: select the text and copy manually.'; });
        }
        if (k === 'refetch') { closeSheet(); onViewChanged(true); }
        if (k === 'clear') { try { localStorage.removeItem(LS.cache); } catch (x) {} $('diagMsg').textContent = 'Saved list cleared (ratings and your hours are kept).'; }
      }
    });
    $('retry').addEventListener('click', function () { if (state.map && state.map.getZoom() >= MIN_ZOOM) onViewChanged(true); else locate(true); });
    $('searchArea').addEventListener('click', function () { state.userMoved = true; onViewChanged(true); });
    $('locate').addEventListener('click', function () { locate(false); });
    $('diagLink').addEventListener('click', function (e) { e.preventDefault(); openDiag(); });
    var taps = [];
    $('logo').addEventListener('click', function () {
      var n = Date.now(); taps.push(n); taps = taps.filter(function (x) { return n - x < 3000; });
      if (taps.length >= 5) { taps = []; openDiag(); }
    });
    Array.prototype.forEach.call(document.querySelectorAll('.chip-ico[data-icon]'), function (el) { el.innerHTML = Icons.svg(el.dataset.icon, { size: 16 }); });
    locate(true);
    // keep "open now" fresh: every minute, and when the tab comes back to the foreground
    setInterval(function () { if (!document.hidden) render(); }, 60000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) render(); });
    if ('serviceWorker' in navigator && !demo) {
      var had = !!navigator.serviceWorker.controller, reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () { if (had && !reloaded && $('sheet').hidden) { reloaded = true; location.reload(); } });
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
  });

  window.__tf = { state: state, render: render, diagText: diagText };
})();
