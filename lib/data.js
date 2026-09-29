// Data layer: Overpass queries, response validation, normalising elements, inferring opening hours
// from nearby "parent" features (park, station, library...), and merging results as the map moves.
(function (root) {
  var Fac = (typeof require !== 'undefined' && typeof module !== 'undefined') ? require('./facilities.js') : root.Facilities;

  // Mirrors in preference order. All send Access-Control-Allow-Origin: * (checked with curl).
  // overpass.osm.ch is deliberately absent: it only covers Switzerland.
  var ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.openstreetmap.fr/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
  ];

  // ---- bounding boxes: {s,w,n,e} ----
  function bboxAround(pos, radiusM) {
    var dLat = radiusM / 111320, dLon = radiusM / (111320 * Math.cos(pos.lat * Math.PI / 180));
    return { s: pos.lat - dLat, w: pos.lon - dLon, n: pos.lat + dLat, e: pos.lon + dLon };
  }
  function padBbox(b, f) {
    var h = (b.n - b.s) * f, w = (b.e - b.w) * f;
    return { s: b.s - h, w: b.w - w, n: b.n + h, e: b.e + w };
  }
  // Keep a query box at most `max` degrees per side (around its centre) so one query stays cheap.
  function clampBbox(b, max) {
    var cLat = (b.s + b.n) / 2, cLon = (b.w + b.e) / 2;
    var h = Math.min(b.n - b.s, max) / 2, w = Math.min(b.e - b.w, max * 1.6) / 2;
    return { s: cLat - h, w: cLon - w, n: cLat + h, e: cLon + w };
  }
  function bboxContains(outer, inner) {
    return outer.s <= inner.s && outer.w <= inner.w && outer.n >= inner.n && outer.e >= inner.e;
  }
  function inBbox(b, lat, lon) { return lat >= b.s && lat <= b.n && lon >= b.w && lon <= b.e; }
  function r5(x) { return Math.round(x * 100000) / 100000; }
  function bboxStr(b) { return [r5(b.s), r5(b.w), r5(b.n), r5(b.e)].join(','); }

  // ---- queries ----
  // Two queries per area so toilets show up fast even when a mirror is slow:
  //  1. buildLightQuery: every amenity=toilets nwr in the box. `out center tags bb` gives ways/relations a
  //     centre and bounding box, so no full geometry is needed.
  //  2. buildParentsQuery: candidate "parent" features that carry opening_hours, used to infer hours for toilets
  //     that have none: anything within 60 m of a toilet (the building/shop it is part of), plus park / garden /
  //     station / library / museum / market ... features in the box (`around` measures distance to a polygon's
  //     edge, so a toilet in the middle of a big park would be missed by the 60 m rule alone).
  function buildLightQuery(bbox) {
    return '[out:json][timeout:20];nwr["amenity"="toilets"](' + bboxStr(bbox) + ');out center tags bb;';
  }
  function buildParentsQuery(bbox) {
    var b = bboxStr(bbox);
    return '[out:json][timeout:25];nwr["amenity"="toilets"](' + b + ')->.t;(nwr(around.t:60)["opening_hours"];' +
      'nwr["opening_hours"]["leisure"~"^(park|garden|playground|recreation_ground|nature_reserve|sports_centre|stadium|common|dog_park)$"](' + b + ');' +
      'nwr["opening_hours"]["railway"~"^(station|halt)$"](' + b + ');' +
      'nwr["opening_hours"]["public_transport"="station"](' + b + ');' +
      'nwr["opening_hours"]["amenity"~"^(library|marketplace|community_centre|townhall|bus_station|hospital|theatre|cinema|arts_centre)$"](' + b + ');' +
      'nwr["opening_hours"]["tourism"~"^(museum|gallery|attraction|zoo)$"](' + b + '););out center tags bb;';
  }

  // Overpass can answer HTTP 200 with a runtime error remark and no elements (overloaded/broken mirror).
  // Returns the elements array or throws.
  function checkResponse(json) {
    if (!json || typeof json !== 'object' || !Array.isArray(json.elements)) throw new Error('unexpected response (no elements)');
    if (json.remark && /error|timed out|out of memory/i.test(String(json.remark)) && !json.elements.length) {
      throw new Error('server error: ' + String(json.remark).slice(0, 100));
    }
    return json.elements;
  }

  // ---- normalising ----
  var PARENT_AREA = {
    leisure: ['park', 'garden', 'playground', 'recreation_ground', 'nature_reserve', 'sports_centre', 'stadium', 'common', 'dog_park'],
    amenity: ['library', 'marketplace', 'community_centre', 'townhall', 'theatre', 'cinema', 'arts_centre', 'bus_station', 'ferry_terminal', 'pub', 'bar', 'cafe', 'restaurant', 'fast_food', 'hospital', 'college', 'university', 'school'],
    railway: ['station', 'halt', 'tram_stop', 'subway_entrance'],
    public_transport: ['station'],
    tourism: ['museum', 'gallery', 'attraction', 'zoo', 'theme_park', 'information'],
    shop: ['mall', 'supermarket', 'department_store', 'convenience', 'general'],
    building: ['retail', 'commercial', 'supermarket', 'train_station', 'public', 'civic', 'museum', 'transportation'],
    landuse: ['cemetery', 'recreation_ground'],
    historic: ['castle', 'monument', 'ruins']
  };
  // Venues (pub/cafe/shop) are only trusted when the toilet is inside their footprint, never merely near a point.
  var NODE_PARENT = {
    railway: ['station', 'halt'], public_transport: ['station'], amenity: ['library', 'community_centre', 'townhall', 'bus_station'],
    tourism: ['museum', 'gallery', 'attraction'], leisure: ['park', 'garden']
  };
  function category(tags, table) {
    for (var k in table) if (Object.prototype.hasOwnProperty.call(table, k) && tags[k] && table[k].indexOf(tags[k]) !== -1) return k + '=' + tags[k];
    return null;
  }

  var KEEP = ['leisure', 'railway', 'public_transport', 'amenity', 'tourism', 'shop', 'building', 'landuse', 'historic'];
  function slimTags(t) { var o = {}; KEEP.forEach(function (k) { if (t[k]) o[k] = t[k]; }); return o; }

  function centre(e) {
    var lat = e.lat != null ? e.lat : e.center && e.center.lat;
    var lon = e.lon != null ? e.lon : e.center && e.center.lon;
    // `out center tags bb` returns only `bounds` for ways/relations (no `center`), so fall back to its middle.
    if ((lat == null || lon == null) && e.bounds) { lat = (e.bounds.minlat + e.bounds.maxlat) / 2; lon = (e.bounds.minlon + e.bounds.maxlon) / 2; }
    return lat == null || lon == null ? null : { lat: lat, lon: lon };
  }
  function boundsOf(e) { var b = e.bounds; return b ? { s: b.minlat, w: b.minlon, n: b.maxlat, e: b.maxlon } : null; }

  // -> { toilets: [...], parents: [...] }
  function normalise(elements) {
    var toilets = [], parents = [];
    (elements || []).forEach(function (e) {
      var c = centre(e);
      if (!c) return;
      var t = e.tags || {};
      if (t.amenity === 'toilets') {
        toilets.push({
          id: e.type + '/' + e.id, type: e.type, osmId: e.id, lat: c.lat, lon: c.lon,
          name: t.name || 'Public toilets',
          hours: (t.opening_hours || '').trim() || null,
          hoursChecked: t['check_date:opening_hours'] || null,
          access: t.access || null,
          wheelchair: t.wheelchair || null, // yes | limited | no | null
          fee: t.fee || null,               // yes | no | null
          operator: t.operator || null,
          fac: Fac.fromTags(t)
        });
      } else if (t.opening_hours) {
        parents.push({ id: e.type + '/' + e.id, type: e.type, lat: c.lat, lon: c.lon, bounds: boundsOf(e), name: t.name || null, hours: t.opening_hours.trim(), tags: slimTags(t) });
      }
    });
    return { toilets: toilets, parents: parents };
  }

  function dist(lat1, lon1, lat2, lon2) {
    var R = 6371000, r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function area(b) { return (b.n - b.s) * (b.e - b.w); }

  // Best parent for a toilet: the smallest whitelisted area whose bounding box contains it, else a nearby
  // civic/transport node (<= 25 m). Returns {hours, from, id, kind, distance} or null.
  function inferHours(toilet, parents) {
    var best = null, bestScore = Infinity;
    (parents || []).forEach(function (p) {
      if (p.id === toilet.id) return;
      var score = null, kind;
      if (p.bounds && (p.bounds.n > p.bounds.s || p.bounds.e > p.bounds.w)) {
        kind = category(p.tags, PARENT_AREA);
        var pad = 0.00003; // ~3 m tolerance
        if (kind && inBbox({ s: p.bounds.s - pad, w: p.bounds.w - pad, n: p.bounds.n + pad, e: p.bounds.e + pad }, toilet.lat, toilet.lon)) score = area(p.bounds) * 1e6;
      } else {
        kind = category(p.tags, NODE_PARENT);
        var d = dist(toilet.lat, toilet.lon, p.lat, p.lon);
        if (kind && d <= 25) score = 1e6 + d; // any containing area beats a point
      }
      // A toilet operated by / named after the venue is a strong match even for venue nodes.
      if (score == null && p.name && toilet.operator && p.name.toLowerCase() === toilet.operator.toLowerCase() && dist(toilet.lat, toilet.lon, p.lat, p.lon) <= 60) { score = 2e6; kind = kind || 'operator'; }
      if (score != null && score < bestScore) { bestScore = score; best = { hours: p.hours, from: p.name || (kind || 'feature').replace(/^.*=/, ''), id: p.id, kind: kind, distance: Math.round(dist(toilet.lat, toilet.lon, p.lat, p.lon)) }; }
    });
    return best;
  }

  // Merge a fetch into a Map-like object {id: toilet}. New data replaces old for the same id.
  function mergeInto(store, toilets) {
    var added = 0;
    toilets.forEach(function (t) { if (!store[t.id]) added++; store[t.id] = t; });
    return added;
  }

  function stats(toilets) {
    var withHours = 0, inferred = 0;
    toilets.forEach(function (t) { if (t.hours) withHours++; else if (t.inferred) inferred++; });
    return { total: toilets.length, withHours: withHours, inferred: inferred };
  }

  var api = {
    ENDPOINTS: ENDPOINTS, bboxAround: bboxAround, padBbox: padBbox, clampBbox: clampBbox, bboxContains: bboxContains, inBbox: inBbox, bboxStr: bboxStr,
    buildLightQuery: buildLightQuery, buildParentsQuery: buildParentsQuery, checkResponse: checkResponse, normalise: normalise,
    inferHours: inferHours, mergeInto: mergeInto, stats: stats
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Data = api;
})(typeof self !== 'undefined' ? self : this);
