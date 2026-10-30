/* Bill splitting maths. Shared by the server and the browser. All amounts are integer sen (cents). */
(function (root, factory) {
  var m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m; else root.Split = m;
})(typeof self !== 'undefined' ? self : this, function () {
  function calc(b) {
    var items = b.items || [], members = b.members || [];
    var sum = 0; items.forEach(function (i) { sum += i.price; });
    var total = sum + (b.service || 0) + (b.sst || 0) + (b.rounding || 0);
    var per = {}, unSub = 0, unItems = [];
    items.forEach(function (it) {
      var who = members.filter(function (m) { return (m.picks || []).indexOf(it.id) > -1; })
        .map(function (m) { return m.id; }).sort();
      if (!who.length) { unSub += it.price; unItems.push(it); return; }
      var base = Math.floor(it.price / who.length), rem = it.price - base * who.length;
      who.forEach(function (id) {
        var c = base + (rem > 0 ? 1 : 0); if (rem > 0) rem--;
        var p = per[id] || (per[id] = { lines: [], sub: 0 });
        p.lines.push({ id: it.id, name: it.name, cents: c, n: who.length }); p.sub += c;
      });
    });
    var ents = Object.keys(per).map(function (k) { return { k: k, sub: per[k].sub }; });
    ents.push({ k: '__un', sub: unSub });
    var got = 0;
    ents.forEach(function (e) {
      var ex = sum ? e.sub * total / sum : 0;
      e.t = Math.floor(ex + 1e-9); e.f = ex - e.t; got += e.t;
    });
    var left = total - got;
    ents.slice().sort(function (a, z) { return z.f - a.f; }).forEach(function (e) { if (left > 0) { e.t++; left--; } });
    var out = { sum: sum, total: total, per: {}, unclaimed: { sub: unSub, total: 0, items: unItems } };
    ents.forEach(function (e) {
      if (e.k === '__un') { out.unclaimed.total = e.t; return; }
      var svc = sum ? Math.round(e.sub * (b.service || 0) / sum) : 0;
      var sst = sum ? Math.round(e.sub * (b.sst || 0) / sum) : 0;
      out.per[e.k] = { lines: per[e.k].lines, sub: e.sub, svc: svc, sst: sst, rnd: e.t - e.sub - svc - sst, total: e.t };
    });
    return out;
  }
  return { calc: calc };
});
