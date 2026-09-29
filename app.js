(function () {
  'use strict';
  var HACKNEY = { lat: 51.5450, lon: -0.0553 };
  var RADIUS = 1500;
  var ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  var LS = { cache: 'tf.cache.v2', ratings: 'tf.ratings.v1', reports: 'tf.reports.v1' };
  var demo = /[?&]demo=1/.test(location.search);

  var state = { pos: HACKNEY, usingFallback: true, raw: [], filters: { accessible: false, urinals: false }, map: null, markers: null, meMarker: null };
  var $ = function (id) { return document.getElementById(id); };

  function load(key, dflt) { try { return JSON.parse(localStorage.getItem(key)) || dflt; } catch (e) { return dflt; } }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // ---- ratings & reports (localStorage, keyed by OSM id like "node/123") ----
  function getRatings(id) { return load(LS.ratings, {})[id] || []; }
  function addRating(id, n) {
    var all = load(LS.ratings, {});
    // one anonymous rating per device per toilet: re-rating replaces the previous value
    all[id] = [n];
    save(LS.ratings, all);
  }
  function avgRating(id) {
    var r = getRatings(id);
    if (!r.length) return null;
    return r.reduce(function (a, b) { return a + b; }, 0) / r.length;
  }
  function getReports(id) { return load(LS.reports, {})[id] || {}; }
  function toggleReport(id, kind) {
    var all = load(LS.reports, {});
    var r = all[id] || {};
    if (r[kind]) delete r[kind]; else r[kind] = Date.now();
    all[id] = r;
    save(LS.reports, all);
  }

  // ---- data ----
  function normalise(elements) {
    return elements.map(function (e) {
      var lat = e.lat != null ? e.lat : e.center && e.center.lat;
      var lon = e.lon != null ? e.lon : e.center && e.center.lon;
      if (lat == null || lon == null) return null;
      var t = e.tags || {};
      return {
        id: e.type + '/' + e.id, lat: lat, lon: lon,
        name: t.name || 'Public toilets',
        hours: t.opening_hours || null,
        wheelchair: t.wheelchair || null, // yes | limited | no | null
        fee: t.fee || null,               // yes | no | null
        operator: t.operator || null,
        fac: Facilities.fromTags(t)
      };
    }).filter(Boolean);
  }

  function query(pos) {
    return Facilities.buildQuery(pos, RADIUS);
  }

  function fetchWithTimeout(url, opts, ms) {
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, ms);
    opts.signal = ctl.signal;
    return fetch(url, opts).finally(function () { clearTimeout(t); });
  }

  async function fetchOverpass(pos) {
    if (demo) { var r0 = await fetch('sample-data.json'); return normalise((await r0.json()).elements); }
    var lastErr;
    for (var i = 0; i < ENDPOINTS.length; i++) {
      try {
        var res = await fetchWithTimeout(ENDPOINTS[i], {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query(pos))
        }, 20000);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return normalise((await res.json()).elements || []);
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  // ---- view model ----
  function decorate(t) {
    var rep = getReports(t.id);
    var oh = Hours.openNow(t.hours);
    var status = oh.status, label = oh.label;
    if (rep.closed) { status = 'closed'; label = 'Reported closed (by you)'; }
    var avg = avgRating(t.id);
    return Object.assign({}, t, {
      status: status, hoursLabel: label, avg: avg, ratingCount: getRatings(t.id).length,
      distance: Rank.haversine(state.pos.lat, state.pos.lon, t.lat, t.lon), reports: rep
    });
  }

  function visible() {
    var items = state.raw.map(decorate);
    if (state.filters.accessible) items = items.filter(function (t) { return t.wheelchair === 'yes'; });
    if (state.filters.urinals) items = items.filter(function (t) { return t.fac && t.fac.urinal; });
    return Rank.rank(items);
  }

  function feeLabel(t) { return t.fee === 'yes' ? 'Paid' : t.fee === 'no' ? 'Free' : 'Fee unknown'; }
  // Facility pictograms (man / woman / unisex / urinal / accessible / baby change) as inline SVG
  function facIcons(t, size) {
    return Facilities.badges(t.fac).map(function (n) { return '<span class="fac' + (n === 'accessibleLimited' ? ' limited' : '') + '">' + Icons.svg(n, { size: size || 18 }) + '</span>'; }).join('');
  }
  function facRow(t, size) { var h = facIcons(t, size); return h ? '<span class="facs">' + h + '</span>' : ''; }
  function emptyMsg() {
    var f = [];
    if (state.filters.accessible) f.push('accessible');
    if (state.filters.urinals) f.push('urinals');
    return 'No toilets found' + (f.length ? ' with the ' + f.join(' + ') + ' filter on' : ' nearby') + '.';
  }

  function render() {
    var items = visible();
    var ul = $('list');
    if (!items.length) {
      ul.innerHTML = '<li class="empty">' + emptyMsg() + '</li>';
    } else {
      ul.innerHTML = items.map(function (t) {
        return '<li class="card" data-id="' + esc(t.id) + '" tabindex="0">' +
          '<div class="row"><span class="name">' + esc(t.name) + '</span><span class="dist">' + Rank.formatDistance(t.distance) + '</span></div>' +
          '<div class="meta"><span class="pill ' + t.status + '">' + esc(t.hoursLabel) + '</span>' +
          '<span class="pill">' + (t.avg == null ? 'unrated' : '★ ' + Rank.ratingLabel(t.avg, t.ratingCount)) + '</span>' +
          '<span class="pill">' + feeLabel(t) + '</span>' + facRow(t) +
          (t.reports.broken ? '<span class="pill warn">Reported broken</span>' : '') + '</div></li>';
      }).join('');
    }
    renderMap(items);
  }

  // ---- map ----
  function initMap() {
    if (typeof L === 'undefined') { $('map').innerHTML = '<p class="empty">Map unavailable offline.</p>'; return; }
    state.map = L.map('map').setView([state.pos.lat, state.pos.lon], 15);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(state.map);
    state.markers = L.layerGroup().addTo(state.map);
  }
  function renderMap(items) {
    if (!state.map) return;
    state.markers.clearLayers();
    if (state.meMarker) state.map.removeLayer(state.meMarker);
    state.meMarker = L.marker([state.pos.lat, state.pos.lon], { icon: L.divIcon({ className: '', html: '<div class="pin me"></div>', iconSize: [16, 16] }), title: state.usingFallback ? 'Default location (Hackney)' : 'You are here' }).addTo(state.map);
    items.forEach(function (t) {
      var m = L.marker([t.lat, t.lon], { icon: L.divIcon({ className: '', html: '<div class="pin ' + t.status + '">' + Icons.svg(t.wheelchair === 'yes' ? 'accessible' : (t.fac && t.fac.urinal && !t.fac.female && !t.fac.unisex) ? 'urinal' : 'unisex', { size: 16, label: t.name }) + '</div>', iconSize: [26, 26] }), title: t.name });
      m.on('click', function () { openSheet(t.id); });
      m.addTo(state.markers);
    });
    state.map.setView([state.pos.lat, state.pos.lon], state.map.getZoom());
  }

  // ---- detail sheet ----
  function sheetFacilities(t) {
    var b = Facilities.badges(t.fac);
    var out = b.map(function (n) { return '<span class="fac-line">' + Icons.svg(n, { size: 22 }) + '<span>' + Icons.labels[n] + '</span></span>'; });
    if (t.wheelchair === 'no') out.push('<span class="fac-line muted">Not wheelchair accessible</span>');
    else if (!t.wheelchair) out.push('<span class="fac-line muted">Wheelchair access unknown</span>');
    return out.join('');
  }
  function openSheet(id) {
    var t = visible().filter(function (x) { return x.id === id; })[0] || state.raw.map(decorate).filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    var mine = getRatings(id)[0];
    var stars = [1, 2, 3, 4, 5].map(function (n) { return '<button data-star="' + n + '" class="' + (mine === n ? 'sel' : '') + '" aria-label="Rate ' + n + ' out of 5">' + n + '</button>'; }).join('');
    $('sheetBody').innerHTML =
      '<h2>' + esc(t.name) + '</h2>' +
      '<div class="meta"><span class="pill ' + t.status + '">' + esc(t.hoursLabel) + '</span><span class="pill">' + feeLabel(t) + '</span></div>' +
      '<dl><dt>Distance</dt><dd>' + Rank.formatDistance(t.distance) + '</dd>' +
      '<dt>Cleanliness</dt><dd>' + (t.avg == null ? 'unrated' : Rank.ratingLabel(t.avg, t.ratingCount) + ' (' + t.ratingCount + ' rating' + (t.ratingCount > 1 ? 's' : '') + ' on this device)') + '</dd>' +
      '<dt>Hours</dt><dd>' + (t.hours ? esc(t.hours) : 'not listed') + '</dd>' +
      '<dt>Facilities</dt><dd>' + sheetFacilities(t) + '</dd>' +
      (t.operator ? '<dt>Operator</dt><dd>' + esc(t.operator) + '</dd>' : '') + '</dl>' +
      '<strong>Rate cleanliness</strong><div class="stars">' + stars + '</div><div class="hint">1 = grim, 5 = spotless. Anonymous; saved on this device.</div>' +
      '<div class="actions"><button class="btn danger ' + (t.reports.closed ? 'on' : '') + '" data-report="closed">' + (t.reports.closed ? '✓ Reported closed' : 'Report closed') + '</button>' +
      '<button class="btn danger ' + (t.reports.broken ? 'on' : '') + '" data-report="broken">' + (t.reports.broken ? '✓ Reported broken' : 'Report broken') + '</button>' +
      '<a class="btn" target="_blank" rel="noopener" href="https://www.openstreetmap.org/' + esc(t.id) + '">View on OSM</a></div>';
    $('sheet').dataset.id = id;
    $('sheet').hidden = false;
  }
  function closeSheet() { $('sheet').hidden = true; }

  // ---- status ----
  function setStatus(msg, warn) { var s = $('status'); s.textContent = msg; s.className = warn ? 'warn' : ''; }

  // ---- boot ----
  function getPosition() {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        function (p) { resolve({ lat: p.coords.latitude, lon: p.coords.longitude }); },
        function () { resolve(null); },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
    });
  }

  async function refresh() {
    setStatus('Finding your location…');
    var p = await getPosition();
    state.usingFallback = !p;
    state.pos = p || HACKNEY;
    var prefix = p ? 'Near you' : 'Location unavailable – showing Hackney';
    setStatus(prefix + ' · loading toilets…', !p);
    try {
      state.raw = await fetchOverpass(state.pos);
      save(LS.cache, { pos: state.pos, at: Date.now(), items: state.raw });
      setStatus(prefix + (demo ? ' · DEMO sample data' : '') + ' · ' + state.raw.length + ' toilets within ' + (RADIUS / 1000) + ' km', !p || demo);
    } catch (e) {
      var c = load(LS.cache, null);
      if (c && c.items) {
        state.raw = c.items;
        // Distances are measured from where the cached data was fetched, so use that position.
        state.pos = c.pos; state.usingFallback = false;
        setStatus('Offline or Overpass unreachable – showing saved list from ' + new Date(c.at).toLocaleString(), true);
      } else {
        state.raw = [];
        setStatus('Could not load toilet data (no connection and nothing saved yet).', true);
      }
    }
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
      if (star) { addRating(id, +star.dataset.star); render(); openSheet(id); }
      if (rep) { toggleReport(id, rep.dataset.report); render(); openSheet(id); }
    });
    Array.prototype.forEach.call(document.querySelectorAll('.chip-ico[data-icon]'), function (el) { el.innerHTML = Icons.svg(el.dataset.icon, { size: 16 }); });
    refresh();
    setInterval(function () { if (!document.hidden) render(); }, 60000); // keep "open now" fresh
    if ('serviceWorker' in navigator && !demo) navigator.serviceWorker.register('sw.js').catch(function () {});
  });

  window.__tf = { state: state, render: render };
})();
