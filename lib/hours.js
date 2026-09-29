// Small opening_hours parser: handles the common OSM patterns.
// Supported: "24/7", "Mo-Su 08:00-20:00", day lists ("Mo,We,Fr"), wrap-around day ranges ("Fr-Mo"),
// multiple time ranges ("08:00-12:00,14:00-18:00"), overnight ranges ("22:00-02:00"),
// "off"/"closed", multiple ';'-separated rules (later rules override earlier ones for the same days),
// rules without a day selector (= every day). "PH" rules are ignored (public holidays not modelled).
// Anything else (months, weeks, sunrise/sunset, "open" alone, comments...) => status "unknown".
(function (root) {
  var DAYS = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'];
  var TIME = '\\d{1,2}:\\d{2}\\s*-\\s*\\d{1,2}:\\d{2}';
  var RULE = new RegExp('^([a-z][a-z,\\- ]*?)?\\s*((?:' + TIME + '\\s*,?\\s*)+|off|closed|24/7)?$', 'i');

  function toMin(s) {
    var p = s.split(':'), h = +p[0], m = +p[1];
    if (m > 59 || h > 24 || (h === 24 && m > 0)) throw new Error('bad time');
    return h * 60 + m;
  }

  function parseDays(sel) {
    var out = [];
    var parts = sel.split(',');
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i].trim().toLowerCase();
      if (!part) throw new Error('empty day');
      if (part === 'ph' || part === 'sh') { out.ignore = true; continue; }
      var m = part.match(/^([a-z]{2})(?:\s*-\s*([a-z]{2}))?$/);
      if (!m) throw new Error('bad day selector');
      var a = DAYS.indexOf(m[1]);
      var b = m[2] ? DAYS.indexOf(m[2]) : a;
      if (a < 0 || b < 0) throw new Error('bad day');
      for (var d = a; ; d = (d + 1) % 7) { out.push(d); if (d === b) break; }
    }
    return out;
  }

  // Returns {ok:true, always:bool, days:[7 x [[startMin,endMin],...]]} or {ok:false}
  function parse(str) {
    if (typeof str !== 'string' || !str.trim()) return { ok: false };
    var s = str.trim();
    if (/^24\/7$/i.test(s)) return { ok: true, always: true };
    var days = [[], [], [], [], [], [], []];
    // Tolerate "Mo-Fr 09:00-19:00, Sa 10:00-16:00" (comma between rules): comma + whitespace + letter
    var rules = s.replace(/,\s+(?=[A-Za-z])/g, ';').split(';');
    var any = false;
    try {
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i].trim();
        if (!r) continue;
        var m = r.match(RULE);
        if (!m || (!m[1] && !m[2])) return { ok: false };
        var sel = m[1] ? m[1].trim() : '';
        var body = m[2] ? m[2].trim() : '';
        if (/^24\/7$/i.test(body) && !sel) return { ok: true, always: true };
        var target = sel ? parseDays(sel) : [0, 1, 2, 3, 4, 5, 6];
        if (target.ignore && !target.length) continue; // PH-only rule
        var ranges = [];
        if (/^24\/7$/i.test(body) || (!body && sel)) {
          // "Mo-Fr" alone or "Mo-Fr 24/7" is ambiguous/unusual; treat 24/7 as all-day, bare days as unknown
          if (!/^24\/7$/i.test(body)) return { ok: false };
          ranges = [[0, 1440]];
        } else if (/^(off|closed)$/i.test(body)) {
          ranges = [];
        } else {
          body.split(',').forEach(function (t) {
            t = t.trim();
            if (!t) return;
            var q = t.split('-');
            ranges.push([toMin(q[0].trim()), toMin(q[1].trim())]);
          });
        }
        target.forEach(function (d) { days[d] = ranges.slice(); });
        any = true;
      }
    } catch (e) { return { ok: false }; }
    return any ? { ok: true, always: false, days: days } : { ok: false };
  }

  function fmt(min) {
    min = ((min % 1440) + 1440) % 1440;
    var h = Math.floor(min / 60), m = min % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  // Returns {status:'open'|'closed'|'unknown', label, closesAt?}
  function openNow(str, date) {
    date = date || new Date();
    var p = parse(str);
    if (!p.ok) return { status: 'unknown', label: 'Hours unknown' };
    if (p.always) return { status: 'open', label: 'Open 24/7' };
    var dow = (date.getDay() + 6) % 7; // 0 = Monday
    var now = date.getHours() * 60 + date.getMinutes();
    var today = p.days[dow], yest = p.days[(dow + 6) % 7];
    var i, r;
    for (i = 0; i < today.length; i++) {
      r = today[i];
      if (r[1] > r[0] && now >= r[0] && now < r[1]) return { status: 'open', label: 'Open until ' + fmt(r[1]), closesAt: r[1] };
      if (r[1] <= r[0] && now >= r[0]) return { status: 'open', label: 'Open until ' + fmt(r[1]), closesAt: r[1] }; // overnight, evening part
    }
    for (i = 0; i < yest.length; i++) {
      r = yest[i];
      if (r[1] <= r[0] && now < r[1]) return { status: 'open', label: 'Open until ' + fmt(r[1]), closesAt: r[1] }; // overnight, after-midnight part
    }
    return { status: 'closed', label: 'Closed now' };
  }

  var api = { parse: parse, openNow: openNow };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Hours = api;
})(typeof self !== 'undefined' ? self : this);
