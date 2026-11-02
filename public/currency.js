/* Currencies for bills and trip expenses abroad. Shared by the server and the browser.
 * Amounts are always stored as hundredths of the currency's unit ("cents"), even for currencies printed without
 * decimals (dong, rupiah, yen, won), so the split maths is the same for all of them. A bill in another currency keeps a
 * `rate`: how many ringgit one unit is worth (1 THB = RM 0.1287). People settle up in ringgit, by DuitNow. */
(function (root, factory) {
  var m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m; else root.Currency = m;
})(typeof self !== 'undefined' ? self : this, function () {
  // [code, name, decimals printed]
  var LIST = [
    ['MYR', 'Malaysian ringgit', 2], ['SGD', 'Singapore dollar', 2], ['THB', 'Thai baht', 2], ['CNY', 'Chinese yuan (RMB)', 2],
    ['VND', 'Vietnamese dong', 0], ['IDR', 'Indonesian rupiah', 0], ['USD', 'US dollar', 2], ['EUR', 'Euro', 2],
    ['GBP', 'British pound', 2], ['JPY', 'Japanese yen', 0], ['KRW', 'Korean won', 0], ['HKD', 'Hong Kong dollar', 2],
    ['TWD', 'Taiwan dollar', 0], ['AUD', 'Australian dollar', 2], ['PHP', 'Philippine peso', 2]
  ];
  var BY = {};
  LIST.forEach(function (c) { BY[c[0]] = { code: c[0], name: c[1], decimals: c[2] }; });

  function clean(code) { code = String(code || '').toUpperCase(); return BY[code] ? code : 'MYR'; }
  function decimals(code) { return BY[clean(code)].decimals; }
  // Ringgit per unit: 1 for MYR; otherwise a positive number, or 0 when it is missing or not believable.
  function cleanRate(code, rate) {
    if (clean(code) === 'MYR') return 1;
    var r = Number(rate);
    return isFinite(r) && r > 0 && r < 100 ? Math.round(r * 1e6) / 1e6 : 0;
  }

  // "RM 12.90", "THB 1,200.00", "VND 150,000".
  function fmt(c, code) {
    code = clean(code);
    var d = BY[code].decimals, n = Math.abs(c) / 100;
    var s = n.toLocaleString('en-MY', { minimumFractionDigits: d, maximumFractionDigits: d });
    return (code === 'MYR' ? 'RM ' : code + ' ') + (c < 0 ? '-' : '') + s;
  }

  // An amount in sen of ringgit.
  function toRM(c, rate) { return Math.round(c * (rate || 0)); }

  // Shares of one amount, converted to ringgit so they still add up exactly to the converted total
  // (largest remainder: the sen lost to rounding go to the shares that lost the most).
  function spreadRM(shares, total, rate) {
    var ids = Object.keys(shares), out = {}, target = toRM(total, rate), sum = 0;
    if (!ids.length) return out;
    var parts = ids.map(function (id) { var exact = shares[id] * rate, base = Math.floor(exact); sum += base; return { id: id, base: base, frac: exact - base }; });
    parts.sort(function (a, z) { return z.frac - a.frac || (a.id < z.id ? -1 : 1); });
    var left = target - sum;
    parts.forEach(function (p, i) { out[p.id] = p.base + (i < left ? 1 : 0); });
    return out;
  }

  return { list: LIST.map(function (c) { return BY[c[0]]; }), clean: clean, decimals: decimals, cleanRate: cleanRate, fmt: fmt, toRM: toRM, spreadRM: spreadRM };
});
