// Ranking: open now first (unknown hours below confirmed-open, closed last),
// then average cleanliness (rated above unrated), then distance.
(function (root) {
  var TIER = { open: 0, unknown: 1, closed: 2 };

  function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371000, r = Math.PI / 180;
    var dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // Each item: {status, avg (number|null), distance}
  function compare(a, b) {
    var ta = TIER[a.status], tb = TIER[b.status];
    if (ta !== tb) return ta - tb;
    var ra = a.avg == null ? -1 : a.avg, rb = b.avg == null ? -1 : b.avg;
    if (ra !== rb) return rb - ra;
    return a.distance - b.distance;
  }

  function rank(items) { return items.slice().sort(compare); }

  function ratingLabel(avg, count) {
    if (avg == null || !count) return 'unrated';
    return avg.toFixed(1) + '/5';
  }

  function formatDistance(m) {
    return m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(1) + ' km';
  }

  var api = { haversine: haversine, compare: compare, rank: rank, ratingLabel: ratingLabel, formatDistance: formatDistance };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Rank = api;
})(typeof self !== 'undefined' ? self : this);
