// opening_hours parser for the common OSM patterns (not a full implementation of the spec).
// Supported: "24/7"; day ranges/lists/wrap-around ("Mo-Fr", "Sa,Su", "Fr-Mo"); month selectors
// ("Apr-Sep Mo-Su 08:00-20:00", "Oct-Mar: ..."); multiple ranges ("08:00-12:00,14:00-18:00");
// overnight ranges ("22:00-02:00", "12:00-00:00"); off/closed; ';'-separated rules (later rules
// override earlier ones for the days/months they match); comma-separated rules
// ("Mo 06:00-00:00, Tu-Fr 00:00-24:00", "Mo, We-Th 11:00-19:00; Tu ..."); no day selector = every day.
// sunrise/sunset/dawn/dusk (with optional offsets) are approximated from the location and flagged `approx`.
// Public holidays (PH/SH) are not modelled: "PH off" rules are ignored and "Mo-Su,PH ..." applies to Mo-Su.
// Rules with selectors we can't model (e.g. "Dec 25 off", "Su[1] off") are skipped when they are "off"
// (exceptions), and make the whole string "unknown" otherwise.
(function (root) {
  var DAYS = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'];
  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  var DAYNAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var T = '\\d{1,2}:\\d{2}|\\(?(?:sunrise|sunset|dawn|dusk)(?:[+-]\\d{1,2}:\\d{2})?\\)?';
  var RANGE = new RegExp('^(' + T + ')\\s*-\\s*(' + T + ')$', 'i');
  var SPLIT = /^(.*?)\s*(\d{1,2}:\d{2}.*|\(?(?:sunrise|sunset|dawn|dusk).*|off|closed|24\/7)$/i;

  function toMin(s) {
    var p = s.split(':'), h = +p[0], m = +p[1];
    if (m > 59 || h > 24 || (h === 24 && m > 0)) throw new Error('bad time');
    return h * 60 + m;
  }
  function parseTime(s) {
    s = s.trim().toLowerCase().replace(/[()]/g, '');
    var m = s.match(/^(sunrise|sunset|dawn|dusk)(?:([+-])(\d{1,2}):(\d{2}))?$/);
    if (m) return { sun: m[1], off: m[2] ? (m[2] === '-' ? -1 : 1) * (+m[3] * 60 + +m[4]) : 0 };
    return toMin(s);
  }

  // --- sun position (NOAA / "Almanac for Computers" algorithm), returns local minutes-of-day or null ---
  function rad(d) { return d * Math.PI / 180; }
  function deg(r) { return r * 180 / Math.PI; }
  function sunUTC(date, lat, lon, rising, zenith) {
    var start = Date.UTC(date.getFullYear(), 0, 0);
    var N = Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - start) / 86400000);
    var lngHour = lon / 15;
    var t = N + ((rising ? 6 : 18) - lngHour) / 24;
    var M = 0.9856 * t - 3.289;
    var L = (M + 1.916 * Math.sin(rad(M)) + 0.020 * Math.sin(rad(2 * M)) + 282.634 + 720) % 360;
    var RA = (deg(Math.atan(0.91764 * Math.tan(rad(L)))) + 360) % 360;
    RA += Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90;
    RA /= 15;
    var sinDec = 0.39782 * Math.sin(rad(L)), cosDec = Math.cos(Math.asin(sinDec));
    var cosH = (Math.cos(rad(zenith)) - sinDec * Math.sin(rad(lat))) / (cosDec * Math.cos(rad(lat)));
    if (cosH > 1 || cosH < -1) return null;
    var H = (rising ? 360 - deg(Math.acos(cosH)) : deg(Math.acos(cosH))) / 15;
    var UT = ((H + RA - 0.06571 * t - 6.622 - lngHour) % 24 + 24) % 24;
    return UT * 60;
  }
  var SUN = { sunrise: [true, 90.833], sunset: [false, 90.833], dawn: [true, 96], dusk: [false, 96] };
  var FALLBACK = { sunrise: 360, sunset: 1080, dawn: 330, dusk: 1110 };
  function sunMinutes(name, date, loc) {
    loc = loc || {};
    var lat = loc.lat != null ? loc.lat : 51.5, lon = loc.lon != null ? loc.lon : -0.1;
    var s = SUN[name];
    var ut = sunUTC(date, lat, lon, s[0], s[1]);
    if (ut == null) return FALLBACK[name];
    // Date's UTC offset for that day (getTimezoneOffset is UTC - local, in minutes)
    var noon = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
    return Math.round((((ut - noon.getTimezoneOffset()) % 1440) + 1440) % 1440);
  }
  function resolve(x, date, loc, flags) {
    if (typeof x === 'number') return x;
    flags.approx = true;
    return sunMinutes(x.sun, date, loc) + x.off;
  }

  // --- parsing ---
  function classify(group) {
    // returns {months:[bool*12]} or {days:[idx], ph:bool} or throws 'unsupported'
    var parts = group.split(','), i, m;
    if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(group)) {
      var months = [];
      for (i = 0; i < parts.length; i++) {
        m = parts[i].toLowerCase().match(/^([a-z]{3})(?:-([a-z]{3}))?$/);
        if (!m) throw new Error('unsupported');
        var a = MONTHS.indexOf(m[1]), b = m[2] ? MONTHS.indexOf(m[2]) : a;
        if (a < 0 || b < 0) throw new Error('unsupported');
        for (var k = a; ; k = (k + 1) % 12) { months.push(k); if (k === b) break; }
      }
      return { months: months };
    }
    var days = [], ph = false;
    for (i = 0; i < parts.length; i++) {
      var p = parts[i].toLowerCase();
      if (p === 'ph' || p === 'sh') { ph = true; continue; }
      m = p.match(/^([a-z]{2})(?:-([a-z]{2}))?$/);
      if (!m) throw new Error('unsupported');
      var da = DAYS.indexOf(m[1]), db = m[2] ? DAYS.indexOf(m[2]) : da;
      if (da < 0 || db < 0) throw new Error('unsupported');
      for (var d = da; ; d = (d + 1) % 7) { days.push(d); if (d === db) break; }
    }
    return { days: days, ph: ph };
  }

  // Returns {ok:true, always:bool, rules:[{months:Set|null, days:[7 bool], ranges:[[a,b]]}]} or {ok:false}
  var cache = {}, cacheSize = 0;
  function parse(str) {
    if (typeof str !== 'string') return { ok: false };
    if (cache[str]) return cache[str];
    var r = parseUncached(str);
    if (cacheSize++ > 500) { cache = {}; cacheSize = 0; }
    cache[str] = r;
    return r;
  }
  function parseUncached(str) {
    if (!str.trim()) return { ok: false };
    var s = str.trim();
    if (/^24\/7$/i.test(s)) return { ok: true, always: true, rules: [] };
    // "Mo 06:00-00:00, Tu-Fr ..." : a comma after a time / off / closed followed by a letter separates rules
    var chunks = s.replace(/(\d|off|closed)\s*,\s*(?=[A-Za-z(])/gi, '$1;').split(';');
    var rules = [];
    for (var i = 0; i < chunks.length; i++) {
      var r = chunks[i].trim();
      if (!r) continue;
      var m = r.match(SPLIT);
      if (!m) return { ok: false };
      var sel = m[1].replace(/:/g, ' ').replace(/\s*([,\-])\s*/g, '$1').trim();
      var body = m[2].trim();
      var isOff = /^(off|closed)$/i.test(body);
      var months = null, days = null, onlyPH = false;
      try {
        if (sel) {
          var groups = sel.split(/\s+/);
          for (var g = 0; g < groups.length; g++) {
            var c = classify(groups[g]);
            if (c.months) months = (months || []).concat(c.months);
            else if (c.days.length) days = (days || []).concat(c.days);
            else if (c.ph) onlyPH = true;
          }
        }
      } catch (e) {
        if (isOff) continue; // unmodelled exception ("Dec 25 off", "Su[1] off"): skip it
        return { ok: false };
      }
      if (onlyPH && !days && !months) continue; // "PH off" / "PH 10:00-16:00": public holidays not modelled
      var ranges = [];
      if (isOff) ranges = [];
      else if (/^24\/7$/i.test(body)) ranges = [[0, 1440]];
      else {
        try {
          body.split(/\s*,\s*/).forEach(function (t) {
            if (!t) return;
            var q = t.match(RANGE);
            if (!q) throw new Error('bad range');
            ranges.push([parseTime(q[1]), parseTime(q[2])]);
          });
        } catch (e) { return { ok: false }; }
        if (!ranges.length) return { ok: false };
      }
      var dayFlags = [0, 1, 2, 3, 4, 5, 6].map(function (d) { return days ? days.indexOf(d) !== -1 : true; });
      rules.push({ months: months, days: dayFlags, ranges: ranges });
    }
    return rules.length ? { ok: true, always: false, rules: rules } : { ok: false };
  }

  function rangesFor(p, date, loc, flags) {
    var dow = (date.getDay() + 6) % 7, mon = date.getMonth(), out = [];
    p.rules.forEach(function (rule) {
      if (rule.months && rule.months.indexOf(mon) === -1) return;
      if (!rule.days[dow]) return;
      out = rule.ranges.map(function (r) { return [resolve(r[0], date, loc, flags), resolve(r[1], date, loc, flags)]; });
    });
    return out;
  }

  function fmt(min, approx) {
    min = ((min % 1440) + 1440) % 1440;
    var h = Math.floor(min / 60), m = min % 60;
    return (approx ? '~' : '') + (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }
  function when(abs, nowDay, approx, isOpening) { // abs = minutes from today's midnight
    var off = Math.floor(abs / 1440), mod = abs - off * 1440;
    var text = fmt(mod, approx);
    if (off === 0 || (!isOpening && off === 1 && mod <= 720)) return text; // closing just after midnight: plain time
    var d = new Date(nowDay.getFullYear(), nowDay.getMonth(), nowDay.getDate() + off);
    return (off === 1 ? 'tomorrow ' : DAYNAMES[(d.getDay() + 6) % 7] + ' ') + text;
  }

  // Returns {status:'open'|'closed'|'unknown', label, closesAt?, approx?, opensAt?}
  function openNow(str, date, loc) {
    date = date || new Date();
    if (typeof str !== 'string' || !str.trim()) return { status: 'unknown', label: 'Hours unknown' };
    var p = parse(str);
    if (!p.ok) return { status: 'unknown', label: 'Hours unknown' };
    if (p.always) return { status: 'open', label: 'Open 24/7' };
    var flags = { approx: false }, ivs = [], d;
    for (d = -1; d <= 7; d++) {
      var day = new Date(date.getFullYear(), date.getMonth(), date.getDate() + d, 12);
      rangesFor(p, day, loc, flags).forEach(function (r) {
        var s = d * 1440 + r[0], e = d * 1440 + (r[1] <= r[0] ? r[1] + 1440 : r[1]);
        ivs.push([s, e]);
      });
    }
    ivs.sort(function (a, b) { return a[0] - b[0]; });
    var merged = [];
    ivs.forEach(function (iv) {
      var last = merged[merged.length - 1];
      if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]); else merged.push([iv[0], iv[1]]);
    });
    var now = date.getHours() * 60 + date.getMinutes(), approx = flags.approx;
    var sfx = approx ? ' (daylight)' : '';
    for (var i = 0; i < merged.length; i++) {
      var iv = merged[i];
      if (now >= iv[0] && now < iv[1]) {
        if (iv[1] - now >= 7 * 1440) return { status: 'open', label: 'Open 24/7', approx: approx };
        return { status: 'open', label: 'Open until ' + when(iv[1], date, approx) + sfx, closesAt: iv[1] % 1440, approx: approx };
      }
    }
    for (i = 0; i < merged.length; i++) {
      if (merged[i][0] > now) return { status: 'closed', label: 'Closed · opens ' + when(merged[i][0], date, approx, true) + sfx, opensAt: merged[i][0] % 1440, approx: approx };
    }
    return { status: 'closed', label: 'Closed now', approx: approx };
  }

  var api = { parse: parse, openNow: openNow, sunMinutes: sunMinutes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Hours = api;
})(typeof self !== 'undefined' ? self : this);
