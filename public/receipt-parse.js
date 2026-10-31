/* Turns the text read off a receipt photo into items and charges. Shared by the browser and the tests. All amounts are integer sen. */
(function (root, factory) {
  var m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m; else root.ReceiptParse = m;
})(typeof self !== 'undefined' ? self : this, function () {
  // A money amount at the end of a line, optionally "RM", negative or in brackets, followed by a tax code like "SR" or "T".
  var AMOUNT_END = /(\(?-?\s*(?:RM\s*)?-?\d{1,5}[.,]\s?\d{2}\)?)\s*(?:[A-Z*]{1,2})?\s*$/i;
  var SKIP = /sub\s*-?\s*total|jumlah\s*kecil|sub\s*-?\s*jumlah|cash|tunai|change|baki|balance|paid|tender|card|visa|master|debit|credit|e-?wallet|tng|touch\s*n|grab\s*pay|boost|duitnow|qr\s*pay|item\s*count|no\.?\s*of\s*items|total\s*qty|qty\s*total|discount|diskaun|voucher|deposit/i;
  var SST = /\bsst\b|\bgst\b|service\s*tax|\btax\b|cukai/i;
  var SERVICE = /service|svc|s\/c|caj\s*perkhidmatan|perkhidmatan/i;
  var ROUNDING = /round|bundar/i;
  var TOTAL = /total|jumlah|amount\s*due|nett|grand/i;

  function toSen(s) {
    var neg = /^\(|-/.test(s.trim());
    var n = parseFloat(s.replace(/[()\sA-Za-z]/g, '').replace(',', '.').replace(/^-/, ''));
    if (!isFinite(n)) return null;
    return Math.round(n * 100) * (neg ? -1 : 1);
  }
  // Common misreads inside numbers: O for 0, l or I for 1, S for 5.
  function fixDigits(line) {
    return line.replace(/(\d)[Oo](?=\d|[.,])/g, '$10').replace(/([.,])[Oo]/g, '$10').replace(/[Oo](?=[.,]\d)/g, '0')
      .replace(/(\d)[lI](?=\d|[.,])/g, '$11').replace(/([.,]\d)[Oo]\b/g, '$10');
  }
  function cleanName(s) {
    return s.replace(/^[\s\-*#.:|_~]+|[\s\-*#.:|_~@x×]+$/gi, '').replace(/^[A-Z]?\d{2,6}\s+(?=[A-Za-z])/, '').replace(/\s{2,}/g, ' ').slice(0, 80).trim();
  }
  function letters(s) { return (s.match(/[A-Za-z]/g) || []).length; }

  // Splits "2 x Roti Canai", "Roti Canai x2", "Roti Canai 2 @ 2.20" or "Roti Canai  2  2.20" into a name and quantity.
  function nameAndQty(text, line) {
    var t = text.trim(), qty = 1, m;
    if ((m = t.match(/^(\d{1,2})\s*[xX×*]\s*(.+)$/)) || (m = t.match(/^(\d{1,2})\s+([A-Za-z].+)$/))) { qty = +m[1]; t = m[2]; }
    else if ((m = t.match(/^(.+?)\s*[xX×]\s*(\d{1,2})$/))) { t = m[1]; qty = +m[2]; }
    // Trailing "qty @ unit price" or "qty unit price" columns before the line total.
    if ((m = t.match(/^(.*?[A-Za-z].*?)\s+(\d{1,2})\s*(?:[@xX×]\s*)?(?:RM\s*)?(\d{1,4}[.,]\d{2})$/))) {
      var q = +m[2], each = toSen(m[3]);
      if (q >= 1 && each && Math.abs(q * each - line) <= 1) { t = m[1]; qty = q; }
    } else if ((m = t.match(/^(.*?[A-Za-z].*?)\s+(?:RM\s*)?(\d{1,4}[.,]\d{2})$/))) {
      // "Name  2.20" before a line total of 4.40: a unit price column without a qty column.
      var u = toSen(m[2]);
      if (u && line % u === 0 && line / u >= 1 && line / u <= 50) { t = m[1]; qty = qty > 1 ? qty : line / u; }
    } else if ((m = t.match(/^(.*?[A-Za-z].*?)\s+(\d{1,2})\s+(\d{3,5})$/)) && +m[2] * +m[3] === line) {
      // "Kopi O Peng 3 280": the reader dropped the decimal point of the unit price.
      t = m[1]; qty = +m[2];
    } else if ((m = t.match(/^(.*?[A-Za-z].*?)\s+(\d{1,2})$/))) { t = m[1]; qty = +m[2]; }
    return { name: cleanName(t), qty: Math.max(1, qty || 1) };
  }

  function parseDate(text) {
    var m = text.match(/\b(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/);
    if (m) return iso(+m[1], +m[2], +m[3]);
    m = text.match(/\b(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})\b/);
    if (m) return iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
    return '';
  }
  function iso(y, mo, d) {
    if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return '';
    return y + '-' + (mo < 10 ? '0' : '') + mo + '-' + (d < 10 ? '0' : '') + d;
  }

  function parse(text) {
    var lines = String(text || '').split(/\r?\n/).map(function (l) { return fixDigits(l.replace(/\s+/g, ' ').trim()); }).filter(Boolean);
    var out = { merchant: '', date: parseDate(text || ''), items: [], service: 0, sst: 0, rounding: 0, total: 0 };
    var pendingName = '', seenItem = false, afterTotal = false;
    lines.forEach(function (raw, idx) {
      var m = raw.match(AMOUNT_END);
      if (!m) {
        // A line with a name but no price may be continued on the next line ("2 x 2.20   4.40").
        pendingName = letters(raw) >= 3 && !SKIP.test(raw) && !TOTAL.test(raw) ? raw : '';
        if (!out.merchant && !seenItem && letters(raw) >= 3 && idx < 4 && !/tel|phone|gst|sst|reg|no\.|jalan|jln|street|road|lot|^\d/i.test(raw)) out.merchant = cleanName(raw).slice(0, 60);
        return;
      }
      var amt = toSen(m[1]); if (amt === null) return;
      var text = raw.slice(0, m.index).trim();
      if (ROUNDING.test(text)) { out.rounding = Math.max(-10000, Math.min(10000, amt)); pendingName = ''; return; }
      if (SST.test(text)) { if (!afterTotal) out.sst = Math.abs(amt); pendingName = ''; return; }
      if (SERVICE.test(text)) { if (!afterTotal) out.service = Math.abs(amt); pendingName = ''; return; }
      if (SKIP.test(text)) { pendingName = ''; return; }
      if (TOTAL.test(text)) { if (!out.total || !afterTotal) out.total = Math.abs(amt); afterTotal = true; pendingName = ''; return; }
      if (afterTotal || amt <= 0) return;
      if (letters(text) < 2) {
        if (!pendingName) return;
        text = pendingName + ' ' + text;
      }
      pendingName = '';
      var nq = nameAndQty(text, amt);
      if (letters(nq.name) < 2) return;
      seenItem = true;
      out.items.push({ name: nq.name, qty: nq.qty, line: amt, each: Math.round(amt / nq.qty) });
    });
    out.items = out.items.slice(0, 80);
    return out;
  }

  // Rebuilds the receipt's rows from word positions (Tesseract "blocks" output), so a price at the far right
  // stays on its item's row even when the photo is tilted or the reader split the price column off.
  function rowsFromBlocks(blocks) {
    var lines = [], words = [];
    (blocks || []).forEach(function (b) { (b.paragraphs || []).forEach(function (p) { (p.lines || []).forEach(function (l) { lines.push(l); (l.words || []).forEach(function (w) { words.push(w); }); }); }); });
    // Tilt: the middle slope of the longer baselines. Removing it lines rows up again.
    var slopes = lines.filter(function (l) { return l.baseline && l.baseline.x1 - l.baseline.x0 > 100; })
      .map(function (l) { return (l.baseline.y1 - l.baseline.y0) / (l.baseline.x1 - l.baseline.x0); }).sort(function (a, b) { return a - b; });
    var k = slopes.length ? slopes[slopes.length >> 1] : 0;
    var ws = words.filter(function (w) { return w.text && w.text.trim(); }).map(function (w) {
      var cx = (w.bbox.x0 + w.bbox.x1) / 2, cy = (w.bbox.y0 + w.bbox.y1) / 2;
      return { t: w.text.trim(), x: w.bbox.x0, y: cy - k * cx, h: w.bbox.y1 - w.bbox.y0 };
    });
    if (!ws.length) return '';
    var hs = ws.map(function (w) { return w.h; }).sort(function (a, b) { return a - b; }), mh = hs[hs.length >> 1] || 20;
    ws.sort(function (a, b) { return a.y - b.y; });
    var rows = [];
    ws.forEach(function (w) {
      var r = rows[rows.length - 1];
      if (r && Math.abs(w.y - r.y) < mh * 0.55) { r.w.push(w); r.y += (w.y - r.y) / r.w.length; } else rows.push({ y: w.y, w: [w] });
    });
    return rows.map(function (r) { return r.w.sort(function (a, b) { return a.x - b.x; }).map(function (w) { return w.t; }).join(' '); }).join('\n');
  }

  // How believable a reading is: items and charges found, and a big bonus when they add up to the printed total.
  function score(r) {
    var sum = r.service + r.sst + r.rounding;
    r.items.forEach(function (i) { sum += i.line; });
    return r.items.length + (r.total ? 2 : 0) + (r.service ? 1 : 0) + (r.sst ? 1 : 0) + (r.total && r.items.length && Math.abs(sum - r.total) <= 2 ? 20 : 0);
  }
  function best(readings) {
    return readings.filter(Boolean).reduce(function (a, b) { return !a || score(b) > score(a) ? b : a; }, null);
  }

  return { parse: parse, rowsFromBlocks: rowsFromBlocks, best: best, balanced: function (r) { return score(r) >= 20; } };
});
