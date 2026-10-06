// Presentation rules shared by the web app and the Android app: which opening hours win (OSM > yours >
// inferred), the status/label shown, how a toilet ranks, and small labels. No DOM, no storage.
(function (root) {
  var Hours = (typeof require !== 'undefined' && typeof module !== 'undefined') ? require('./hours.js') : root.Hours;
  var Rank = (typeof require !== 'undefined' && typeof module !== 'undefined') ? require('./rank.js') : root.Rank;

  function shorten(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  // t: normalised toilet (data.js) with optional t.inferred; ctx: {mine: {text}|null, reports: {closed, broken}, now: Date}
  // -> {status, rankStatus, label, short, src: osm|you|inferred|none, approx}
  function describeHours(t, ctx) {
    ctx = ctx || {};
    var now = ctx.now || new Date(), mine = ctx.mine || null, rep = ctx.reports || {};
    var status, label, short, src, rankStatus, oh;
    if (t.hours) {
      src = 'osm'; oh = Hours.openNow(t.hours, now, t);
      status = oh.status; label = oh.status === 'unknown' ? 'Hours: ' + shorten(t.hours, 40) : oh.label;
      short = oh.status === 'unknown' ? 'Hours unclear' : oh.label;
    } else if (mine) {
      src = 'you'; oh = Hours.openNow(mine.text, now, t);
      status = oh.status; rankStatus = 'unknown';
      label = oh.status === 'unknown' ? 'Hours (yours): ' + shorten(mine.text, 34) : oh.label + ' · your hours';
      short = oh.status === 'unknown' ? 'Your hours' : oh.label;
    } else if (t.inferred) {
      src = 'inferred'; oh = Hours.openNow(t.inferred.hours, now, t);
      status = oh.status; rankStatus = 'unknown';
      label = oh.status === 'unknown' ? 'Hours not listed · nearby ' + shorten(t.inferred.from, 24) + ': ' + shorten(t.inferred.hours, 24)
        : oh.label + ' · inferred from nearby ' + shorten(t.inferred.from, 28);
      short = oh.status === 'unknown' ? 'Hours unknown' : (oh.status === 'open' ? 'Probably open' : 'Probably closed');
    } else {
      src = 'none'; status = 'unknown'; label = 'Hours not listed in OpenStreetMap'; short = 'Hours unknown';
    }
    if (rep.closed) { status = 'closed'; label = 'Reported closed (by you)'; short = 'Reported closed'; rankStatus = null; }
    return { status: status, rankStatus: rankStatus || status, label: label, short: short, src: src, approx: !!(oh && oh.approx) };
  }

  // "soft" = not confirmed by OSM (inferred, yours, or sunrise/sunset approximations).
  function tone(d) {
    return { status: d.status, soft: d.src === 'inferred' || d.src === 'you' || !!d.approx, none: d.src === 'none' };
  }

  function feeLabel(t) { return t.fee === 'yes' ? 'Paid' : t.fee === 'no' ? 'Free' : 'Fee unknown'; }

  function average(list) {
    if (!list || !list.length) return null;
    return list.reduce(function (a, b) { return a + b; }, 0) / list.length;
  }

  // Full view model for a toilet. ref: {lat, lon}; ctx as describeHours plus ratings: number[].
  function decorate(t, ref, ctx) {
    ctx = ctx || {};
    var d = describeHours(t, ctx), ratings = ctx.ratings || [];
    var o = {};
    for (var k in t) if (Object.prototype.hasOwnProperty.call(t, k)) o[k] = t[k];
    o.status = d.status; o.rankStatus = d.rankStatus; o.hoursLabel = d.label; o.hoursShort = d.short; o.hoursSrc = d.src; o.hoursApprox = d.approx;
    o.avg = average(ratings); o.ratingCount = ratings.length; o.reports = ctx.reports || {};
    o.distance = Rank.haversine(ref.lat, ref.lon, t.lat, t.lon);
    return o;
  }

  // filters: {accessible, urinals}
  function applyFilters(items, filters) {
    filters = filters || {};
    return items.filter(function (t) {
      if (filters.accessible && t.wheelchair !== 'yes') return false;
      if (filters.urinals && !(t.fac && t.fac.urinal)) return false;
      return true;
    });
  }

  // Which pictogram a map pin shows.
  function pinIcon(t) {
    if (t.wheelchair === 'yes') return 'accessible';
    if (t.fac && t.fac.urinal && !t.fac.female && !t.fac.unisex) return 'urinal';
    return 'unisex';
  }

  var api = { describeHours: describeHours, tone: tone, feeLabel: feeLabel, average: average, decorate: decorate, applyFilters: applyFilters, pinIcon: pinIcon, shorten: shorten };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Present = api;
})(typeof self !== 'undefined' ? self : this);
