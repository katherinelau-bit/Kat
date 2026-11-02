/* Keeping one person's devices in step: merges two copies of "my bills and trips" (one per device, or the server's).
 * Shared by the server and the browser. Each copy is { bills: {id: entry}, trips: {id: entry}, gone, name, nameAt },
 * where an entry is { token, memberId, title, at } and `gone` records bills and trips left or deleted ("b:id" or
 * "t:id" -> when). Times are milliseconds. */
(function (root, factory) {
  var m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m; else root.Sync = m;
})(typeof self !== 'undefined' ? self : this, function () {
  var KINDS = { bills: 'b', trips: 't' };
  var MAX_GONE = 2000;

  // The newer entry for each bill and trip wins; one left or deleted after it was last saved stays gone, but joining
  // it again later brings it back. The newer name wins.
  function merge(a, b) {
    a = a || {}; b = b || {};
    var out = { bills: {}, trips: {}, gone: {}, name: '', nameAt: 0 };
    [a, b].forEach(function (x) {
      Object.keys(x.gone || {}).forEach(function (k) { out.gone[k] = Math.max(out.gone[k] || 0, +x.gone[k] || 0); });
    });
    Object.keys(KINDS).forEach(function (kind) {
      [a, b].forEach(function (x) {
        Object.keys(x[kind] || {}).forEach(function (id) {
          var e = x[kind][id], cur = out[kind][id];
          if (e && (!cur || (+e.at || 0) > (+cur.at || 0))) out[kind][id] = e;
        });
      });
      Object.keys(out[kind]).forEach(function (id) {
        var g = out.gone[KINDS[kind] + ':' + id];
        if (g && g >= (+out[kind][id].at || 0)) delete out[kind][id];
      });
    });
    // Only the most recent departures need remembering.
    var keys = Object.keys(out.gone);
    if (keys.length > MAX_GONE) keys.sort(function (x, y) { return out.gone[y] - out.gone[x]; }).slice(MAX_GONE).forEach(function (k) { delete out.gone[k]; });
    var n = (+b.nameAt || 0) > (+a.nameAt || 0) ? b : a;
    out.name = n.name || ''; out.nameAt = +n.nameAt || 0;
    return out;
  }

  // Did the list of bills and trips change (ignoring titles and times)?
  function sameList(a, b) {
    var sig = function (x) {
      return Object.keys(KINDS).map(function (kind) {
        return Object.keys((x && x[kind]) || {}).sort().map(function (id) { var e = x[kind][id]; return id + '=' + e.token + '/' + e.memberId; }).join(',');
      }).join('|');
    };
    return sig(a) === sig(b);
  }

  return { merge: merge, sameList: sameList };
});
