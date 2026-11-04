/* Turns the text read off a receipt photo into items and charges. Shared by the browser and the tests. All amounts are integer sen. */
(function (root, factory) {
  var m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m; else root.ReceiptParse = m;
})(typeof self !== 'undefined' ? self : this, function () {
  // A money amount at the end of a line, optionally "RM", negative or in brackets, then maybe a tax code like "SR" or a stray "|".
  var AMOUNT_STRICT = /(?:^|[^\d.,])(\(?-?\s*(?:RM\s*)?-?\d{1,7}[.,]\s?\d{2}\)?)\s*(?:[A-Z*]{1,2})?\s*\|?\s*$/i;
  // Faded receipts lose the decimal point: "17 80", "10:90" or "1590" also count, but only when the reading then adds up.
  var AMOUNT_LOOSE = /(?:^|[^\d.,:])(\(?-?\s*(?:RM\s*)?-?(?:\d{1,5}[.,:]\s?\d{2}|\d{1,4} \d{2}|\d{3,5}))\)?\s*(?:[A-Z*]{1,2})?\s*\|?\s*$/i;
  var NOT_READ = 'Item not read (check receipt)';
  // Also misread forms ("Subtota", "Suboty") and "Total Sales (Exc. Tax)", which must not be taken for the tax.
  var SUBTOTAL = /sub\s*-?\s*total|\bs[uv][bp]\s*-?\s*[tf]?o[tf]|jumlah\s*kecil|sub\s*-?\s*jumlah|total\s*sales|exc(?:l|\.|lusive)?\s*(?:of\s*)?tax|before\s*tax/i;
  // The column heading above the dishes ("Qty Item Price", "Item Price Qty Discount Amount", "Unit Price ... Amount").
  var HEADER = /\b(?:item|description|desc)\b.*\b(?:price|qty|amount|amt)\b|\bqty\b.*\b(?:item|price|amount|description)\b|unit\s*price.*\bamount\b/i;
  // A dish line that starts with a menu code, maybe after a quantity: "E01 Thai...", "2 F01 Fried...", "M 02 THAI...".
  var DISH_CODE = /^(?:\d{1,2}\s+)?(?:[A-Za-z]{1,2}\s+)?[A-Z]{1,3}\s?[0-9O]?\d[0-9O]?\s*[A-Za-z]{2}/;
  var SKIP = /quantity|total\s*items?\b|items?\s*\(s\)|saving|sub\s*-?\s*total|jumlah\s*kecil|sub\s*-?\s*jumlah|cash|tunai|change|baki|balance|paid|tender|card|visa|master|amex|debit|credit|e-?wallet|tng|touch\s*n|grab\s*pay|boost|duitnow|qr\s*pay|item\s*count|no\.?\s*of\s*items|\bqty\b|discount|diskaun|voucher|deposit|\btel\b|phone|fax|invoice|receipt\s*no|bill\s*no|order\s*no|\btable\b|\bpax\b|cashier|\bdate\b|\btime\b|base\s*amt|summary/i;
  // Labels can lose their first letters at a curled edge ("ST (6%)", "RVICE CHARGE"), so these match fragments too.
  var SST = /\bs?st\b|\bgst\b|service\s*tax|\btax\b|cukai|\bvat\b|\bppn\b|\bpb1\b|\bthue\b/i;
  var SERVICE = /serv|rvice|svc|s\/c|charge|caj|perkhidmatan/i;
  var ROUNDING = /round|bundar/i;
  // Also Vietnamese "tổng cộng / thanh toán" and "tổng tiền", as the reader prints them without accents.
  var TOTAL = /total|jota[l1]|\bt[o0]a\b|\bt[o0][tl][a4ei][l1i\]n]|jumlah|amount\s*due|nett|grand|\(myr\)|\(rm\)|t[oổ]ng\s*c[oộ]ng|t[oổ]ng\s*ti[eề]n|thanh\s*to[aá]n/i;
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
  // A Japanese or Korean character counts as two letters: a dish can be just two of them.
  function letters(s) { return (s.match(/[A-Za-z]/g) || []).length + (s.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3\uff66-\uff9f]/g) || []).length * 2; }
  // Drops menu codes ("E01", "WO2", "AD06", "M 02", "Z03Bralsed"), price-of-one notes, "(-)" marks and stray symbols.
  function cleanName(s) {
    // Trade marks ("Soup™") and the asterisks some tills print around dishes and options ("(Dry)* *(L) Upsize") are not part of the name.
    var t = s.replace(/[™®©℠]/g, '').replace(/\*/g, ' ').replace(EACH, ' ').replace(/^\W*[A-Z]{0,2}\d{1,4}\s*-\s*(?=[A-Za-z])/, '').replace(/\((?:\s|[-+•·*])*\)/g, ' ').replace(/^[^A-Za-z0-9\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3\uff66-\uff9f]+/, '').replace(/^[A-Za-z]{1,3}\d{1,3}(?=[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3\uff66-\uff9f])/, '').replace(/^[a-z]{1,2}\s+(?=[A-Z0-9])|^[A-Za-z]{1,2}\s+(?=[A-Z]{1,3}\s?\d)/, '');
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
      if (/[^\x20-\x7E\u00C0-\u017F\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3\uff66-\uff9f]|[#$%^@{}<>|\\_~;"“”‘’`]/.test(core)) return false;
      if (!/[A-Za-z0-9&\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3\uff66-\uff9f]/.test(core)) return false;
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
    if ((m = t.match(/^(\d{1,2})\s*[xX×*]\s*(.+)$/)) || (m = t.match(/^(\d{1,2})\s+([A-Za-z\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3\uff66-\uff9f].+)$/))) { qty = +m[1]; t = m[2]; }
    else if ((m = t.match(/^(.+?)\s*[xX×]\s*(\d{1,2})$/))) { t = m[1]; qty = +m[2]; }
    // Trailing "unit price qty" columns before the line total ("Fish  16.80  1  16.80").
    if ((m = t.match(/^(.*?[A-Za-z\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3\uff66-\uff9f].*?)\s+(?:RM\s*)?(\d{1,4}[.,]\d{2})\s+(\d{1,2})$/)) && toSen(m[2]) * +m[3] === line) { t = m[1]; qty = +m[3]; }
    // Trailing "qty @ unit price" or "qty unit price" columns before the line total.
    else if ((m = t.match(/^(.*?[A-Za-z\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3\uff66-\uff9f].*?)\s+(\d{1,2})\s*(?:[@xX×]\s*)?(?:RM\s*)?(\d{1,4}[.,]\d{2})$/))) {
      var q = +m[2], each = toSen(m[3]);
      if (q >= 1 && each && Math.abs(q * each - line) <= 1) { t = m[1]; qty = q; }
    } else if ((m = t.match(/^(.*?[A-Za-z\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3\uff66-\uff9f].*?)\s+(?:RM\s*)?(\d{1,4}[.,]\d{2})$/))) {
      // "Name  2.20" before a line total of 4.40: a unit price column without a qty column.
      var u = toSen(m[2]);
      if (u && line % u === 0 && line / u >= 1 && line / u <= 50) { t = m[1]; qty = qty > 1 ? qty : line / u; }
    } else if ((m = t.match(/^(.*?[A-Za-z\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3\uff66-\uff9f].*?)\s+(\d{1,2})\s+(\d{3,5})$/)) && +m[2] * +m[3] === line) {
      // "Kopi O Peng 3 280": the reader dropped the decimal point of the unit price.
      t = m[1]; qty = +m[2];
    } else if ((m = t.match(/^(.*?[A-Za-z\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3\uff66-\uff9f].*?)\s+(\d{1,2})$/))) { t = m[1]; qty = +m[2]; }
    // A quantity must divide the line into a whole price of at least RM 1; otherwise it is a misread menu code.
    if (qty > 1 && (line % qty !== 0 || line / qty < 100)) qty = 1;
    // A misread price of one, left behind a Chinese, Japanese or Korean name.
    if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3]/.test(t)) t = t.replace(/\s+\d{1,4}\.\d{2}(?:\s+\d{1,2})?$/, '');
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

  // Every date-like text is a candidate ("15/03/2018", "07-03-2018", "18-03-18", "2018/03/27"); the one on a "Date"
  // line or followed by a time wins, and one in an address or a document number loses. Smudged digits inside a date
  // ("Q2/01/2018", "l7/02/i7") are mended first. Both separators must match, so "7.02/7.03" is not a date.
  function parseDate(text) {
    var best = '', top = -99;
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var l = line.replace(/[\dOoQlIi|]{1,4}(?:[\/.-][\dOoQlIi|]{1,4}){2}/g, function (t) { return /\d/.test(t) ? t.replace(/[OoQ]/g, '0').replace(/[lIi|]/g, '1') : t; });
      var re = /\b(\d{4})([-\/.])(\d{1,2})\2(\d{1,2})\b|\b(\d{1,2})([-\/.])(\d{1,2})\6(\d{4}|\d{2})\b/g, m;
      while ((m = re.exec(l))) {
        var d = m[1] ? iso(+m[1], +m[3], +m[4]) : iso(m[8].length === 2 ? 2000 + +m[8] : +m[8], +m[7], +m[5]);
        if (!d) continue;
        var before = l.slice(0, m.index), dated = /dat[ea]|cate|tarikh|tkh/i.test(line);
        var sc = (dated ? 4 : 0) + (/^\s*\(?\s*\d{1,2}[:.]\d{2}/.test(l.slice(m.index + m[0].length)) ? 2 : 0) - (!dated && /lot|jalan|jln|tel|fax|no\b|inv|doc|reg/i.test(before) ? 3 : 0);
        if (sc > top) { top = sc; best = d; }
      }
    });
    return best;
  }
  function iso(y, mo, d) {
    if (y < 2000 || y > new Date().getFullYear() + 1 || mo < 1 || mo > 12 || d < 1 || d > 31) return '';
    return y + '-' + (mo < 10 ? '0' : '') + mo + '-' + (d < 10 ? '0' : '') + d;
  }

  function parseWith(text, AMOUNT) {
    var lines = String(text || '').split(/\r?\n/).map(function (l) { return fixDigits(l.replace(/\s+/g, ' ').trim().replace(/(\d)[\s~—–_=|'"`°^,.:;]*[~—–_=|'"`°^]+$/, '$1')); }).filter(Boolean);
    var out = { merchant: '', date: parseDate(text || ''), items: [], service: 0, sst: 0, rounding: 0, total: 0 };
    var totals = [], after = [], subs = [], rndRead = false, pendingName = '', held = '', last = null, itemsDone = false, paidAmt = 0, change = -1;
    // A row of numbers only ("11.00  1  0.00  11.00", "1  RM 11.90  0.00  RM11.90"): the price row of the name above it.
    var numberRow = function (l) { var x = l && l.match(AMOUNT); return !!x && letters(l.slice(0, x.index).replace(/RM|MYR/gi, '')) < 3; };
    lines.forEach(function (raw, idx) {
      var m = raw.match(AMOUNT), amt = m ? toSen(m[1]) : null;
      // Anything above the column heading is the shop's details, not dishes. A heading has no price on it:
      // "Qty: 7   Total Amount: RM71.20" under the dishes is a total line, not a heading.
      if (!itemsDone && amt === null && HEADER.test(raw) && !SUBTOTAL.test(raw)) { out.items = []; last = null; pendingName = held = ''; return; }
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
        // A dish whose name came before its row of numbers is complete once that row is read.
        if (last && last.rowDone) return;
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
      // "Total RM incl. GST", "Total Sales (Inclusive of GST)", "Total After Adj": the final total, despite the tax word.
      if (TOTAL.test(text) && /\binc(?:l|\.|lusive|luding)?\b|after\s*adj|rounded|payable/i.test(text) && !SKIP.test(text)) { totals.push(Math.abs(amt)); itemsDone = true; pendingName = ''; return; }
      // The first SST and service amounts win; a "charges summary" after the total repeats them.
      // After the total, a charges summary repeats SST and service with a taxable column ("SST 6%  69.40  4.16");
      // those columns are easily mixed up, so such lines are skipped and a missing charge comes from the rate check.
      if (totals.length && (SST.test(text) || SERVICE.test(text) || /summary/i.test(text)) && (/summary|taxable/i.test(text) || /\d[.,]\d/.test(text))) return;
      if (SST.test(text) && !/charge/i.test(text) || pct === '6' || pct === '8') { out.sst = out.sst || Math.abs(amt); if (pct && !out.sstPct && !/charge/i.test(text)) out.sstPct = +pct; itemsDone = itemsDone || out.items.length > 0; return; }
      if (SERVICE.test(text) || pct === '10' || pct === '5') { out.service = out.service || Math.abs(amt); if (pct && !out.svcPct) out.svcPct = +pct; itemsDone = itemsDone || out.items.length > 0; return; }
      // Cash paid and change given: if no total is read, the total is what was paid less the change.
      if (/change|baki|kembali/i.test(text)) change = Math.abs(amt);
      else if (/cash|tunai|visa|master|card|e-?wallet|tng|touch|grab|boost|duitnow|payment|paid|tender/i.test(text) && !paidAmt) paidAmt = Math.abs(amt);
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
        var fromRow = true;
      }
      pendingName = '';
      var nq = nameAndQty(text, amt);
      if (letters(nq.name) < 2) return;
      last = { name: nq.name, qty: nq.qty, line: nq.line, each: 0 };
      if (fromRow) last.rowDone = true;
      out.items.push(last);
    });
    var paidNet = paidAmt && change >= 0 && paidAmt > change ? paidAmt - change : 0;
    if (!totals.length && paidNet) totals.push(paidNet);
    // No total printed (or readable), but the subtotal and the tax were: the total is their sum.
    if (!totals.length && subs.length && (out.sst || out.service)) totals.push(subs[0] + out.sst + out.service + (rndRead ? out.rounding : 0));
    out.paid = paidNet;
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
      if (HEADER.test(raw) && !SUBTOTAL.test(raw) && !raw.match(AMOUNT)) { buf = []; dishes = []; last = null; continue; }
      if (dishes.length && (SUBTOTAL.test(raw) || TOTAL.test(raw) || ROUNDING.test(raw) || /^\W*\d{1,2}\s*(?:q\w{0,2}|ay|oty|city)\b/i.test(raw))) break;
      var e = eachOf(raw), a = raw.match(ADDON);
      if (a && last && !e && (MODIFIER.test(raw) || /^\W*[-+.•·*]/.test(raw))) { last.mods += +a[1] * 100 + +a[2]; continue; }
      buf.push(raw); if (buf.length > 3) buf.shift();
      if (e) { last = { lines: buf, each: e, mods: 0 }; dishes.push(last); buf = []; }
    }
    if (dishes.length < 2) return null;
    var out = { merchant: base.merchant, date: base.date, service: base.service, sst: base.sst, rounding: r.rounding, total: 0, sstPct: r.sstPct, svcPct: r.svcPct, paid: base.paid };
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

  // Receipts that print each dish's quantity, price of one and line total ("2  RM 12.90  0.00  RM25.80",
  // "Teh Tarik  3  2.80  8.40", "2 @ 12.90  25.80"): a row whose numbers multiply out (quantity x price of one =
  // line total) is a dish, wherever the till puts it. Its name is the words before the numbers, or else the lines just
  // above it (a name and its option lines). This does not depend on knowing the layout, only on the receipt's own sums.
  var NUM = /(?:RM\s*)?(\d{1,5}[.,]\d{2})(?!\d)|(?:^|[\s@xX×*])(\d{1,2})(?=\s|$|\s*[@xX×])/g;
  function mathRow(raw) {
    var nums = [], m; NUM.lastIndex = 0;
    while ((m = NUM.exec(raw))) nums.push(m[1] ? { dec: toSen(m[1]), at: m.index } : { q: +m[2], at: m.index });
    var decs = nums.filter(function (n) { return n.dec !== undefined; });
    if (decs.length < 2) return null;
    var a = decs[decs.length - 1].dec, qs = nums.filter(function (n) { return n.q; });
    if (a <= 0) return null;
    // The price of one: another amount that, times a quantity printed on the row (or 1), gives the line total.
    for (var k = 0; k < decs.length - 1; k++) {
      var u = decs[k].dec; if (u <= 0) continue;
      var q = qs.filter(function (n) { return n.q >= 1 && Math.abs(n.q * u - a) <= 1; })[0];
      if (q || Math.abs(u - a) <= 1) {
        var start = Math.min(decs[k].at, q ? q.at : decs[k].at);
        return { qty: q ? q.q : 1, line: a, label: raw.slice(0, start) };
      }
    }
    return null;
  }
  function parseMath(text, AMOUNT) {
    var base = parseWith(text, AMOUNT), r = base.read, dishes = [], names = [];
    var lines = String(text || '').split(/\r?\n/).map(function (l) { return fixDigits(l.replace(/\s+/g, ' ').trim()); }).filter(Boolean);
    for (var k = 0; k < lines.length; k++) {
      var raw = lines[k];
      if (HEADER.test(raw) && !raw.match(AMOUNT)) { names = []; dishes = []; continue; }
      if (dishes.length && (SUBTOTAL.test(raw) || TOTAL.test(raw) || ROUNDING.test(raw) || /^\W*q(?:ty|uantity)\b/i.test(raw))) break;
      if (SKIP.test(raw) || SST.test(raw) || SERVICE.test(raw) || TOTAL.test(raw) || SUBTOTAL.test(raw)) { names = []; continue; }
      var row = mathRow(raw);
      if (row) {
        var label = letters(row.label) >= 3 ? row.label : names.slice(-2).join(' ');
        if (letters(label) >= 2) dishes.push({ name: label, qty: row.qty, line: row.line });
        names = []; continue;
      }
      // A smudge or line of symbols between a name and its numbers is skipped; any other priced line ends the name.
      if (raw.match(AMOUNT)) names = []; else if (letters(raw) >= 2) names.push(raw);
    }
    if (dishes.length < 2) return null;
    var out = { merchant: base.merchant, date: base.date, service: base.service, sst: base.sst, rounding: r.rounding, total: 0, sstPct: r.sstPct, svcPct: r.svcPct, paid: base.paid };
    out.items = dishes.map(function (d) { return { name: cleanName(d.name.replace(/^\W*\d{1,2}\s+(?:[xX×]\s+)?(?=[A-Za-z])/, '')) || 'Item', qty: d.qty, line: d.line, each: 0 }; });
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
    // ... or what was paid less the change ("Cash 10.00", "Change 1.50" under a total of 8.50).
    var paidLessChange = after.some(function (p) { return p > T && after.indexOf(p - T) > -1; });
    var trusted = T && (sub || after.indexOf(T) > -1 || totals.indexOf(T, 1) > -1 || paidLessChange);
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
    // A total the receipt confirms stands even if the dishes were misread; otherwise a printed amount that matches wins.
    if (!T || !trusted && Math.abs(T - sum) > 2) {
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

  // Receipts from abroad: which currency, by its signs and codes (none found: ringgit). Used to pick the bill's currency.
  // Signs and codes only: a place name ("Bangkok Kitchen" in KL) says nothing about the currency.
  var MARKS = [['MYR', /\bRM\s?\d|\bMYR\b|\bSST\b|\bcukai\b/gi], ['SGD', /S\$|\bSGD\b/g], ['THB', /฿|\bTHB\b|\bbaht\b/gi], ['CNY', /\bRMB\b|\bCNY\b|元|[¥￥]\s?\d[\d,]*\.\d{2}/g],
    ['VND', /₫|\bVND\b|\d\s?đ(?=\s|$)/gim], ['IDR', /\bIDR\b|\bRp\.?\s?\d/g], ['USD', /US\$|\bUSD\b/g], ['EUR', /€|\bEUR\b/g], ['GBP', /£|\bGBP\b/g],
    ['JPY', /\bJPY\b|円|[¥￥\\]\s?\d[\d,]*(?![\d,.])/g], ['KRW', /₩|\bKRW\b/g], ['HKD', /HK\$|\bHKD\b/g], ['TWD', /NT\$|\bTWD\b/g], ['AUD', /A\$|\bAUD\b/g], ['PHP', /₱|\bPHP\b/g]];
  function detectCurrency(text) {
    var best = 'MYR', top = 0;
    MARKS.forEach(function (m) { var n = (String(text || '').match(m[1]) || []).length; if (n > top) { top = n; best = m[0]; } });
    return top ? best : '';
  }
  var WHOLE = { VND: 1, IDR: 1, JPY: 1, KRW: 1, TWD: 1 };
  // Japanese fonts draw ¥ so that the reader often takes it for a backslash.
  // Prices abroad: currency signs and codes around numbers go; in currencies without cents (dong, rupiah, yen, won)
  // "150.000", "65,000" or "65000" are whole amounts, written as "150000.00" so the ringgit rules read them.
  function normalise(text, cur) {
    var t = String(text || '').replace(/(^|[^\d.,])(\d{1,6})\s*元/gm, WHOLE[cur] ? '$1$2元' : '$1$2.00元').replace(/(S\$|US\$|HK\$|NT\$|A\$|\$|฿|￥|¥|\\|€|£|₫|₩|₱)\s*(?=-?\d)/g, '').replace(cur === 'CNY' || cur === 'JPY' ? /\bY\s*(?=\d)/g : /(?!)/, '')
      .replace(/\b(?:SGD|THB|USD|EUR|GBP|CNY|RMB|VND|IDR|JPY|KRW|HKD|TWD|AUD|PHP|Rp\.?)\s*(?=-?\d)/g, '')
      .replace(/(\d)\s*(?:₫|đ|฿|€|£|¥|￥|₩|₱|VND|vnd|THB|SGD|USD|EUR|GBP|IDR|JPY|KRW|HKD|TWD|AUD|PHP|CNY|RMB|円|元)(?=\s|$)/g, '$1');
    if (!WHOLE[cur]) return t;
    return t.split(/\r?\n/).map(function (l) {
      // The reader sometimes puts a space after the mark ("1, 200").
      return l.replace(/(\d[.,])\s(?=\d{3}(?!\d))/g, '$1').replace(/(^|[^\d.,])(\d{1,3}(?:[.,]\d{3})+)(?![.,]?\d)/g, function (m, pre, n) { return pre + n.replace(/[.,]/g, '') + '.00'; })
        .replace(/(^|[^\d.,])(\d{3,9})(?=\s*$|\s+\d)/g, function (m, pre, n) { return pre + n + '.00'; })
        // Taiwan dollars: a dish can be two digits ("酸辣湯 90").
        .replace(/([\u3400-\u9fff]\s+)(\d{2})\s*$/, function (m, a, b) { return cur === 'TWD' ? a + b + '.00' : m; });
    }).join('\n');
  }

  // Thousands marks go, so the amount rules read them: "1,200.00" and "1.200,00" both become "1200.00".
  function plainThousands(text) {
    // The reader can also split a price at its point: "33 . 26" at the end of a line.
    return String(text || '').replace(/(\d) ?\. (\d{2})\s*$|(\d) \.(\d{2})\s*$/gm, function (m, a, b, c, d) { return (a || c) + '.' + (b || d); }).replace(/(^|[^\d.,])(\d{1,3}(?:,\d{3})+)\.(\d{2})(?!\d)/gm, function (m, pre, n, c) { return pre + n.replace(/,/g, '') + '.' + c; })
      .replace(/(^|[^\d.,])(\d{1,3}(?:\.\d{3})+),(\d{2})(?!\d)/gm, function (m, pre, n, c) { return pre + n.replace(/\./g, '') + '.' + c; });
  }
  // No currency found, but it is not ringgit either: "$" could be any dollar; prices like "12,000" with no cents anywhere
  // are yen, won, dong or rupiah. The person has to choose, so nothing is counted as ringgit by mistake.
  function unsure(text) {
    if (/\$\s?\d/.test(text)) return 'dollar';
    var grouped = (text.match(/(?:^|[^\d.,])\d{1,3}[.,]\d{3}(?![\d.,])/gm) || []).length;
    return grouped >= 2 && !/\d[.,]\d{2}\s*[A-Z*]{0,2}\s*\|?\s*$/m.test(text) ? 'whole' : '';
  }
  // Tax already inside the prices, as in Thailand, Japan or Europe ("Total 300.00, VAT 7% 19.63"): when the dishes reach the
  // total without it, it is only a note on the receipt and must not be added on top.
  function taxInside(r) {
    var sum = (r.service || 0) + (r.rounding || 0);
    r.items.forEach(function (i) { sum += i.line; });
    if (r.total && r.sst && r.items.length && Math.abs(sum - r.total) <= 1) r.sst = 0;
    return r;
  }
  // Japanese and Korean receipts: the reader spaces out the characters, and the labels become the English ones the rules know.
  var CJK = { JPY: 1, KRW: 1, CNY: 1, TWD: 1, HKD: 1 };
  var CJK_GAP = /([\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3\uff66-\uff9f]) +(?=[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3\uff66-\uff9f])/g;
  var LABELS = [
    [/^(?:\d{4}\s*[年\/.-]|内税|内消費税|内\s?消費|\(内|（内|税率|\d+%対象|対象|伝票|レジ|担当|電話|登録番号|店舗|客数|人数|テーブル|卓番|ご利用日|カード会社|会員番号|端末番号|有効期限|取引内容|商品区分|車両番号|单号|單號|流水|订单|訂單|收银|收銀|机号|機號|台号|桌号|桌號|人数|人數|电话|電話|地址|日期|时间|時間|会员|會員|发票|發票|税号|稅號|店号|工号|小票|交易号|商户|商戶|면세|영수증|사업자|전화|대표|주소|승인번호|카드번호|단말기|테이블|인원)/, ''],
    [/^(?:小計|小计|税抜|未税|未稅|소계|공급가액|과세물품|과세)[^\d]*/, 'Subtotal '],
    [/^(?:外税|消費税等?|税額?|税额|稅額|增值税|营业税|營業稅|부가가치세|부가세|세액)[^\d]*/, 'Tax '],
    [/^(?:サービス料|奉仕料|服务费|服務費|봉사료)[^\d]*/, 'Service '],
    [/^(?:お?預り?かり?|現金|现金|实收|實收|已收|收款|找零|找赎|找贖|微信|支付宝|支付寶|银联|銀聯|刷卡|扫码|掃碼|优惠|優惠|折扣|抹零|お?釣り?銭?|クレジット|カード|ポイント|받은금액|현금|신용카드|카드|거스름돈|할인)[^\d]*/, 'Cash '],
    [/^(?:総合計|税込合計|合計|合计|账单合计|帳單合計|帐单合计|总计|總計|应收|應收|应付|應付|实付|實付|总额|總額|总金额|總金額|消费合计|お?会計|ご?請求(?:金額|額)?|お買上げ?(?:計|金額)?|합계금액|총합계|합계|총액|총계|결제금액|받을금액|청구금액|판매총액)[^\d]*/, 'Total ']
  ];
  var CJK_DATE = /(\d{4})\s*[-\/.年]\s*(\d{1,2})\s*[-\/.月]\s*(\d{1,2})/;
  function cjkLabels(text) {
    return text.split(/\r?\n/).map(function (l) {
      var t = l.replace(CJK_GAP, '$1').replace(CJK_GAP, '$1').replace(/^[\s*※#-]+/, '')
        // Prices with one decimal ("16.8"), and the total printed beside the item count ("总件数:3  价格:46.40").
        .replace(/(^|\s)(\d{1,5}\.\d)(?=\s|$)/g, '$1$20').replace(/(\d\.\d{2})\s+[A-Za-z]{1,4}\s*$/, '$1').replace(/^.*?(?:总件数|總件數|总数量|總數量)\S*\s+\S*?(?:价格|價格|总价|總價|金额|金額)[:：]?\s*/, '合计 ');
      var day = t.match(CJK_DATE);
      if (day) return 'Date ' + day[3] + '/' + day[2] + '/' + day[1];
      if (/対象|商品数|点数/.test(t)) return ''; // Tax bases and item counts, anywhere on the line.
      for (var k = 0; k < LABELS.length; k++) if (LABELS[k][0].test(t)) return LABELS[k][1] ? t.replace(LABELS[k][0], LABELS[k][1]) : '';
      return t;
    }).join('\n');
  }
  // Card slips, petrol and shop receipts: the word for "total" is often unreadable, but the amount is not. It is the ¥ amount
  // printed more than once, or what was handed over less the change, or the only ¥ amount there is. When the lines found
  // do not reach it they are not dishes, so the bill gets one line for the whole receipt.
  var CJK_AMOUNT = /[¥￥\\$₩Y]\s*(\d[\d,]*\.\d{2}(?!\d)|\d{1,3}(?:[,.\s]{1,3}\d{3})+|\d{2,7})(?!\d)|(\d[\d,]*\.\d{2}(?!\d)|\d{1,3}(?:[,.]\d{3})+|\d{2,7})\s*[円원元]/;
  // A table of dishes: name, quantity, price of one, amount. The reader often misreads the cents ("39.90", "59 60", "89.%0")
  // but rarely the whole part, and a name can wrap onto the line above. When the amount fell onto the next line, it is the
  // quantity times the price of one.
  var ROW_NUM = '(\\d{1,5})(?:\\s*[.,]\\s*|\\s)([\\d%OoQ]{1,2})';
  var ROW_FULL = new RegExp('^(.*?)\\s+[^\\s\\d]?(\\d{1,2})\\s+' + ROW_NUM + '\\s+' + ROW_NUM + '$'), ROW_HALF = new RegExp('^(.*?)\\s+[^\\s\\d]?(\\d{1,2})\\s+(\\d{1,5})\\s*[.,]\\s*\\d{0,2}$');
  function cjkTable(text) {
    var rows = [], wrap = '', skip = false, name = function (s) { return cleanName((wrap + s).replace(/^.*[“”"]\s*/, '').replace(CJK_GAP, '$1').replace(/[《（]/g, '(').replace(/[》）]/g, ')').trim()).replace(/\)+$/, ')') || 'Item'; };
    cjkLabels(String(text || '')).split('\n').forEach(function (l) {
      var t = l.trim().replace(/\s+[^\s\d.,)）]{1,2}$/, '').replace(/[”"“|]+$/, '').trim(), m = t.match(ROW_FULL), h = !m && t.match(ROW_HALF);
      if (m && /[A-Za-z\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3\uff66-\uff9f]/.test(m[1])) { rows.push({ name: name(m[1]), qty: +m[2], whole: +m[5] * 100, cents: /^\d\d$/.test(m[6]) ? +m[6] : 0 }); wrap = ''; skip = false; return; }
      if (h && /[A-Za-z\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3\uff66-\uff9f]/.test(h[1])) { rows.push({ name: name(h[1]), qty: +h[2], whole: +h[2] * +h[3] * 100, cents: 0 }); wrap = ''; skip = true; return; }
      if (skip) { skip = false; if (!/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3\uff66-\uff9f]/.test(t)) return; }
      wrap = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3\uff66-\uff9f]{3,}/.test(t) && !/\d/.test(t) && !/^(?:商品|品名|菜品|菜名|名称|名稱)/.test(t) ? t.replace(/^[^\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3\uff66-\uff9fA-Za-z]+/, '') : '';
    });
    return rows.length >= 2 ? rows : null;
  }
  function addGap(r, total) {
    var sum = (r.service || 0) + (r.rounding || 0) + (r.sst || 0);
    r.items.forEach(function (i) { sum += i.line; });
    if (total - sum > 1) { r.items.push({ name: NOT_READ, qty: 1, line: total - sum, each: total - sum, filled: true }); r.filled = (r.filled || 0) + 1; }
  }
  function cjkTotal(r, text) {
    var seen = {}, paid = 0, change = 0, top = 0, most = 0;
    String(text || '').split(/\r?\n/).forEach(function (l) {
      var t = l.replace(CJK_GAP, '$1').replace(CJK_GAP, '$1'), m = t.match(CJK_AMOUNT);
      if (!m) return;
      var a = m[1] || m[2], n = /\.\d{2}$/.test(a) ? Math.round(+a.replace(/,/g, '') * 100) : +a.replace(/\D/g, '') * 100;
      if (/預|받은|实收|實收|已收|现金|現金/.test(t)) paid = n; else if (/釣|거스|找零|找赎|找贖/.test(t)) change = n;
      else if (!/内税|内消費|消費税等|小\s?[計计]|税抜|外税|未[税稅]|税额|稅額|优惠|優惠|折扣|소계|부가세|세액/.test(t)) seen[n] = (seen[n] || 0) + 1;
    });
    var kinds = Object.keys(seen);
    kinds.forEach(function (n) { if (seen[n] > most) { most = seen[n]; top = +n; } });
    var read = (r.service || 0) + (r.rounding || 0) + (r.sst || 0);
    r.items.forEach(function (i) { read += i.line; });
    if (r.total && r.items.length && Math.abs(read - r.total) <= 1) return r; // The receipt's own total, and it adds up.
    var total = r.total && seen[r.total] ? r.total : most >= 2 ? top : paid > change && change ? paid - change : kinds.length === 1 ? +kinds[0] : r.total;
    if (!total) return r;
    var table = cjkTable(text);
    if (table) {
      var charges = (r.service || 0) + (r.rounding || 0) + (r.sst || 0), whole = 0, exact = 0;
      table.forEach(function (d) { whole += d.whole; exact += d.whole + d.cents; });
      // Prices with no real cents: the whole parts reach the total, so the cents were misreads.
      var keepCents = Math.abs(exact + charges - total) <= 1, round = !keepCents && Math.abs(whole + charges - total) < 100, fits = keepCents || round;
      if (fits || Math.abs(whole + charges - total) <= total * 0.4) {
        r.items = table.map(function (d) { var line = keepCents ? d.whole + d.cents : d.whole; return { name: d.name, qty: d.qty, line: line, each: Math.round(line / d.qty) }; });
        r.total = round ? whole + charges : total; r.filled = 0; delete r.onlyTotal;
        if (!fits) addGap(r, total);
        return r;
      }
    }
    var sum = (r.service || 0) + (r.rounding || 0), dishes = r.items;
    // The total itself, read under an unreadable label, is not a dish.
    if (dishes.length > 1) dishes = dishes.filter(function (i) { return i.line !== total && i.line !== paid && i.line !== change; });
    dishes.forEach(function (i) { sum += i.line; });
    r.total = total;
    if (dishes.length && (Math.abs(sum - total) <= 1 || Math.abs(sum + (r.sst || 0) - total) <= 1)) { r.items = dishes; return r; }
    // A discount or small change waived: the dishes are right and the difference comes off.
    if (dishes.length && sum > total && /优惠|優惠|折扣|抹零/.test(text)) { r.items = dishes; r.sst = 0; r.rounding = (r.rounding || 0) + total - sum; return r; }
    // Tax is added after the dishes and rounded down in Japan, so up to 12% over is the tax itself.
    if (dishes.length && total > sum && total - sum <= sum * 0.12) { r.items = dishes; r.sst = total - sum; return r; }
    // Real dishes that nearly reach the total stay: what is missing shows as one line to check, so nothing is lost.
    var named = dishes.filter(function (i) { return /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3\uff66-\uff9f]{2}/.test(i.name); });
    if (named.length >= 2 && sum >= total * 0.5 && sum <= total * 1.3) { r.items = dishes; addGap(r, total); return r; }
    r.items = [{ name: 'Receipt total', qty: 1, line: total, each: total }];
    r.service = r.sst = r.rounding = r.filled = 0; r.merchant = ''; r.onlyTotal = true;
    return r;
  }
  // The shop: the first line near the top with Chinese, Japanese or Korean words, with any English name before them.
  function cjkShop(text) {
    var lines = String(text || '').split(/\r?\n/).slice(0, 14), found = '';
    lines.some(function (l) {
      var t = l.replace(CJK_GAP, '$1').replace(CJK_GAP, '$1'), m = t.match(/(?:[A-Z][A-Za-z]+ ){0,4}[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3\uff66-\uff9f]{2,12}/);
      if (!m || /\d|[:：]/.test(t) || /品名|菜品|单价|單價|数量|數量|金额|金額|税|稅|様|ます|売上|領収|控|谢|謝|欢迎|歡迎|发票|發票|单$|單$|小票|收据|收據|영수증/.test(m[0])) return false;
      found = m[0].trim();
      return true;
    });
    return found;
  }
  // A dish name the reader probably got wrong, for the form to mark. Abroad in Asia, English scraps stand for unread words.
  function doubtful(name, cur) {
    var n = String(name || '').trim();
    if (!n || n === NOT_READ || /\d[.,]\d/.test(n)) return true;
    if (!CJK[cur]) return false;
    var words = n.split(/\s+/).filter(function (w) { return /[A-Za-z0-9]/.test(w); });
    var noVowel = words.some(function (w) { return /^[A-Za-z]{2,}$/.test(w) && !/[aeiouy]/i.test(w); });
    if (new RegExp('[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3\uff66-\uff9f]{2}').test(n)) return noVowel;
    return n.length < 4 || noVowel || /^[A-Z\s]+$/.test(n) || words.some(function (w) { return w.length <= 2; });
  }
  // The reader with English added reads prices well but can turn dish names into English junk; the reader with only the
  // local language reads names well but garbles prices. Line by line, this keeps the name from one and the price from the other.
  var CJK_CHAR = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3]/g, PRICE_END = /\s+\S*\d[\d.,]*\S*\s*$/;
  function mergeNames(mixed, local) {
    var a = String(mixed || '').split(/\r?\n/).filter(function (l) { return l.trim(); }), b = String(local || '').split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (a.length !== b.length) return mixed;
    return a.map(function (l, i) {
      var price = l.match(PRICE_END), name = b[i].replace(PRICE_END, '');
      if (!price) return l;
      var count = function (s) { return (s.match(CJK_CHAR) || []).length; };
      return count(name) > count(l.slice(0, price.index)) ? name + price[0] : l;
    }).join('\n');
  }
  // `opts.currency`: the bill's currency, if the person already chose one; otherwise it is read off the receipt.
  function parse(text, opts) {
    var chosen = opts && opts.currency && opts.currency !== 'MYR' ? opts.currency : '';
    var cur = chosen || detectCurrency(text) || 'MYR', plain = plainThousands(CJK[cur] ? cjkLabels(String(text || '')) : text);
    var r = cur === 'MYR' ? parseText(plain) : taxInside(parseText(normalise(plain, cur)));
    if (CJK[cur]) { r = cjkTotal(r, text); r.merchant = cjkShop(text) || r.merchant; }
    if (cur !== 'MYR') r.currency = cur;
    else if (!detectCurrency(text)) { var u = unsure(plain); if (u) r.unsure = u; }
    return r;
  }
  function parseText(text) {
    var strict = parseWith(text, AMOUNT_STRICT), each = parseEach(text, AMOUNT_STRICT);
    // Prices worked out from "(x/ea)" notes win when they add up; they do not depend on the price column at all.
    if (each && balanced(each)) return done(each);
    // The receipt's own sums (quantity x price of one = line total) do not depend on the layout, and they also settle
    // each dish's quantity; when they add up they win, unless the usual reading found more dishes that also add up.
    var math = parseMath(text, AMOUNT_STRICT);
    if (math && balanced(math) && (!balanced(strict) || math.items.length >= strict.items.length)) return done(math);
    if (balanced(strict)) return done(strict);
    // The loose reading (prices without a decimal point) wins only when it is more believable.
    return done(best([strict, each, math, parseWith(text, AMOUNT_LOOSE), parseEach(text, AMOUNT_LOOSE)]));
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
    // A total that disagrees with the cash paid less the change printed on the same receipt is very likely wrong.
    var paidOff = r.paid && r.total && Math.abs(r.paid - r.total) > 2 ? 25 : 0;
    return r.items.length + (r.total ? 12 : 0) + (r.service ? 1 : 0) + (r.sst ? 1 : 0) + (r.total && r.items.length && Math.abs(sum - r.total) <= 2 ? 20 : 0)
      - 3 * (r.filled || 0) - guess - paidOff;
  }
  // Read cleanly: adds up with nothing worked out.
  function balanced(r) { return score(r) >= 20 && !r.filled; }
  // Good enough to stop reading: adds up, with at most one dish's price worked out and no "Item not read" line.
  function goodEnough(r) {
    if (r.onlyTotal) return false; // Keep trying for the dishes; the total stays if none of the tries finds them.
    return balanced(r) || (r.filled === 1 && score(r) >= 20 && !r.items.some(function (i) { return i.name === NOT_READ; }));
  }
  // The most believable reading; a date or shop name it missed is taken from the other readings of the same photo.
  function best(readings) {
    var all = readings.filter(Boolean), win = all.reduce(function (a, b) { return !a || score(b) > score(a) ? b : a; }, null);
    if (win) all.forEach(function (r) { if (!win.date && r.date) win.date = r.date; if (!win.merchant && r.merchant) win.merchant = r.merchant; });
    return win;
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

  return { parse: parse, doubtful: doubtful, mergeNames: mergeNames, cjkShop: cjkShop, detectCurrency: detectCurrency, rowsFromBlocks: rowsFromBlocks, tilt: tilt, binarize: binarize, best: best, balanced: balanced, goodEnough: goodEnough, slipAmounts: slipAmounts, checkSlip: checkSlip };
});
