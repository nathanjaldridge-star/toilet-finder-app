(function () {
  'use strict';
  var APP_VERSION = 'tf-v4';
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
    filters: { open: false, accessible: false, urinals: false }, selected: null,
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

  // Hedged request across mirrors (shared with the Android app: lib/overpass.js).
  var client = Overpass.create({ staggerMs: STAGGER_MS, attemptMs: ATTEMPT_MS });
  function overpass(queryText) { return client.query(queryText); }

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

  // Hours precedence, status and labels are shared with the Android app (lib/present.js).
  function decorate(t) {
    return Present.decorate(t, state.ref, { now: new Date(), mine: getMyHours(t.id), reports: getReports(t.id), ratings: getRatings(t.id) });
  }

  function visible() {
    var items = storeList().map(decorate).filter(function (t) { return t.distance <= Math.max(RADIUS, mapRadius()); });
    items = Present.applyFilters(items, state.filters);
    if (state.filters.open) items = items.filter(function (t) { return t.status === 'open'; });
    return Rank.rank(items).slice(0, LIST_MAX);
  }
  function mapRadius() {
    if (!state.map) return 0;
    var b = state.map.getBounds();
    return Rank.haversine(b.getCenter().lat, b.getCenter().lng, b.getNorth(), b.getEast()) * 1.0;
  }

  var feeLabel = Present.feeLabel;
  function walkMin(m) { return Math.max(1, Math.round(m / 80)); }
  function starsHtml(avg) {
    if (avg == null) return '<span class="unrated">Not rated</span>';
    var f = Math.round(avg);
    return '<span class="stars" aria-label="Cleanliness ' + avg.toFixed(1) + ' out of 5">' + '★'.repeat(f) + '<i>' + '★'.repeat(5 - f) + '</i><b>' + avg.toFixed(1) + '</b></span>';
  }
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
    if (state.filters.open) f.push('open now');
    return 'No toilets found' + (f.length ? ' with the ' + f.join(' + ') + ' filter on' : ' here') + '. Try "Search this area" after moving the map.';
  }
  function pillClass(t) { return 'status ' + (t.hoursSrc === 'none' ? 'none' : t.status) + (t.hoursSrc === 'inferred' || t.hoursSrc === 'you' || t.hoursApprox ? ' soft' : ''); }

  function render() {
    var items = visible();
    var ul = $('list');
    if (!items.length) {
      ul.innerHTML = '<li class="empty"><img src="icons/logo.svg" width="64" height="64" alt="">' + emptyMsg() + '</li>';
    } else {
      ul.innerHTML = items.map(function (t, i) {
        return '<li class="card" data-id="' + esc(t.id) + '" tabindex="0" aria-label="' + esc(t.name + ', ' + Rank.formatDistance(t.distance) + ', ' + t.hoursLabel) + '">' +
          '<div class="row"><span class="num">' + (i + 1) + '</span><div class="who"><div class="name">' + esc(t.name) + '</div>' +
          '<div class="sub">' + esc([t.operator, feeLabel(t)].filter(Boolean).join(' · ')) + '</div></div>' +
          '<div class="dist"><b>' + Rank.formatDistance(t.distance) + '</b><small>~' + walkMin(t.distance) + ' min walk</small></div></div>' +
          '<div class="meta"><span class="pill ' + pillClass(t) + '" title="' + esc(t.hoursLabel) + '">' + esc(t.hoursShort) + '</span>' +
          starsHtml(t.avg) + facRow(t, 15) +
          (t.reports.broken ? '<span class="pill warn">Reported broken</span>' : '') + '</div></li>';
      }).join('');
    }
    var open = items.filter(function (t) { return t.status === 'open'; }).length;
    $('listTitle').textContent = state.filters.open ? 'Open now' : 'Nearest toilets';
    $('listSub').textContent = (state.userMoved ? 'From map centre' : state.usingFallback ? 'Location off · showing Hackney' : 'Near you') + ' · open first, then cleanest, then closest';
    state.counts = { shown: items.length, open: open };
    renderMap(items);
    setStatus();
  }

  // ---- map ----
  function initMap() {
    if (typeof L === 'undefined') { $('map').innerHTML = '<p class="empty">Map unavailable offline.</p>'; return; }
    state.map = L.map('map', { zoomControl: false }).setView([state.pos.lat, state.pos.lon], 15);
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
    state.meMarker = L.marker([state.pos.lat, state.pos.lon], { icon: L.divIcon({ className: '', html: '<div class="pin me"></div>', iconSize: [18, 18] }), zIndexOffset: 2000, interactive: false, title: state.usingFallback ? 'Default location (Hackney)' : 'You are here' }).addTo(state.map);
    items.forEach(function (t) {
      var sel = t.id === state.selected;
      var m = L.marker([t.lat, t.lon], { icon: L.divIcon({ className: '', html: '<div class="pin ' + t.rankStatus + (t.hoursSrc === 'none' ? ' none' : '') + (sel ? ' sel' : '') + '">' + Icons.svg(Present.pinIcon(t), { size: 16, label: t.name }) + '</div>', iconSize: [30, 30], iconAnchor: [15, 15] }), title: t.name, zIndexOffset: sel ? 1000 : t.rankStatus === 'open' ? 100 : 0 });
      m.on('click', function () { openSheet(t.id); });
      m.addTo(state.markers);
    });
  }

  // ---- detail sheet ----
  function sheetFacilities(t) {
    var b = Facilities.badges(t.fac);
    var out = b.map(function (n) { return '<div class="fac-line' + (n === 'accessibleLimited' ? ' limited' : '') + '"><span class="box">' + Icons.svg(n, { size: 22 }) + '</span><span>' + Icons.labels[n] + '</span></div>'; });
    if (t.wheelchair === 'no') out.push('<div class="fac-line muted">Not wheelchair accessible</div>');
    else if (!t.wheelchair) out.push('<div class="fac-line muted">Wheelchair access unknown</div>');
    if (!b.length) out.push('<div class="hint">No facility tags in OpenStreetMap (unknown, not "none").</div>');
    if (t.access) out.push('<div class="hint">Access: ' + esc(t.access) + '</div>');
    return out.join('');
  }
  function hoursBlock(t) {
    var h = '';
    var chk = state.diag.objectChecks[t.id];
    if (t.hours) {
      h += '<div><strong>' + esc(t.hours) + '</strong></div>';
      h += '<div class="hint">' + esc(t.hoursLabel) + '</div>';
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
    return '<a class="btn ghost" target="_blank" rel="noopener" href="' + esc(base) + '">View on OSM</a>' +
      '<a class="btn ghost" target="_blank" rel="noopener" href="https://www.openstreetmap.org/edit?editor=id&amp;' + esc(t.id.replace('/', '=')) + '">Improve on OSM</a>';
  }
  // Map-tile picture of the spot (OSM tiles via lib/imagery.js). The web build has no Google key, so no Street View.
  function heroHtml(t) {
    var tiles = Imagery.tileGrid({ lat: t.lat, lon: t.lon }, 17);
    return '<div class="hero" aria-hidden="true">' + tiles.map(function (x) {
      return '<img class="tile" alt="" loading="lazy" src="' + x.url + '" style="left:calc(50% + ' + x.left + 'px);top:calc(50% + ' + x.top + 'px)">';
    }).join('') + '<div class="wash"></div><div class="marker"><span><img src="icons/logo.svg" width="32" height="32" alt=""></span><i></i></div>' +
      '<span class="cap">Map view of this spot</span><span class="attr">© OpenStreetMap contributors</span></div>';
  }
  function openSheet(id, keepScroll) {
    var t = visible().filter(function (x) { return x.id === id; })[0] || (state.store[id] && decorate(state.store[id]));
    if (!t) return;
    var mine = getRatings(id)[0], my = getMyHours(id);
    var stars = [1, 2, 3, 4, 5].map(function (n) { return '<button data-star="' + n + '" class="' + (mine === n ? 'sel' : '') + '" aria-pressed="' + (mine === n) + '" aria-label="Rate ' + n + ' out of 5">' + n + '</button>'; }).join('');
    if (state.selected !== id) { state.selected = id; renderMap(visible()); }
    var inner = $('sheetBody').parentNode, top = inner.scrollTop;
    $('sheetBody').innerHTML = heroHtml(t) +
      '<div class="sbody"><div><h2>' + esc(t.name) + '</h2>' +
      '<div class="sub">' + esc([Rank.formatDistance(t.distance) + ' away', '~' + walkMin(t.distance) + ' min walk', feeLabel(t), t.operator].filter(Boolean).join(' · ')) + '</div>' +
      '<div class="meta" style="margin-top:8px"><span class="pill ' + pillClass(t) + '">' + esc(t.hoursLabel) + '</span>' + (t.reports.broken ? '<span class="pill warn">Reported broken</span>' : '') + '</div></div>' +
      '<a class="btn primary" target="_blank" rel="noopener" href="' + esc(Imagery.directionsUrl(t)) + '">➜ Directions</a>' +
      '<div class="section"><h3>Opening hours</h3>' + hoursBlock(t) +
      '<label for="hoursIn"><strong>' + (t.hours ? 'Think the hours are wrong?' : 'Add hours') + '</strong></label>' +
      '<div class="hrow"><input id="hoursIn" type="text" inputmode="text" autocomplete="off" autocapitalize="off" placeholder="e.g. Mo-Su 08:00-20:00" value="' + esc(my ? my.text : '') + '">' +
      '<button class="btn" data-savehours="1">Save</button>' + (my ? '<button class="btn" data-clearhours="1">Clear</button>' : '') + '</div>' +
      '<div class="hint" id="hoursMsg">Saved on this device only. OpenStreetMap format (Mo-Fr 07:00-19:00; Sa,Su 09:00-17:00, or 24/7) or free text. To fix it for everyone use "Improve on OSM".</div></div>' +
      '<div class="section"><h3>Facilities</h3>' + sheetFacilities(t) + '</div>' +
      '<div class="section"><h3>Cleanliness</h3>' + starsHtml(t.avg) + (t.ratingCount ? ' <span class="hint">(' + t.ratingCount + ' rating on this device)</span>' : '') +
      '<div class="rate">' + stars + '</div><div class="hint">1 = grim, 5 = spotless. Anonymous; saved on this device.</div></div>' +
      '<div class="actions"><button class="btn danger ' + (t.reports.closed ? 'on' : '') + '" data-report="closed">' + (t.reports.closed ? '✓ Reported closed' : 'Report closed') + '</button>' +
      '<button class="btn danger ' + (t.reports.broken ? 'on' : '') + '" data-report="broken">' + (t.reports.broken ? '✓ Reported broken' : 'Report broken') + '</button>' +
      osmLinks(t) + '</div><div class="hint">Data © OpenStreetMap contributors · ' + esc(t.id) + '</div></div>';
    $('sheet').dataset.id = id; $('sheet').dataset.mode = 'toilet';
    $('sheet').hidden = false;
    if (keepScroll) inner.scrollTop = top;
    if (!keepScroll) refreshObject(id);
  }
  function closeSheet() { $('sheet').hidden = true; if (state.selected) { state.selected = null; renderMap(visible()); } }
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
    $('sheetBody').innerHTML = '<div class="pad"><h2>Data status</h2><pre id="diagPre" class="diag">' + esc(diagText()) + '</pre>' +
      '<div class="actions"><button class="btn" data-diag="copy">Copy</button><button class="btn" data-diag="refetch">Re-fetch now</button><button class="btn" data-diag="clear">Clear saved data</button></div>' +
      '<div class="hint" id="diagMsg">Tell Nathan\'s assistant what this says.</div></div>';
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
      else if (state.busy) txt = storeList().length ? 'Updating opening hours…' : 'Finding toilets…';
      else if (state.error) { txt = 'Couldn’t load toilet data' + (st.total ? ' · showing ' + (state.fromCache ? 'saved' : 'loaded') + ' list' : ''); isWarn = true; canRetry = true; $('status').title = state.error; }
      else {
        var c = state.counts || { shown: 0, open: 0 };
        txt = (demo ? 'DEMO · ' : '') + c.shown + ' nearby · ' + c.open + ' open now' + (state.usingFallback && !state.userMoved ? ' · ' + where : '');
        isWarn = (state.usingFallback && !state.userMoved) || demo;
      }
      if (state.fromCache && !state.error) { txt += ' · saved copy'; isWarn = true; }
    }
    if (!s.querySelector('.dot')) s.insertAdjacentHTML('afterbegin', '<span class="dot"></span>');
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
    $('locate').classList.add('busy');
    var p = await getPosition();
    $('locate').classList.remove('busy');
    state.usingFallback = !p;
    state.pos = p || state.pos;
    state.ref = state.pos; state.userMoved = false;
    if (state.map) { var z = Math.max(state.map.getZoom(), 15); var pt = state.map.project([state.pos.lat, state.pos.lon], z).add([0, panelOffset() / 2]); state.map.setView(state.map.unproject(pt, z), z, { animate: false }); }
    await loadBbox(Data.bboxAround(state.pos, RADIUS), { force: recentre });
    state.ready = true;
    render();
  }

  // ---- bottom sheet (phones): drag the header between peek / half / full ----
  var SNAPS = { peek: 0.2, half: 0.48, full: 1 };
  function panelOffset() { return window.innerWidth >= 900 ? 0 : panelPx($('panel').dataset.snap); }
  function panelPx(snap) { var full = window.innerHeight - 140; return snap === 'full' ? full : Math.min(full, Math.round(window.innerHeight * SNAPS[snap])); }
  function setSnap(snap) {
    var p = $('panel'); p.dataset.snap = snap;
    document.documentElement.style.setProperty('--panelH', panelPx(snap) + 'px');
  }
  function initPanel() {
    var head = $('panelHead'), p = $('panel'), startY = 0, startH = 0, dragging = false, moved = false;
    setSnap('half');
    head.addEventListener('pointerdown', function (e) { if (window.innerWidth >= 900) return; dragging = true; moved = false; startY = e.clientY; startH = panelPx(p.dataset.snap); p.classList.add('dragging'); head.setPointerCapture(e.pointerId); });
    head.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var h = Math.max(panelPx('peek') * 0.8, Math.min(panelPx('full'), startH - (e.clientY - startY)));
      if (Math.abs(e.clientY - startY) > 4) moved = true;
      document.documentElement.style.setProperty('--panelH', h + 'px');
    });
    function end(e) {
      if (!dragging) return; dragging = false; p.classList.remove('dragging');
      if (!moved) { setSnap(p.dataset.snap === 'peek' ? 'half' : p.dataset.snap === 'half' ? 'full' : 'half'); return; }
      var h = startH - (e.clientY - startY), best = 'half', bd = Infinity;
      ['peek', 'half', 'full'].forEach(function (k) { var d = Math.abs(panelPx(k) - h); if (d < bd) { bd = d; best = k; } });
      setSnap(best);
    }
    head.addEventListener('pointerup', end); head.addEventListener('pointercancel', end);
    window.addEventListener('resize', function () { setSnap(p.dataset.snap); });
  }

  document.addEventListener('DOMContentLoaded', function () {
    initPanel();
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
