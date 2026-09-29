// Derive facility flags from OSM tags on an amenity=toilets feature.
// Tag assumptions are documented in README ("OSM tag assumptions").
(function (root) {
  function yes(v) { return typeof v === 'string' && v.trim().toLowerCase() === 'yes'; }
  function no(v) { return typeof v === 'string' && v.trim().toLowerCase() === 'no'; }
  // "yes", or a positive count such as "3"
  function positive(v) {
    if (typeof v !== 'string') return false;
    var s = v.trim().toLowerCase();
    return s === 'yes' || (/^\d+$/.test(s) && +s > 0);
  }
  function list(v) { return typeof v === 'string' ? v.toLowerCase().split(';').map(function (s) { return s.trim(); }) : []; }

  function fromTags(tags) {
    var t = tags || {};
    var male = yes(t.male), female = yes(t.female);
    var segregated = yes(t.gender_segregated);
    var unisex = yes(t.unisex) || (male && female && no(t.gender_segregated));
    var urinal = list(t['toilets:position']).indexOf('urinal') !== -1 ||
      positive(t.urinal) || positive(t['toilets:urinal']) || positive(t['toilets:urinals']);
    var wc = t.wheelchair === 'yes' || t.wheelchair === 'limited' || t.wheelchair === 'no' ? t.wheelchair : null;
    return {
      male: male, female: female, unisex: unisex, segregated: segregated,
      urinal: urinal,
      babyChange: (t.changing_table != null && !no(t.changing_table) && t.changing_table !== '') || yes(t.diaper),
      wheelchair: wc
    };
  }

  var EMPTY = fromTags({});

  // Ordered list of icon keys to show for a toilet (icons.js draws them).
  function badges(f) {
    f = f || EMPTY;
    var out = [];
    if (f.unisex) out.push('unisex');
    else {
      if (f.male) out.push('man');
      if (f.female) out.push('woman');
    }
    if (f.urinal) out.push('urinal');
    if (f.wheelchair === 'yes') out.push('accessible');
    else if (f.wheelchair === 'limited') out.push('accessibleLimited');
    if (f.babyChange) out.push('baby');
    return out;
  }

  // Overpass QL: every amenity=toilets feature (node/way/relation) in range. The tags that
  // matter (male/female/unisex/gender_segregated/toilets:position/urinal/wheelchair/changing_table)
  // come back in `out tags`, so no tag-based filtering happens server-side.
  function buildQuery(pos, radius) {
    return '[out:json][timeout:20];nwr["amenity"="toilets"](around:' + radius + ',' + pos.lat + ',' + pos.lon + ');out center tags;';
  }

  var api = { fromTags: fromTags, badges: badges, buildQuery: buildQuery, EMPTY: EMPTY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Facilities = api;
})(typeof self !== 'undefined' ? self : this);
