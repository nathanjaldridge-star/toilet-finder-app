// Original, simple toilet-sign style pictograms (drawn for this project).
// All use a 24x24 viewBox and currentColor, so CSS controls colour.
(function (root) {
  var HEAD = '<circle cx="12" cy="3.6" r="2.2"/>';
  var MAN = '<circle cx="12" cy="3.6" r="2.2"/><rect x="7.6" y="7" width="8.8" height="8.4" rx="1.8"/>' +
    '<rect x="8.9" y="13" width="2.9" height="9" rx="1.2"/><rect x="12.2" y="13" width="2.9" height="9" rx="1.2"/>';
  var WOMAN = HEAD + '<path d="M9.6 7h4.8a1.4 1.4 0 0 1 1.35 1l2.6 8.4a.6.6 0 0 1-.58.77H14.6V22.2h-1.9v-5.0h-1.4v5H9.4v-5H6.2a.6.6 0 0 1-.58-.77l2.6-8.4A1.4 1.4 0 0 1 9.6 7z"/>';
  var PATHS = {
    man: MAN,
    woman: WOMAN,
    // man + woman side by side with a divider
    unisex: '<g transform="translate(-0.5 3) scale(.5)">' + MAN + '</g><g transform="translate(12.5 3) scale(.5)">' + WOMAN + '</g>' +
      '<rect x="11.5" y="2" width="1" height="20" rx=".5"/>',
    accessible: '<circle cx="10.5" cy="3.6" r="2.1"/>' +
      '<g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M10.5 7.6v6.2h5.2l2.6 5.6"/><path d="M10.5 10.6h4.6"/>' +
      '<path d="M7.6 11.6a5.4 5.4 0 1 0 7.6 7.4"/></g>',
    // urinal: wall slab, bowl, drain and flush pipe
    urinal: '<rect x="4" y="2" width="16" height="2.4" rx="1.2"/>' +
      '<path d="M7.2 5.6h9.6v7.2c0 3.4-2.2 6-4.8 6s-4.8-2.6-4.8-6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>' +
      '<circle cx="12" cy="11.6" r="1.6"/><rect x="11" y="18.6" width="2" height="3.4" rx="1"/>',
    // baby-change: baby on a changing table
    baby: '<circle cx="8" cy="6.2" r="2.4"/><path d="M11.4 9.4H20a1.6 1.6 0 0 1 0 3.2H6.6a2 2 0 0 1-2-2 1.9 1.9 0 0 1 1.9-1.9z" transform="translate(0 1)"/>' +
      '<rect x="3" y="15.6" width="18" height="2.2" rx="1.1"/><rect x="5" y="17" width="2" height="5" rx="1"/><rect x="17" y="17" width="2" height="5" rx="1"/>'
  };
  PATHS.accessibleLimited = PATHS.accessible;

  var LABELS = {
    man: 'Men', woman: 'Women', unisex: 'Unisex / all-gender', urinal: 'Urinals',
    accessible: 'Wheelchair accessible', accessibleLimited: 'Limited wheelchair access', baby: 'Baby changing'
  };

  function svg(name, opts) {
    opts = opts || {};
    var body = PATHS[name];
    if (!body) return '';
    var size = opts.size || 18;
    var label = opts.label || LABELS[name];
    return '<svg class="ico ico-' + name + (opts.cls ? ' ' + opts.cls : '') + '" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="' + size + '" height="' + size +
      '" fill="currentColor" role="img" aria-label="' + label + '"><title>' + label + '</title>' + body + '</svg>';
  }

  var api = { svg: svg, names: Object.keys(PATHS), labels: LABELS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Icons = api;
})(typeof self !== 'undefined' ? self : this);
