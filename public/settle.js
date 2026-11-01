/* Trip maths: who owes what across many expenses, and the fewest transfers to settle up.
 * Shared by the server and the browser. All amounts are integer sen (cents). */
(function (root, factory) {
  var node = typeof module === 'object' && module.exports;
  var m = factory(node ? require('./split.js') : root.Split);
  if (node) module.exports = m; else root.Settle = m;
})(typeof self !== 'undefined' ? self : this, function (Split) {
  // An expense split by items works like a bill: people pick dishes, service charge and SST follow each person's
  // dishes (public/split.js), and dishes nobody picked stay with whoever paid.
  function itemsCalc(e) {
    var picks = e.picks || {};
    return Split.calc({ items: e.items || [], service: e.service || 0, sst: e.sst || 0, rounding: e.rounding || 0,
      members: Object.keys(picks).map(function (id) { return { id: id, picks: picks[id] }; }) });
  }

  // Each person's part of one expense. "equal": split among the chosen people, leftover sen to the first by id.
  // "exact": the amounts typed in (they must add up to the expense; the server checks). "items": from the dishes picked.
  function shares(e) {
    var out = {}, among = (e.among || []).slice().sort();
    if (e.mode === 'items') {
      var c = itemsCalc(e);
      Object.keys(c.per).forEach(function (id) { out[id] = c.per[id].total; });
      if (c.unclaimed.total) out[e.paidBy] = (out[e.paidBy] || 0) + c.unclaimed.total;
      return out;
    }
    if (e.mode === 'exact') { among.forEach(function (id) { out[id] = (e.shares && e.shares[id]) || 0; }); return out; }
    if (!among.length) return out;
    var base = Math.floor(e.amount / among.length), rem = e.amount - base * among.length;
    among.forEach(function (id, i) { out[id] = base + (i < rem ? 1 : 0); });
    return out;
  }

  // Per person: paid (for the group), owes (their shares), and net = what they should get back (negative: owe).
  // Payments between people count as soon as a slip is sent, so nobody is asked to pay twice while waiting.
  function balances(t) {
    var b = {};
    (t.members || []).forEach(function (m) { b[m.id] = { paid: 0, owes: 0, sent: 0, received: 0, net: 0 }; });
    var add = function (id) { return b[id] || (b[id] = { paid: 0, owes: 0, sent: 0, received: 0, net: 0 }); };
    (t.expenses || []).forEach(function (e) {
      add(e.paidBy).paid += e.amount;
      var s = shares(e); Object.keys(s).forEach(function (id) { add(id).owes += s[id]; });
    });
    (t.payments || []).forEach(function (p) { add(p.from).sent += p.amount; add(p.to).received += p.amount; });
    Object.keys(b).forEach(function (id) { var x = b[id]; x.net = x.paid - x.owes + x.sent - x.received; });
    return b;
  }

  // A short list of transfers that clears every balance (at most one fewer than the number of people):
  // the biggest debtor pays the biggest creditor, repeatedly. Ties go by id so everyone's phone shows the same list.
  function transfers(bal) {
    var cred = [], debt = [];
    Object.keys(bal).sort().forEach(function (id) { var n = bal[id].net; if (n > 0) cred.push({ id: id, n: n }); else if (n < 0) debt.push({ id: id, n: -n }); });
    var byAmount = function (a, z) { return z.n - a.n || (a.id < z.id ? -1 : 1); }, out = [];
    while (cred.length && debt.length) {
      cred.sort(byAmount); debt.sort(byAmount);
      var c = cred[0], d = debt[0], amt = Math.min(c.n, d.n);
      out.push({ from: d.id, to: c.id, amount: amt });
      c.n -= amt; d.n -= amt;
      if (!c.n) cred.shift();
      if (!d.n) debt.shift();
    }
    return out;
  }

  function total(t) { var s = 0; (t.expenses || []).forEach(function (e) { s += e.amount; }); return s; }

  return { shares: shares, balances: balances, transfers: transfers, total: total, itemsCalc: itemsCalc };
});
