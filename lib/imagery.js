// Location imagery helpers (pure URL/request builders, no network, no key storage).
// Google: Street View Static (metadata is free and tells us if a panorama exists; the image is pointed from the
// panorama towards the toilet) and Places API (New) Nearby Search for a public_bathroom photo.
// Fallback without a key: OpenStreetMap tiles centred on the toilet (CARTO basemaps now watermark keyless use).
(function (root) {
  var SV = 'https://maps.googleapis.com/maps/api/streetview';
  var PLACES = 'https://places.googleapis.com/v1/places:searchNearby';

  function r6(x) { return Math.round(x * 1e6) / 1e6; }
  function qs(o) { return Object.keys(o).filter(function (k) { return o[k] != null && o[k] !== ''; }).map(function (k) { return k + '=' + encodeURIComponent(o[k]); }).join('&'); }

  // Initial compass bearing (degrees, 0 = north) from a to b.
  function bearing(a, b) {
    var r = Math.PI / 180, f1 = a.lat * r, f2 = b.lat * r, dl = (b.lon - a.lon) * r;
    var y = Math.sin(dl) * Math.cos(f2), x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
    return (Math.atan2(y, x) / r + 360) % 360;
  }

  function streetViewMetadataUrl(pos, key, radius) {
    return SV + '/metadata?' + qs({ location: r6(pos.lat) + ',' + r6(pos.lon), radius: radius || 60, source: 'outdoor', key: key });
  }

  // meta: Street View metadata JSON. -> {ok, url, heading, panoId, date, copyright} or {ok:false, reason}
  function streetViewFromMetadata(meta, target, key, size) {
    if (!meta || meta.status !== 'OK' || !meta.location) return { ok: false, reason: meta && meta.status ? meta.status : 'no metadata' };
    var pano = { lat: meta.location.lat, lon: meta.location.lng };
    var heading = Math.round(bearing(pano, target));
    var url = SV + '?' + qs({ size: size || '640x360', pano: meta.pano_id, heading: heading, fov: 75, pitch: 0, key: key });
    return { ok: true, url: url, heading: heading, panoId: meta.pano_id, date: meta.date || null, copyright: meta.copyright || '© Google' };
  }

  // Places API (New) Nearby Search for the closest public toilet with photos. Android-restricted keys also need
  // X-Android-Package / X-Android-Cert (SHA-1, hex without colons) so Google can match the key restriction.
  function placesNearbyRequest(pos, key, android) {
    var headers = { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id,places.displayName,places.photos,places.location' };
    if (android && android.package) headers['X-Android-Package'] = android.package;
    if (android && android.certSha1) headers['X-Android-Cert'] = String(android.certSha1).replace(/:/g, '').toUpperCase();
    return {
      url: PLACES, method: 'POST', headers: headers,
      body: JSON.stringify({ includedTypes: ['public_bathroom'], maxResultCount: 3, rankPreference: 'DISTANCE',
        locationRestriction: { circle: { center: { latitude: r6(pos.lat), longitude: r6(pos.lon) }, radius: 50 } } })
    };
  }

  // -> [{url, attribution}] from a searchNearby response (first place that has photos).
  function placePhotos(json, key, maxWidth, max) {
    var places = (json && json.places) || [];
    for (var i = 0; i < places.length; i++) {
      var ph = places[i].photos || [];
      if (!ph.length) continue;
      return ph.slice(0, max || 4).map(function (p) {
        var who = (p.authorAttributions || []).map(function (a) { return a.displayName; }).filter(Boolean).join(', ');
        return { url: 'https://places.googleapis.com/v1/' + p.name + '/media?' + qs({ maxWidthPx: maxWidth || 800, key: key }), attribution: who ? 'Photo: ' + who + ' via Google' : 'Photo via Google', place: places[i].displayName && places[i].displayName.text };
      });
    }
    return [];
  }

  // Slippy-map tile containing pos at zoom z, plus the pixel offset of pos inside the 256px tile.
  function tileFor(pos, z) {
    var n = Math.pow(2, z), latR = pos.lat * Math.PI / 180;
    var xf = (pos.lon + 180) / 360 * n;
    var yf = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n;
    var x = Math.floor(xf), y = Math.floor(yf);
    return { z: z, x: x, y: y, px: Math.round((xf - x) * 256), py: Math.round((yf - y) * 256) };
  }
  // OpenStreetMap standard tiles (tile usage policy: identify the app, cache, light use only).
  var OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  function osmTileUrl(t) { return OSM_TILES.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y); }
  // 3x3 tiles around pos (for a fallback "map photo" card), each with its offset relative to pos.
  function tileGrid(pos, z) {
    var c = tileFor(pos, z), out = [];
    for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
      var t = { z: z, x: c.x + dx, y: c.y + dy };
      out.push({ url: osmTileUrl(t), left: dx * 256 - c.px, top: dy * 256 - c.py });
    }
    return out;
  }

  function directionsUrl(pos, name) {
    return 'https://www.google.com/maps/dir/?' + qs({ api: 1, destination: r6(pos.lat) + ',' + r6(pos.lon), travelmode: 'walking' });
  }

  var api = { bearing: bearing, streetViewMetadataUrl: streetViewMetadataUrl, streetViewFromMetadata: streetViewFromMetadata, placesNearbyRequest: placesNearbyRequest,
    placePhotos: placePhotos, tileFor: tileFor, osmTileUrl: osmTileUrl, OSM_TILES: OSM_TILES, tileGrid: tileGrid, directionsUrl: directionsUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Imagery = api;
})(typeof self !== 'undefined' ? self : this);
