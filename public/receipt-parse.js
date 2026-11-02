/* Turns the text read off a receipt photo into items and charges. Shared by the browser and the tests. All amounts are integer sen. */
(function (root, factory) {
  var m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m; else root.ReceiptParse = m;
})(typeof self !== 'undefined' ? self : this, function () {
  // A money amount at the end of a line, optionally "RM", negative or in brackets, then maybe a tax code like "SR" or a stray "|".
  var AMOUNT_STRICT = /(?:^|[^\d.,])(\(?-?\s*(?:RM\s*)?-?\d{1,5}[.,]\s?\d{2}\)?)\s*(?:[A-Z*]{1,2})?\s*\|?\s*$/i;
  // Faded receipts lose the decimal point: "17 80", "10:90" or "1590" also count, but only when the reading then adds up.
  var AMOUNT_LOOSE = /(?:^|[^\d.,:])(\(?-?\s*(?:RM\s*)?-?(?:\d{1,5}[.,:]\s?\d{2}|\d{1,4} \d{2}|\d{3,5}))\)?\s*(?:[A-Z*]{1,2})?\s*\|?\s*$/i;
  var NOT_READ = 'Item not read (check receipt)';
  // Also misread forms ("Subtota", "Suboty") and "Total Sales (Exc. Tax)", which must not be taken for the tax.
  var SUBTOTAL = /sub\s*-?\s*total|\bs[uv][bp]\s*-?\s*[tf]?o[tf]|jumlah\s*kecil|sub\s*-?\s*jumlah|total\s*sales|exc(?:l|\.|lusive)?\s*(?:of\s*)?tax|before\s*tax/i;
  // The column heading above the dishes ("Qty Item Price", "Item Price Qty Discount Amount", "Unit Price ... Amount").
  var HEADER = /\b(?:item|description|desc)\b.*\b(?:price|qty|amount|amt)\b|\bqty\b.*\b(?:item|price|amount|description)\b|unit\s*price.*\bamount\b/i;
  // A dish line that starts with a menu code, maybe after a quantity: "E01 Thai...", "2 F01 Fried...", "M 02 THAI...".
  var DISH_CODE = /^(?:\d{1,2}\s+)?(?:[A-Za-z]{1,2}\s+)?[A-Z]{1,3}\s?[0-9O]?\d[0-9O]?\s*[A-Za-z]{2}/;
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
  var EACH = /[({]\s*(\d{1,4})\s*[.,: ]?\s*(\d{2})\s*\/\s*(?:e\s*a)?\s*\)?/i;

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
    var t = s.replace(EACH, ' ').replace(/^\W*[A-Z]{0,2}\d{1,4}\s*-\s*(?=[A-Za-z])/, '').replace(/\((?:\s|[-+•·*])*\)/g, ' ').replace(/^[^A-Za-z0-9]+/, '').replace(/^[a-z]{1,2}\s+(?=[A-Z0-9])|^[A-Za-z]{1,2}\s+(?=[A-Z]{1,3}\s?\d)/, '');
    for (var k = 0; k < 2; k++) {
      var m = t.match(/^(?:[A-Z]{1,3}\s?)?[0-9O]{1,3}(?=\s*[A-Z])/);
      if (m && /\d/.test(m[0])) t = t.slice(m[0].length).replace(/^\s+/, '');
    }
    return tidy(t.replace(/[\s\-*#.:|_~@x×(]+$/gi, '').replace(/\s{2,}/g, ' ')).replace(/\.(?=\s|$)/g, '').slice(0, 80).trim();
  }
  // The reader only knows English letters, so Chinese words come out as junk ("HBEM®", "#118", "KFWIFAA", "3314)").
  // In a name written in normal case, all-capital words, words with odd symbols and long numbers are that junk.
  function tidy(s) {
    var words = s.split(' '), mixed = words.filter(function (w) { return /^[(]?[A-Z][a-z]{2,}/.test(w); }).length >= 2;
    var keep = words.filter(function (w, i) {
      var core = w.replace(/^[(]+|[),.:;]+$/g, '');
      if (!core) return false;
      if (/[^\x20-\x7E\u00C0-\u017F]|[#$%^@{}<>|\\_~;"“”‘’`]/.test(core)) return false;
      if (!/[A-Za-z0-9&]/.test(core)) return false;
      if (mixed && (/^\d+[.,:]\d{2}$/.test(w) || /^\(?\d+\)?$/.test(w) && /[()]/.test(w) || /\+/.test(w))) return false;
      // A stray one- or two-letter scrap at the end ("Soup ia").
      if (mixed && i === words.length - 1 && /^[a-z]{1,2}$/i.test(core) && !/^(?:ok|xl|up)$/i.test(core)) return false;
      if (mixed && /^[A-Z&]{2,}[^a-z]*$/.test(core) && /[A-Z].*[A-Z]/.test(core) && !/^(?:BBQ|XL|XXL|KL|SG|ABC|TNG|HK|USA|UK|CNY|IPOH)$/.test(core)) return false;
      if (mixed && /^\d{3,}$/.test(core)) return false;
      if (/\d/.test(core) && /[A-Za-z]/.test(core) && !/^\d+(?:pcs?|ml|g|kg|l|oz|pax|in1|nd|st|rd|th)$/i.test(core) && !/^[A-Z]{1,3}\d{1,3}$/.test(core)) return false;
      return true;
    }).join(' ');
    // Mend brackets left open or empty after dropping junk: "(Chicken" -> "(Chicken)".
    if (mixed) keep = keep.replace(/(?:\s+(?!ok$|xl$|up$)[A-Za-z]{1,2})+$/i, '');
    var open = (keep.match(/\(/g) || []).length - (keep.match(/\)/g) || []).length;
    if (open > 0) keep += ')'.repeat(open);
    return keep.replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim();
  }
  function eachOf(s) { var m = s.match(EACH); return m ? +m[1] * 100 + +m[2] : 0; }

  // Splits "2 x Roti Canai", "Roti Canai x2", "Roti Canai 2 @ 2.20" or "Roti Canai  2  2.20" into a name and quantity.
  function nameAndQty(text, line) {
    var t = text.trim().replace(/^\S{1,3}\s+(?=\d{1,2}\s*[xX×]\s+[A-Za-z])/, ''), qty = 1, m;
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
    var totals = [], after = [], subs = [], rndRead = false, pendingName = '', held = '', last = null, itemsDone = false;
    // A row of numbers only ("11.00  1  0.00  11.00", "1  RM 11.90  0.00  RM11.90"): the price row of the name above it.
    var numberRow = function (l) { var x = l && l.match(AMOUNT); return !!x && letters(l.slice(0, x.index).replace(/RM|MYR/gi, '')) < 3; };
    lines.forEach(function (raw, idx) {
      var m = raw.match(AMOUNT), amt = m ? toSen(m[1]) : null;
      // Anything above the column heading is the shop's details, not dishes.
      if (!itemsDone && HEADER.test(raw) && !SUBTOTAL.test(raw)) { out.items = []; last = null; pendingName = held = ''; return; }
      if (amt === null) {
        var lp = +((raw.match(/(\d{1,2})\s*%/) || [])[1] || 0);
        if (lp && SST.test(raw) && !/charge|summary/i.test(raw) && !out.sstPct) out.sstPct = lp;
        if (lp && SERVICE.test(raw) && !SST.test(raw) && !/summary/i.test(raw) && !out.svcPct) out.svcPct = lp;
        var e = eachOf(raw);
        var next = lines[idx + 1] || '', nm = next.match(AMOUNT);
        // A dish name with a note under it ("Caffe Latte" / "Regular, Extra Espresso"), then its row of numbers.
        // Not when that second line is itself a dish ("A102 Ayam Goreng"): then this line is the shop's name.
        if (!itemsDone && idx > 0 && !e && !held && !SKIP.test(raw) && letters(raw) >= 3 && !nm && numberRow(lines[idx + 2]) && !SKIP.test(next) && letters(next) >= 3 && !/^\W*(?:\d{1,2}\s*[xX×]\s*)?[A-Z]{0,3}\d{1,4}\b/.test(next)) { held = raw; return; }
        if (held) { if (numberRow(next)) { pendingName = held + ' ' + raw; held = ''; return; } held = ''; }
        if (!e && (letters(raw) < 3 || SKIP.test(raw) || MODIFIER.test(raw))) { if (/\bqty\b/i.test(raw) && out.items.length) itemsDone = true; return; }
        // A name whose price is on the next line ("2 x 7.50   15.00") waits for it.
        if (numberRow(next)) { pendingName = raw; return; }
        // A dish whose price could not be read ("E01 Thai Hainanese Chicken Rice   . 90"): kept without a price,
        // which is worked out from the totals at the end.
        if (!itemsDone && !e && letters(raw) >= 6 && (DISH_CODE.test(raw.replace(/^[^A-Za-z0-9]+/, '')) || EACH.test(next))) {
          // Drop the garbled price at the end ("Rice.    FE   90", "Rice. EER"): short tokens, numbers, or anything after a full stop.
          var name = cleanName(raw.replace(/\.\s+\S.*$/, '').replace(/(\s+(?:\S{1,2}|\d+))+\s*$/, ''));
          if (letters(name) >= 4) { last = { name: name, qty: 1, line: 0, each: 0, mods: 0, unpriced: true }; out.items.push(last); return; }
        }
        if (out.items.length && (SUBTOTAL.test(raw) || ROUNDING.test(raw) || SERVICE.test(raw) || SST.test(raw) || TOTAL.test(raw))) { itemsDone = true; return; }
        if (last && !itemsDone) {
          // The rest of the dish's name on the next line ("Rice (15.90/ea)"); a price of one there gives the quantity.
          if (e && last.unpriced) last.each = e; else if (e) fitEach(last, e);
          var more = raw.replace(EACH, ' ').replace(/\([^)]*\)?/g, ' ').split(/\s+/).filter(function (w) { return w && !/[()\/]/.test(w); }).join(' ');
          if (letters(more) >= 3 && !TOTAL.test(more) && !SKIP.test(more) && !MODIFIER.test(more)) last.name = (last.name + ' ' + cleanName(more)).slice(0, 80).trim();
          return;
        }
        // The shop name: an early line of words, not an address, a column header, or a dish whose price was lost.
        if (!out.merchant && !out.items.length && idx < 4 && letters(raw) / raw.length > 0.6 && !/\d\s*$/.test(raw) && !/price|item|qty|amount|jalan|jln|road|street|lot|addr|add?iess|phone|company/i.test(raw)) out.merchant = cleanName(raw).slice(0, 60);
        return;
      }
      var text = raw.slice(0, m.index + m[0].indexOf(m[1])).trim();
      var pct = (text.match(/(\d{1,2})\s*%/) || [])[1];
      if (SUBTOTAL.test(text)) { subs.push(Math.abs(amt)); itemsDone = itemsDone || out.items.length > 0; pendingName = ''; return; }
      if (ROUNDING.test(text)) { out.rounding = Math.max(-10000, Math.min(10000, amt)); rndRead = true; itemsDone = itemsDone || out.items.length > 0; return; }
      // The first SST and service amounts win; a "charges summary" after the total repeats them.
      if (SST.test(text) && !/charge/i.test(text) || pct === '6' || pct === '8') { out.sst = out.sst || Math.abs(amt); if (pct && !out.sstPct && !/charge/i.test(text)) out.sstPct = +pct; itemsDone = itemsDone || out.items.length > 0; return; }
      if (SERVICE.test(text) || pct === '10' || pct === '5') { out.service = out.service || Math.abs(amt); if (pct && !out.svcPct) out.svcPct = +pct; itemsDone = itemsDone || out.items.length > 0; return; }
      if (SKIP.test(text)) { if (out.items.length) { itemsDone = true; after.push(Math.abs(amt)); } pendingName = ''; return; }
      if (TOTAL.test(text)) { totals.push(Math.abs(amt)); itemsDone = true; pendingName = ''; return; }
      if (itemsDone) { after.push(Math.abs(amt)); return; }
      if (amt <= 0 || MODIFIER.test(text)) {
        if (amt <= 0) pendingName = '';
        // An add-on under a dish without a price ("+ Thigh + 1.00") helps estimate that dish's price.
        if (amt > 0 && last && last.unpriced) last.mods += amt;
        return;
      }
      if (letters(text.replace(/RM|MYR/gi, '')) < 3) {
        // An amount with its label unreadable: kept, as it may confirm the total.
        if (!pendingName) { if (out.items.length && amt > 0) after.push(amt); return; }
        // The row's other numbers are unit price, quantity and discount: a whole number that times a unit price
        // gives the line total is the quantity.
        var nums = text.match(/\d+(?:[.,]\d{2})?/g) || [], q = 1;
        nums.forEach(function (n) { if (/^\d{1,2}$/.test(n) && +n > 1 && nums.some(function (u) { return /[.,]/.test(u) && toSen(u) * +n === amt; })) q = +n; });
        text = pendingName + (q > 1 ? ' x' + q : '');
      }
      pendingName = '';
      var nq = nameAndQty(text, amt);
      if (letters(nq.name) < 2) return;
      last = { name: nq.name, qty: nq.qty, line: nq.line, each: 0 };
      out.items.push(last);
    });
    out.read = { totals: totals.slice(), after: after.slice(), subs: subs.slice(), rndRead: rndRead, rounding: out.rounding, sstPct: out.sstPct, svcPct: out.svcPct };
    reconcile(out, totals, after, subs, rndRead);
    return out;
  }

  // Receipts that print the price of one under each dish ("(12.00/ea)") and add-ons as "+Chicken + 3.00" (FeedMe and
  // others): each dish's price comes from those printed numbers, so a price column that the photo blurred, or that
  // landed on the wrong row, does not matter. The subtotal and charges are read as usual and must still agree.
  var ADDON = /[+«]\s*(\d{1,2})\s?[.,: ]?\s?(\d{2})(?!\d)/;
  function parseEach(text, AMOUNT) {
    var base = parseWith(text, AMOUNT), r = base.read, dishes = [], buf = [], last = null;
    var lines = String(text || '').split(/\r?\n/).map(function (l) { return fixDigits(l.replace(/\s+/g, ' ').trim()).replace(/\((\d)\s+(\d)/g, '($1$2'); }).filter(Boolean);
    for (var k = 0; k < lines.length; k++) {
      var raw = lines[k];
      if (HEADER.test(raw) && !SUBTOTAL.test(raw)) { buf = []; dishes = []; last = null; continue; }
      if (dishes.length && (SUBTOTAL.test(raw) || TOTAL.test(raw) || ROUNDING.test(raw) || /^\W*\d{1,2}\s*(?:q\w{0,2}|ay|oty|city)\b/i.test(raw))) break;
      var e = eachOf(raw), a = raw.match(ADDON);
      if (a && last && !e && (MODIFIER.test(raw) || /^\W*[-+.•·*]/.test(raw))) { last.mods += +a[1] * 100 + +a[2]; continue; }
      buf.push(raw); if (buf.length > 3) buf.shift();
      if (e) { last = { lines: buf, each: e, mods: 0 }; dishes.push(last); buf = []; }
    }
    if (dishes.length < 2) return null;
    var out = { merchant: base.merchant, date: base.date, service: base.service, sst: base.sst, rounding: r.rounding, total: 0, sstPct: r.sstPct, svcPct: r.svcPct };
    out.items = dishes.map(function (d) {
      // The dish starts at its quantity ("1 13 Fried Hand-Pulled Noodle"); lines above that are left-over junk.
      var ls = d.lines, s = 0;
      ls.forEach(function (l, i) { if (/^\W*\d{1,2}\s/.test(l) || /^\W*\d[&£]\d/.test(l)) s = i; });
      ls = ls.slice(s);
      var qm = ls[0].match(/^\W*([2-9])\s+(?:[xX×]\s*)?\S/), qty = qm ? +qm[1] : 1;
      // A quantity above 1 must be backed by its line total somewhere on the dish's lines; otherwise it is a misread.
      if (qty > 1 && !(ls.join(' ').match(/\d{1,4}[.,:]\s?\d{2}/g) || []).some(function (n) { return toSen(n) === d.each * qty + d.mods; })) qty = 1;
      var name = ls.join(' ').replace(EACH, ' ').replace(/\([^)]*\/\s*\w*\)?/g, ' ').replace(/^\W*\d{1,2}\s+(?:[xX×]\s+)?/, '').replace(/^\W*\d[&£]\d\s*/, '')
        .replace(/\s+\d{1,4}(?:[.,:]\s?\d{2})?(?:\s+\S{1,2})?\s*$/, '');
      var pm = name.match(/^([^(]*)\(([^)]*)\)?/), real = function (x) { return (x.match(/\b(?:[A-Z][a-z]{2,}|[a-z]{3,})\b/g) || []).length; };
      if (pm && !real(pm[1].replace(/^\W*\d{1,2}\s+\S+/, '')) && real(pm[2]) >= 2) name = pm[2];
      return { name: cleanName(name.replace(/(?:\s+\S{1,2})*\s+\d{1,2}\s*$/, '')).replace(/\s+\d{1,2}$/, '') || 'Item', qty: qty, line: d.each * qty + d.mods, each: 0 };
    });
    reconcile(out, r.totals.slice(), r.after.slice(), r.subs.slice(), r.rndRead);
    return out;
  }

  // Makes the reading tally with the receipt when the receipt's own numbers can be trusted:
  // a dish whose price was unreadable gets what is left of the subtotal, unread rounding gets the last few sen,
  // and any other gap becomes one "Item not read" line for the payer to rename.
  function reconcile(out, totals, after, subs, rndRead) {
    var priced = function () { var s = 0; out.items.forEach(function (i) { s += i.line; }); return s; };
    // The total is the biggest "total" line (a subtotal, perhaps read as "total" from a clipped "Subtotal", is smaller).
    totals.sort(function (a, b) { return b - a; });
    var T = totals[0] || 0;
    if (T && fixCharges(out, T, subs.concat(totals.slice(1), after, [priced()]), rndRead)) rndRead = true;
    var byRate = 0, rates = { svc: out.svcPct, sst: out.sstPct };
    delete out.sstPct; delete out.svcPct;
    // When no total was read, a charge that disagrees with its own printed rate ("SST (6%)  0.75" on a RM 56.00
    // subtotal) is a misread, and so is one with no amount: both are worked out from the rate. (With a total, the
    // amounts as read stand: service is sometimes charged on only part of the bill, such as dine-in dishes.)
    // Done once the dishes' prices are known (now if the subtotal was read, otherwise after they are worked out).
    var applyRates = function (base) {
      var near = function (v, pct, b2) { return Math.abs(v - Math.round(base * pct / 100)) <= 1 || Math.abs(v - Math.round(b2 * pct / 100)) <= 1; };
      if (rates.svc && (!out.service || !T && !near(out.service, rates.svc, base))) { out.service = Math.round(base * rates.svc / 100); byRate++; }
      if (rates.sst && (!out.sst || !T && !near(out.sst, rates.sst, base + out.service))) { out.sst = Math.round(base * rates.sst / 100); byRate++; }
      rates = {};
    };
    if (subs[0] || priced()) applyRates(subs[0] || priced());
    var charges = out.service + out.sst;
    // The subtotal: a printed amount that, with the service charge and SST, comes within 5 sen of the total.
    var sub = subs.concat(totals.slice(1), after).filter(function (c) { return T && c <= T && Math.abs(T - c - charges - (rndRead ? out.rounding : 0)) <= 5; })[0] || 0;
    // Trust the total only if the receipt confirms it: subtotal plus charges, or the same amount paid (VISA, cash).
    var trusted = T && (sub || after.indexOf(T) > -1 || totals.indexOf(T, 1) > -1);
    if (sub && !rndRead) out.rounding = T - sub - charges;
    var target = sub || (trusted ? T - charges - out.rounding : 0);
    var open = out.items.filter(function (i) { return i.unpriced; });
    out.filled = byRate;
    if (target) {
      // Dishes without a price: one takes whatever is left; several use their "(x/ea)" + add-ons estimate first.
      open.forEach(function (i) { if (open.length > 1 && i.each) { i.line = i.each * i.qty + i.mods; i.filled = true; out.filled++; } });
      var rest = open.filter(function (i) { return !i.line; }), gap = target - priced();
      if (rest.length === 1 && gap > 0) { rest[0].line = gap; rest[0].filled = true; out.filled++; }
    } else {
      open.forEach(function (i) { if (i.each) { i.line = i.each * i.qty + i.mods; i.filled = true; out.filled++; } });
    }
    out.items = out.items.filter(function (i) { return i.line > 0; }).slice(0, 80);
    if (rates.svc || rates.sst) { applyRates(priced()); out.filled += byRate; charges = out.service + out.sst; }
    if (target) {
      var left = target - priced();
      // Unread rounding: total minus everything else, when that is only a few sen.
      if (!sub && !rndRead && Math.abs(left) <= 5) { out.rounding += left; left = 0; }
      if (left >= 10) { out.items.push({ name: NOT_READ, qty: 1, line: left, filled: true }); out.filled++; }
    }
    out.items.forEach(function (i) { i.each = Math.round(i.line / i.qty); delete i.unpriced; delete i.mods; });
    var sum = priced() + charges + out.rounding;
    out.total = T;
    if (!T || Math.abs(T - sum) > 2) {
      var match = totals.concat(after, subs).filter(function (a) { return Math.abs(a - sum) <= 2; })[0];
      if (match) out.total = match;
    }
  }

  // A misread SST or service amount ("2.68" for 2.88), or one not read at all: if the usual rates (SST 6% or 8%,
  // service 5% or 10%) on a printed subtotal bring the total to within 2 sen (the 5-sen rounding), use them.
  // Amounts as read are kept whenever they already add up.
  function fixCharges(out, T, bases, rndRead) {
    var ok = function (S) { return S > 0 && S < T; }, rnd = rndRead ? out.rounding : 0;
    if (bases.some(function (S) { return ok(S) && Math.abs(T - S - out.service - out.sst - rnd) <= (rndRead ? 2 : 5); })) return false;
    var pick = null;
    bases.filter(ok).forEach(function (S) {
      [[out.service, 0], [Math.round(S * 0.1), 1], [Math.round(S * 0.05), 1], [0, 2]].forEach(function (v) {
        var B = S + v[0];
        [[out.sst, 0], [Math.round(S * 0.06), 1], [Math.round(S * 0.08), 1], [Math.round(B * 0.06), 1], [Math.round(B * 0.08), 1], [0, 2]].forEach(function (x) {
          var r = T - S - v[0] - x[0], cost = v[1] + x[1] + (rndRead && r !== out.rounding ? 1 : 0);
          if (Math.abs(r) <= 2 && (!pick || cost < pick.cost)) pick = { svc: v[0], sst: x[0], r: r, cost: cost };
        });
      });
    });
    if (!pick) return false;
    out.service = pick.svc; out.sst = pick.sst; out.rounding = pick.r;
    return true;
  }

  function parse(text) {
    var strict = parseWith(text, AMOUNT_STRICT), each = parseEach(text, AMOUNT_STRICT);
    // Prices worked out from "(x/ea)" notes win when they add up; they do not depend on the price column at all.
    if (each && balanced(each)) return done(each);
    if (balanced(strict)) return done(strict);
    // The loose reading (prices without a decimal point) wins only when it is more believable.
    return done(best([strict, each, parseWith(text, AMOUNT_LOOSE), parseEach(text, AMOUNT_LOOSE)]));
  }
  function done(r) { delete r.read; return r; }

  // Rebuilds the receipt's rows from word positions (Tesseract "blocks" output), so a price at the far right
  // stays on its item's row even when the photo is tilted or the reader split the price column off.
  function rowsFromBlocks(blocks) {
    var words = [];
    (blocks || []).forEach(function (b) { (b.paragraphs || []).forEach(function (p) { (p.lines || []).forEach(function (l) { (l.words || []).forEach(function (w) { words.push(w); }); }); }); });
    // Removing the tilt lines rows up again.
    var k = Math.tan(tilt(blocks));
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

  // How far the photo is turned, in radians (positive: lines run down to the right): the middle slope of the
  // longer text baselines Tesseract found.
  function tilt(blocks) {
    var slopes = [];
    (blocks || []).forEach(function (b) { (b.paragraphs || []).forEach(function (p) { (p.lines || []).forEach(function (l) {
      var bl = l.baseline;
      if (bl && bl.x1 - bl.x0 > 100) slopes.push((bl.y1 - bl.y0) / (bl.x1 - bl.x0));
    }); }); });
    slopes.sort(function (a, b) { return a - b; });
    return slopes.length ? Math.atan(slopes[slopes.length >> 1]) : 0;
  }

  // Black and white by comparing each pixel with its neighbourhood (not one level for the whole photo), so shadows,
  // folds and coloured or watermarked paper drop out and the print stays. Works on canvas ImageData in place.
  // The brightest colour channel is used, so orange or green paper counts as light.
  function binarize(img) {
    var W = img.width, H = img.height, d = img.data, g = new Uint8Array(W * H), I = new Float64Array((W + 1) * (H + 1));
    for (var i = 0; i < W * H; i++) g[i] = Math.max(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
    for (var y = 0; y < H; y++) { var row = 0; for (var x = 0; x < W; x++) { row += g[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row; } }
    var r = Math.max(8, Math.round(W / 50));
    for (y = 0; y < H; y++) {
      var ya = Math.max(0, y - r), yb = Math.min(H, y + r + 1);
      for (x = 0; x < W; x++) {
        var xa = Math.max(0, x - r), xb = Math.min(W, x + r + 1);
        var mean = (I[yb * (W + 1) + xb] - I[ya * (W + 1) + xb] - I[yb * (W + 1) + xa] + I[ya * (W + 1) + xa]) / ((xb - xa) * (yb - ya));
        var v = g[y * W + x] < mean * 0.85 ? 0 : 255, j = (y * W + x) * 4;
        d[j] = d[j + 1] = d[j + 2] = v; d[j + 3] = 255;
      }
    }
    return img;
  }

  // How believable a reading is: items and charges found, a big bonus when they add up to a printed total,
  // and a penalty for every price that had to be worked out instead of read (the "Item not read" line most of all).
  function score(r) {
    var sum = r.service + r.sst + r.rounding, guess = 0;
    r.items.forEach(function (i) { sum += i.line; if (i.name === NOT_READ) guess = 15; });
    return r.items.length + (r.total ? 2 : 0) + (r.service ? 1 : 0) + (r.sst ? 1 : 0) + (r.total && r.items.length && Math.abs(sum - r.total) <= 2 ? 20 : 0)
      - 3 * (r.filled || 0) - guess;
  }
  // Read cleanly: adds up with nothing worked out.
  function balanced(r) { return score(r) >= 20 && !r.filled; }
  // Good enough to stop reading: adds up, with at most one dish's price worked out and no "Item not read" line.
  function goodEnough(r) {
    return balanced(r) || (r.filled === 1 && score(r) >= 20 && !r.items.some(function (i) { return i.name === NOT_READ; }));
  }
  function best(readings) {
    return readings.filter(Boolean).reduce(function (a, b) { return !a || score(b) > score(a) ? b : a; }, null);
  }

  // Reads the amount paid off a bank or e-wallet slip (Maybank2u, CIMB, TNG, DuitNow...). Returns every
  // plausible amount, best first: on an "amount" line, or written with RM / MYR; never a balance, fee or limit.
  function slipAmounts(text) {
    var found = [];
    String(text || '').split(/\r?\n/).forEach(function (raw) {
      var line = fixDigits(raw.replace(/\s+/g, ' ').trim());
      if (!line || /balance|baki|fee|caj|limit|available|points|cashback|rebate/i.test(line)) return;
      var labelled = /amount|amaun|jumlah|total|paid|transfer|pindahan|bayar|payment|sent/i.test(line);
      var re = /(RM|MYR)?\s*-?\s*(\d{1,3}(?:,\d{3})+|\d{1,7})[.,](\d{2})(?!\d)/gi, m;
      while ((m = re.exec(line))) {
        var sen = Math.round(parseFloat(m[2].replace(/,/g, '') + '.' + m[3]) * 100);
        if (!sen || (!labelled && !m[1])) continue;
        found.push({ sen: sen, score: (labelled ? 2 : 0) + (m[1] ? 1 : 0) });
      }
    });
    found.sort(function (a, b) { return b.score - a.score; });
    var seen = {};
    return found.filter(function (f) { return seen[f.sen] ? false : (seen[f.sen] = true); }).map(function (f) { return f.sen; });
  }
  // Does the slip show the amount owed? "match" (with the amount), "mismatch" (with what it shows instead) or "unread".
  function checkSlip(text, expected) {
    var all = slipAmounts(text);
    if (all.some(function (a) { return Math.abs(a - expected) <= 1; })) return { result: 'match', amount: expected };
    return all.length ? { result: 'mismatch', amount: all[0] } : { result: 'unread', amount: 0 };
  }

  return { parse: parse, rowsFromBlocks: rowsFromBlocks, tilt: tilt, binarize: binarize, best: best, balanced: balanced, goodEnough: goodEnough, slipAmounts: slipAmounts, checkSlip: checkSlip };
});
