/* Turns the text read off a receipt photo into items and charges. Shared by the browser and the tests. All amounts are integer sen. */
(function (root, factory) {
  var m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m; else root.ReceiptParse = m;
})(typeof self !== 'undefined' ? self : this, function () {
  // A money amount at the end of a line, optionally "RM", negative or in brackets, then maybe a tax code like "SR" or a stray "|".
  var AMOUNT_STRICT = /(?:^|[^\d.,])(\(?-?\s*(?:RM\s*)?-?\d{1,5}[.,]\s?\d{2}\)?)\s*(?:[A-Z*]{1,2})?\s*\|?\s*$/i;
  // Faded receipts lose the decimal point: "17 80", "10:90" or "1590" also count, but only when the reading then adds up.
  var AMOUNT_LOOSE = /(?:^|[^\d.,:])(\(?-?\s*(?:RM\s*)?-?(?:\d{1,5}[.,:]\s?\d{2}|\d{1,4} \d{2}|\d{3,5}))\)?\s*(?:[A-Z*]{1,2})?\s*\|?\s*$/i;
  var SKIP = /sub\s*-?\s*total|jumlah\s*kecil|sub\s*-?\s*jumlah|cash|tunai|change|baki|balance|paid|tender|card|visa|master|amex|debit|credit|e-?wallet|tng|touch\s*n|grab\s*pay|boost|duitnow|qr\s*pay|item\s*count|no\.?\s*of\s*items|\bqty\b|discount|diskaun|voucher|deposit|\btel\b|phone|fax|invoice|receipt\s*no|bill\s*no|order\s*no|\btable\b|\bpax\b|cashier|\bdate\b|\btime\b|base\s*amt|summary/i;
  // Labels can lose their first letters at a curled edge ("ST (6%)", "RVICE CHARGE"), so these match fragments too.
  var SST = /\bs?st\b|\bgst\b|service\s*tax|\btax\b|cukai/i;
  var SERVICE = /serv|rvice|svc|s\/c|charge|caj|perkhidmatan/i;
  var ROUNDING = /round|bundar/i;
  var TOTAL = /total|jumlah|amount\s*due|nett|grand|\(myr\)|\(rm\)/i;
  // Add-ons printed under a dish ("• Thigh + 1.00"); their price is already in the dish's line.
  var MODIFIER = /^[^A-Za-z0-9(]*[+•·®*]|\+\s*$/;
  // "(8.90/ea)" or "(7.90/" : the price of one, printed beside or under a dish.
  // The "(" is required: without it the start of the number may have been cut off ("0.90/ea)" from "(10.90/ea)").
  var EACH = /\(\s*(\d{1,4})\s*[.,: ]?\s*(\d{2})\s*\/\s*(?:e\s*a)?\s*\)?/i;

  function toSen(s) {
    var t = String(s).trim(), neg = /^\(|-/.test(t);
    var d = t.replace(/[()\sA-Za-z-]/g, '').replace(/[,:]/, '.');
    if (d.indexOf('.') < 0) { var raw = t.replace(/[^\d]/g, ''); if (raw.length < 3) return null; d = raw.slice(0, -2) + '.' + raw.slice(-2); }
    var n = parseFloat(d);
    if (!isFinite(n)) return null;
    return Math.round(n * 100) * (neg ? -1 : 1);
  }
  // Common misreads inside numbers: O for 0, l or I for 1.
  function fixDigits(line) {
    return line.replace(/(\d)[Oo](?=\d|[.,])/g, '$10').replace(/([.,])[Oo]/g, '$10').replace(/[Oo](?=[.,]\d)/g, '0')
      .replace(/(\d)[lI](?=\d|[.,])/g, '$11').replace(/([.,]\d)[Oo]\b/g, '$10');
  }
  function letters(s) { return (s.match(/[A-Za-z]/g) || []).length; }
  // Drops menu codes ("E01", "WO2", "AD06", "M 02", "Z03Bralsed"), price-of-one notes, "(-)" marks and stray symbols.
  function cleanName(s) {
    var t = s.replace(EACH, ' ').replace(/\((?:\s|[-+•·*])*\)/g, ' ').replace(/^[^A-Za-z0-9]+/, '').replace(/^[a-z]{1,2}\s+(?=[A-Z0-9])|^[A-Za-z]{1,2}\s+(?=[A-Z]{1,3}\s?\d)/, '');
    for (var k = 0; k < 2; k++) {
      var m = t.match(/^(?:[A-Z]{1,3}\s?)?[0-9O]{1,3}(?=\s*[A-Z])/);
      if (m && /\d/.test(m[0])) t = t.slice(m[0].length).replace(/^\s+/, '');
    }
    return t.replace(/[\s\-*#.:|_~@x×(]+$/gi, '').replace(/\s{2,}/g, ' ').slice(0, 80).trim();
  }
  function eachOf(s) { var m = s.match(EACH); return m ? +m[1] * 100 + +m[2] : 0; }

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
    // A quantity must divide the line into a whole price of at least RM 1; otherwise it is a misread menu code.
    if (qty > 1 && (line % qty !== 0 || line / qty < 100)) qty = 1;
    var it = { name: cleanName(t), qty: Math.max(1, Math.round(qty) || 1), line: line };
    var e = eachOf(t);
    if (e) fitEach(it, e);
    return it;
  }
  // The printed price of one ("(8.90/ea)") settles the quantity: 17.80 at 8.90 each is 2. If the line total
  // is not a whole number of them, one of the two numbers was misread; the quantity times the price of one wins.
  function fitEach(it, e) {
    var n = it.line / e, was = it.line / it.qty;
    if (n === Math.round(n) && n >= 1 && n <= 50) it.qty = n;
    // Only a near miss is corrected (30.00 each read as 50.00); a far-off number is more likely the misread one.
    else if (e >= was / 2 && e <= was * 2) it.line = e * it.qty;
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

  function parseWith(text, AMOUNT) {
    var lines = String(text || '').split(/\r?\n/).map(function (l) { return fixDigits(l.replace(/\s+/g, ' ').trim()); }).filter(Boolean);
    var out = { merchant: '', date: parseDate(text || ''), items: [], service: 0, sst: 0, rounding: 0, total: 0 };
    var totals = [], after = [], pendingName = '', last = null, itemsDone = false;
    lines.forEach(function (raw, idx) {
      var m = raw.match(AMOUNT), amt = m ? toSen(m[1]) : null;
      if (amt === null) {
        var e = eachOf(raw);
        if (!e && (letters(raw) < 3 || SKIP.test(raw) || MODIFIER.test(raw))) { if (/\bqty\b/i.test(raw) && out.items.length) itemsDone = true; return; }
        // A name whose price is on the next line ("2 x 7.50   15.00") waits for it.
        var next = lines[idx + 1] || '', nm = next.match(AMOUNT);
        if (nm && letters(next.slice(0, nm.index)) < 2) { pendingName = raw; return; }
        if (last && !itemsDone) {
          // The rest of the dish's name on the next line ("Rice (15.90/ea)"); a price of one there gives the quantity.
          if (e) fitEach(last, e);
          var more = raw.replace(EACH, ' ').replace(/\([^)]*\)?/g, ' ').split(/\s+/).filter(function (w) { return w && !/[()\/]/.test(w); }).join(' ');
          if (letters(more) >= 3 && !TOTAL.test(more) && !SKIP.test(more) && !MODIFIER.test(more)) last.name = (last.name + ' ' + cleanName(more)).slice(0, 80).trim();
          return;
        }
        // The shop name: an early line of words, not an address, a column header, or a dish whose price was lost.
        if (!out.merchant && !out.items.length && idx < 4 && letters(raw) / raw.length > 0.6 && !/\d\s*$/.test(raw) && !/price|item|qty|amount|jalan|jln|road|street|lot/i.test(raw)) out.merchant = cleanName(raw).slice(0, 60);
        return;
      }
      var text = raw.slice(0, m.index + m[0].indexOf(m[1])).trim();
      var pct = (text.match(/(\d{1,2})\s*%/) || [])[1];
      if (ROUNDING.test(text)) { out.rounding = Math.max(-10000, Math.min(10000, amt)); itemsDone = itemsDone || out.items.length > 0; return; }
      // The first SST and service amounts win; a "charges summary" after the total repeats them.
      if (SST.test(text) && !/charge/i.test(text) || pct === '6' || pct === '8') { out.sst = out.sst || Math.abs(amt); itemsDone = itemsDone || out.items.length > 0; return; }
      if (SERVICE.test(text) || pct === '10' || pct === '5') { out.service = out.service || Math.abs(amt); itemsDone = itemsDone || out.items.length > 0; return; }
      if (SKIP.test(text)) { if (out.items.length) { itemsDone = true; after.push(Math.abs(amt)); } pendingName = ''; return; }
      if (TOTAL.test(text)) { totals.push(Math.abs(amt)); itemsDone = true; pendingName = ''; return; }
      if (itemsDone) { after.push(Math.abs(amt)); return; }
      if (amt <= 0 || MODIFIER.test(text)) return;
      if (letters(text) < 2) {
        if (!pendingName) return;
        text = pendingName + ' ' + text;
      }
      pendingName = '';
      var nq = nameAndQty(text, amt);
      if (letters(nq.name) < 2) return;
      last = { name: nq.name, qty: nq.qty, line: nq.line, each: 0 };
      out.items.push(last);
    });
    out.items = out.items.slice(0, 80);
    out.items.forEach(function (i) { i.each = Math.round(i.line / i.qty); });
    // The total is the biggest "total" line (a subtotal is smaller). If none was read, use the printed amount that matches what was read.
    var sum = out.service + out.sst + out.rounding;
    out.items.forEach(function (i) { sum += i.line; });
    totals.sort(function (a, b) { return b - a; });
    out.total = totals[0] || 0;
    if (!out.total || Math.abs(out.total - sum) > 2) {
      var match = totals.concat(after).filter(function (a) { return Math.abs(a - sum) <= 2; })[0];
      if (match) out.total = match;
    }
    return out;
  }

  function parse(text) {
    var strict = parseWith(text, AMOUNT_STRICT);
    if (balanced(strict)) return strict;
    var loose = parseWith(text, AMOUNT_LOOSE);
    // Loose reading wins only when it adds up, or finds clearly more items.
    return balanced(loose) || loose.items.length > strict.items.length + 1 ? loose : strict;
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

  // How believable a reading is: items and charges found, and a big bonus when they add up to a printed total.
  function score(r) {
    var sum = r.service + r.sst + r.rounding;
    r.items.forEach(function (i) { sum += i.line; });
    return r.items.length + (r.total ? 2 : 0) + (r.service ? 1 : 0) + (r.sst ? 1 : 0) + (r.total && r.items.length && Math.abs(sum - r.total) <= 2 ? 20 : 0);
  }
  function balanced(r) { return score(r) >= 20; }
  function best(readings) {
    return readings.filter(Boolean).reduce(function (a, b) { return !a || score(b) > score(a) ? b : a; }, null);
  }

  return { parse: parse, rowsFromBlocks: rowsFromBlocks, best: best, balanced: balanced };
});
