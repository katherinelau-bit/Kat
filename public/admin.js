/* Bei Cin Lah back office: visits, bills, trips and who owes what, for the owner of the site.
 * Locked by the ADMIN_KEY password (kept in this tab only). All numbers are worked out here from GET /api/admin. */
(function () {
'use strict';
var $ = function (s) { return document.querySelector(s); };
var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
var KEY = 'bcl.admin';
var A = { data: null, range: 30, q: '', tq: '', open: {}, err: '', busy: false };

/* ---------- money and dates ---------- */
var fx = function (x) { return !!(x && x.currency && x.currency !== 'MYR'); };
var rmOf = function (c, x) { return fx(x) ? Currency.toRM(c, x.rate) : c; };
var RM = function (c) { return Currency.fmt(c, 'MYR'); };
var money = function (c, x) { return fx(x) ? Currency.fmt(c, x.currency) + ' <span class="muted">(' + RM(rmOf(c, x)) + ')</span>' : RM(c); };
// Days are Malaysian days, the same as the visit counter on the server.
var dayOf = function (ms) { return new Date(ms + 8 * 3600e3).toISOString().slice(0, 10); };
var when = function (ms) { return ms ? dayOf(ms) + ' ' + new Date(ms + 8 * 3600e3).toISOString().slice(11, 16) : ''; };
var nice = function (d) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d); return m ? +m[3] + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m[2] - 1] : d; };
function lastDays(n) { var out = [], t = Date.now(); for (var i = n - 1; i >= 0; i--) out.push(dayOf(t - i * 864e5)); return out; }
function inRange(ms) { return A.range === 0 || ms >= Date.now() - A.range * 864e5; }

/* ---------- what each bill and trip comes to ---------- */
function billInfo(b) {
  var c = Split.calc(b), people = [], paid = 0, paidRM = 0, waitRM = 0, owing = 0;
  b.members.forEach(function (m) {
    var share = c.per[m.id] ? c.per[m.id].total : 0, p = m.pay || { status: 'unpaid' };
    var owes = p.amount != null && (p.status === 'paid' || p.status === 'sent') ? p.amount : share;
    people.push({ m: m, share: share, owes: owes, status: m.isPayer ? 'payer' : p.status, at: p.confirmedAt || p.slipAt || null, picks: (m.picks || []).length });
    if (m.isPayer || !share) return;
    owing++;
    if (p.status === 'paid') { paid++; paidRM += rmOf(owes, b); } else waitRM += rmOf(owes, b);
  });
  var payer = b.members.filter(function (m) { return m.id === b.payerId; })[0];
  return { c: c, totalRM: rmOf(c.total, b), people: people, paid: paid, owing: owing, paidRM: paidRM, waitRM: waitRM, payer: payer ? payer.name : '' };
}
function tripInfo(t) {
  var bal = Settle.balances(t), pays = t.payments || [];
  return { totalRM: Settle.total(t), bal: bal, paidRM: pays.filter(function (p) { return p.status === 'paid'; }).reduce(function (s, p) { return s + p.amount; }, 0),
    owner: (t.members.filter(function (m) { return m.id === t.ownerId; })[0] || {}).name || '' };
}
function tname(t, id) { var m = t.members.filter(function (x) { return x.id === id; })[0]; return m ? m.name : 'Someone'; }

/* ---------- loading ---------- */
async function load() {
  var key = ''; try { key = sessionStorage.getItem(KEY) || ''; } catch (e) {}
  if (!key) return paint();
  A.busy = true; paint();
  try {
    var r = await fetch('/api/admin', { headers: { 'x-token': key }, cache: 'no-store' });
    var j = {}; try { j = await r.json(); } catch (e) {}
    if (!r.ok) { A.err = j.error || 'Could not load'; if (r.status === 401) try { sessionStorage.removeItem(KEY); } catch (e) {} A.data = null; }
    else { A.err = ''; A.data = j; A.data.bills.sort(function (a, z) { return z.createdAt - a.createdAt; }); A.data.trips.sort(function (a, z) { return z.createdAt - a.createdAt; }); }
  } catch (e) { A.err = 'No connection. Try again.'; }
  A.busy = false; paint();
}

/* ---------- drawing ---------- */
function paint() {
  var key = ''; try { key = sessionStorage.getItem(KEY) || ''; } catch (e) {}
  var root = $('#admin'), focus = document.activeElement && document.activeElement.id, at = focus ? document.activeElement.selectionStart : 0;
  if (!A.data) root.innerHTML = lockView(key);
  else root.innerHTML = dashView();
  if (focus && $('#' + focus)) { var el = $('#' + focus); el.focus(); try { el.setSelectionRange(at, at); } catch (e) {} }
}
function lockView(key) {
  return '<form class="card lock" id="lockform"><h1>Back office</h1><p class="muted small" style="margin:0">Bei Cin Lah traffic, bills and trips. Enter the admin password set as ADMIN_KEY on Netlify.</p>' +
    '<input type="password" id="pw" autocomplete="current-password" placeholder="Admin password" aria-label="Admin password"' + (A.busy ? ' disabled' : '') + '>' +
    (A.err ? '<p class="err">' + esc(A.err) + '</p>' : '') + '<button class="primary" type="submit"' + (A.busy ? ' disabled' : '') + '>' + (A.busy || key ? 'Opening…' : 'Open') + '</button></form>';
}

function dashView() {
  var d = A.data, bills = d.bills, trips = d.trips;
  var rb = bills.filter(function (b) { return inRange(b.createdAt); }), rt = trips.filter(function (t) { return inRange(t.createdAt); });
  var days = A.range ? lastDays(A.range) : lastDays(Math.min(365, Math.max(30, Math.ceil((Date.now() - Math.min.apply(null, [Date.now()].concat(bills.map(function (b) { return b.createdAt; })))) / 864e5) + 1)));
  var visits = 0, fresh = 0;
  Object.keys(d.visits).forEach(function (k) { if (A.range === 0 || days.indexOf(k) > -1) { visits += d.visits[k].visits; fresh += d.visits[k].newDevices; } });
  var people = 0, splitRM = 0, paidRM = 0, waitRM = 0, receipts = 0, abroad = 0, slips = 0, cur = {};
  rb.forEach(function (b) {
    var i = billInfo(b); people += b.members.length; splitRM += i.totalRM; paidRM += i.paidRM; waitRM += i.waitRM;
    if (b.hasReceipt) receipts++; if (fx(b)) abroad++;
    b.members.forEach(function (m) { if (m.hasSlip) slips++; });
    var k = b.currency || 'MYR'; cur[k] = cur[k] || { n: 0, rm: 0 }; cur[k].n++; cur[k].rm += i.totalRM;
  });
  var tripRM = 0, tripPeople = 0; rt.forEach(function (t) { tripRM += Settle.total(t); tripPeople += t.members.length; });
  var label = A.range ? 'last ' + A.range + ' days' : 'all time';

  var h = '<div class="row between"><div><h1>Bei Cin Lah back office</h1><div class="muted small">Updated ' + esc(when(d.at)) + ' (Malaysia time) · ' + bills.length + ' bills and ' + trips.length + ' trips in total</div></div>' +
    '<div class="row"><button data-act="refresh">' + (A.busy ? 'Refreshing…' : 'Refresh') + '</button><button data-act="csv">Download CSV</button><button data-act="lock">Lock</button></div></div>';
  h += '<div class="row" style="margin-top:16px" role="group" aria-label="Period">' + [[7, '7 days'], [30, '30 days'], [90, '90 days'], [0, 'All time']].map(function (r) {
    return '<button data-range="' + r[0] + '" aria-pressed="' + (A.range === r[0]) + '">' + r[1] + '</button>'; }).join('') + '</div>';

  h += '<h2>Traffic, ' + label + '</h2><div class="tiles">' +
    tile('Visits', visits, 'devices opening the app, once a day each') + tile('New devices', fresh, 'first visit on that phone or laptop') +
    tile('Linked device groups', d.linked, 'people using "Link my devices" (all time)') + '</div>';
  h += '<h2>Transactions, ' + label + '</h2><div class="tiles">' +
    tile('Bills created', rb.length, receipts + ' with a receipt photo') + tile('People on bills', people, rb.length ? (people / rb.length).toFixed(1) + ' per bill on average' : '') +
    tile('Money split', RM(splitRM), 'bills, in RM') + tile('Paid back', RM(paidRM), 'confirmed by the payer') + tile('Still owed', RM(waitRM), slips + ' payment slips sent') +
    tile('Trips created', rt.length, tripPeople + ' people · ' + RM(tripRM) + ' spent') + tile('Bills abroad', abroad, 'in a foreign currency') + '</div>';

  h += '<div class="charts" style="margin-top:10px">' + chart('Visits per day', days, function (k) { return d.visits[k] ? d.visits[k].visits : 0; }, 'visit') +
    chart('Bills and trips created per day', days, function (k) { return bills.filter(function (b) { return dayOf(b.createdAt) === k; }).length + trips.filter(function (t) { return dayOf(t.createdAt) === k; }).length; }, 'new') + '</div>';
  if (A.range && !Object.keys(d.visits).length) h += '<p class="muted small">Visits are counted from the day the back office went live, so this chart starts empty.</p>';

  var codes = Object.keys(cur).sort(function (a, z) { return cur[z].n - cur[a].n; });
  if (codes.length) h += '<h2>Currencies, ' + label + '</h2><div class="tablewrap"><table><thead><tr><th>Currency</th><th class="n">Bills</th><th class="n">Total in RM</th></tr></thead><tbody>' +
    codes.map(function (k) { return '<tr><td>' + esc(k) + '</td><td class="n">' + cur[k].n + '</td><td class="n">' + RM(cur[k].rm) + '</td></tr>'; }).join('') + '</tbody></table></div>';

  h += billsTable(bills) + tripsTable(trips);
  return h;
}
function tile(k, v, s) { return '<div class="card tile"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div>' + (s ? '<div class="s">' + esc(s) + '</div>' : '') + '</div>'; }

// One series of bars per day, on its own axis. Hovering a day shows its number.
function chart(title, days, val, unit) {
  var vals = days.map(val), max = Math.max.apply(null, vals.concat([1])), W = 600, H = 170, top = 8, bot = 22, left = 30, n = days.length;
  var step = Math.pow(10, Math.floor(Math.log10(max))); var nice = Math.ceil(max / step) * step; if (nice / 2 >= max && nice > 1) nice = nice / 2 * 1; max = Math.max(nice, 1);
  var bw = (W - left) / n, gap = Math.min(2, bw * 0.25), y = function (v) { return top + (H - top - bot) * (1 - v / max); };
  var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(title) + '">';
  [0, max / 2, max].forEach(function (g) { var yy = y(g); s += '<line class="gl" x1="' + left + '" x2="' + W + '" y1="' + yy + '" y2="' + yy + '"/><text class="ax" x="' + (left - 6) + '" y="' + (yy + 4) + '" text-anchor="end">' + (Math.round(g * 10) / 10) + '</text>'; });
  days.forEach(function (k, i) {
    var v = vals[i], x = left + i * bw + gap / 2, w = Math.max(1, bw - gap), yy = y(v), hgt = H - bot - yy;
    var tipText = nice2(k) + ': ' + v + ' ' + unit + (v === 1 ? '' : 's');
    s += '<rect class="hit" x="' + (left + i * bw) + '" y="' + top + '" width="' + bw + '" height="' + (H - top - bot) + '" data-tip="' + esc(tipText) + '"/>';
    if (v > 0) s += '<path class="bar" d="' + barPath(x, yy, w, hgt) + '"/>'; else s += '<rect class="bar" x="' + x + '" y="' + (H - bot - 1) + '" width="' + w + '" height="1" opacity=".3"/>';
  });
  [0, Math.floor((n - 1) / 2), n - 1].forEach(function (i, j) { s += '<text class="ax" x="' + (left + i * bw + bw / 2) + '" y="' + (H - 6) + '" text-anchor="' + (j === 0 ? 'start' : j === 2 ? 'end' : 'middle') + '">' + esc(nice2(days[i])) + '</text>'; });
  var total = vals.reduce(function (a, b) { return a + b; }, 0);
  return '<div class="card chart"><h3>' + esc(title) + '</h3><div class="muted small" style="margin-bottom:8px">' + total + ' in ' + n + ' days · busiest day ' + Math.max.apply(null, vals) + '</div>' + s + '</svg></div>';
}
function nice2(k) { return nice(k); }
// Rounded at the top only, flat on the baseline.
function barPath(x, y, w, h) { var r = Math.min(4, w / 2, h); return 'M' + x + ',' + (y + h) + 'V' + (y + r) + 'Q' + x + ',' + y + ' ' + (x + r) + ',' + y + 'H' + (x + w - r) + 'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) + 'V' + (y + h) + 'Z'; }

function found(words, q) { var w = words.toLowerCase(); return q.toLowerCase().split(/\s+/).filter(Boolean).every(function (x) { return w.indexOf(x) > -1; }); }
function billsTable(bills) {
  var list = A.q.trim() ? bills.filter(function (b) { return found([b.title, b.date, b.currency, b.id].concat(b.members.map(function (m) { return m.name; })).concat((b.items || []).map(function (i) { return i.name; })).join(' '), A.q); }) : bills;
  var h = '<div class="row between" style="margin-top:28px"><h2 style="margin:0">All bills</h2><input type="search" id="bq" data-q="q" value="' + esc(A.q) + '" placeholder="Search name, friend, dish, date" aria-label="Search bills" style="flex:1;max-width:320px"></div>';
  h += '<p class="muted small">' + list.length + ' bill' + (list.length === 1 ? '' : 's') + (list.length > 200 ? ', newest 200 shown' : '') + '. Tap a bill to see everyone on it.</p>';
  if (!list.length) return h + '<div class="card empty">No bills' + (A.q ? ' match' : ' yet') + '.</div>';
  h += '<div class="tablewrap"><table><thead><tr><th>Bill</th><th class="hide-sm">Bill date</th><th class="hide-sm">Paid by</th><th class="n">People</th><th class="n">Total</th><th class="n">Paid back</th><th class="hide-sm">Created</th></tr></thead><tbody>';
  list.slice(0, 200).forEach(function (b) {
    var i = billInfo(b), open = A.open['b' + b.id];
    h += '<tr class="main" data-open="b' + b.id + '" tabindex="0" aria-expanded="' + !!open + '"><td><b>' + esc(b.title) + '</b>' + (fx(b) ? ' <span class="pill payer">' + esc(b.currency) + '</span>' : '') + '</td><td class="hide-sm">' + esc(b.date || '') + '</td><td class="hide-sm">' + esc(i.payer) + '</td><td class="n">' + b.members.length + '</td><td class="n">' + money(i.c.total, b) + '</td><td class="n">' + i.paid + ' of ' + i.owing + '</td><td class="hide-sm muted">' + esc(when(b.createdAt)) + '</td></tr>';
    if (open) h += '<tr class="detail"><td colspan="7">' + billDetail(b, i) + '</td></tr>';
  });
  return h + '</tbody></table></div>';
}
function billDetail(b, i) {
  var c = i.c;
  var ppl = '<table><thead><tr><th>Person</th><th class="n">Dishes</th><th class="n">Share</th><th>Status</th><th>When</th></tr></thead><tbody>' + i.people.map(function (p) {
    var st = p.status === 'payer' ? '<span class="pill payer">Paid the bill</span>' : !p.share ? '<span class="muted">No dishes yet</span>' : '<span class="pill ' + esc(p.status) + '">' + (p.status === 'paid' ? 'Paid' : p.status === 'sent' ? 'Slip sent' : 'Not paid') + '</span>';
    return '<tr><td>' + esc(p.m.name) + (p.m.notify ? ' <span class="muted small">(notifications on)</span>' : '') + '</td><td class="n">' + p.picks + '</td><td class="n">' + money(p.status === 'payer' ? p.share : p.owes, b) + '</td><td>' + st + '</td><td class="muted small">' + esc(when(p.at) || ('joined ' + when(p.m.joinedAt))) + '</td></tr>';
  }).join('') + '</tbody></table>';
  var items = '<table><thead><tr><th>Dish</th><th class="n">Qty</th><th class="n">Price</th></tr></thead><tbody>' + (b.items || []).map(function (it) {
    return '<tr><td>' + esc(it.name) + '</td><td class="n">' + esc(it.qty || 1) + '</td><td class="n">' + Currency.fmt(it.price, b.currency) + '</td></tr>'; }).join('') +
    (b.service ? '<tr><td class="muted">Service charge</td><td></td><td class="n">' + Currency.fmt(b.service, b.currency) + '</td></tr>' : '') +
    (b.sst ? '<tr><td class="muted">SST / tax</td><td></td><td class="n">' + Currency.fmt(b.sst, b.currency) + '</td></tr>' : '') +
    (b.rounding ? '<tr><td class="muted">Rounding</td><td></td><td class="n">' + Currency.fmt(b.rounding, b.currency) + '</td></tr>' : '') +
    '<tr><td><b>Total</b></td><td></td><td class="n"><b>' + money(c.total, b) + '</b></td></tr></tbody></table>';
  return '<div class="sub"><div><b>People</b>' + ppl + (c.unclaimed.total ? '<p class="small muted">' + Currency.fmt(c.unclaimed.total, b.currency) + ' of dishes not picked by anyone yet.</p>' : '') + '</div><div><b>Receipt</b>' + items + '</div></div>' +
    '<p class="small muted" style="margin:10px 0 0">Bill ' + esc(b.id) + (fx(b) ? ' · rate RM ' + esc(b.rate) + ' per ' + esc(b.currency) : '') + (b.hasReceipt ? ' · receipt photo kept' : '') + (b.hasQr ? ' · DuitNow QR added' : '') + (b.editedAt ? ' · edited ' + esc(when(b.editedAt)) : '') + '</p>';
}

function tripsTable(trips) {
  var list = A.tq.trim() ? trips.filter(function (t) { return found([t.title, t.id].concat(t.members.map(function (m) { return m.name; })).concat((t.expenses || []).map(function (e) { return e.title + ' ' + e.date; })).join(' '), A.tq); }) : trips;
  var h = '<div class="row between" style="margin-top:28px"><h2 style="margin:0">All trips</h2><input type="search" id="tq" data-q="tq" value="' + esc(A.tq) + '" placeholder="Search name, friend, expense" aria-label="Search trips" style="flex:1;max-width:320px"></div>';
  h += '<p class="muted small">' + list.length + ' trip' + (list.length === 1 ? '' : 's') + (list.length > 200 ? ', newest 200 shown' : '') + '.</p>';
  if (!list.length) return h + '<div class="card empty">No trips' + (A.tq ? ' match' : ' yet') + '.</div>';
  h += '<div class="tablewrap"><table><thead><tr><th>Trip</th><th class="hide-sm">Started by</th><th class="n">People</th><th class="n">Expenses</th><th class="n">Spent</th><th class="n">Settled</th><th class="hide-sm">Created</th></tr></thead><tbody>';
  list.slice(0, 200).forEach(function (t) {
    var i = tripInfo(t), open = A.open['t' + t.id];
    h += '<tr class="main" data-open="t' + t.id + '" tabindex="0" aria-expanded="' + !!open + '"><td><b>' + esc(t.title) + '</b></td><td class="hide-sm">' + esc(i.owner) + '</td><td class="n">' + t.members.length + '</td><td class="n">' + (t.expenses || []).length + '</td><td class="n">' + RM(i.totalRM) + '</td><td class="n">' + RM(i.paidRM) + '</td><td class="hide-sm muted">' + esc(when(t.createdAt)) + '</td></tr>';
    if (open) h += '<tr class="detail"><td colspan="7">' + tripDetail(t, i) + '</td></tr>';
  });
  return h + '</tbody></table></div>';
}
function tripDetail(t, i) {
  var ppl = '<table><thead><tr><th>Person</th><th class="n">Paid</th><th class="n">Their share</th><th class="n">Gets back / owes</th></tr></thead><tbody>' + t.members.map(function (m) {
    var b = i.bal[m.id] || { paid: 0, owes: 0, net: 0 };
    return '<tr><td>' + esc(m.name) + '</td><td class="n">' + RM(b.paid) + '</td><td class="n">' + RM(b.owes) + '</td><td class="n">' + (b.net > 0 ? 'gets back ' + RM(b.net) : b.net < 0 ? 'owes ' + RM(-b.net) : 'settled') + '</td></tr>';
  }).join('') + '</tbody></table>';
  var ex = '<table><thead><tr><th>Expense</th><th>Paid by</th><th class="n">Amount</th></tr></thead><tbody>' + ((t.expenses || []).map(function (e) {
    return '<tr><td>' + esc(e.title) + ' <span class="muted small">' + esc(e.date || '') + '</span></td><td>' + esc(tname(t, e.paidBy)) + '</td><td class="n">' + money(e.amount, e) + '</td></tr>'; }).join('') || '<tr><td colspan="3" class="muted">No expenses yet</td></tr>') + '</tbody></table>';
  var pays = (t.payments || []).map(function (p) { return '<li>' + esc(tname(t, p.from)) + ' → ' + esc(tname(t, p.to)) + ': ' + RM(p.amount) + ' <span class="pill ' + (p.status === 'paid' ? 'paid' : 'sent') + '">' + (p.status === 'paid' ? 'Confirmed' : 'Slip sent') + '</span></li>'; }).join('');
  return '<div class="sub"><div><b>People</b>' + ppl + '</div><div><b>Expenses</b>' + ex + '</div></div>' + (pays ? '<p style="margin:12px 0 4px"><b>Payments</b></p><ul class="small" style="margin:0">' + pays + '</ul>' : '') + '<p class="small muted" style="margin:10px 0 0">Trip ' + esc(t.id) + '</p>';
}

/* ---------- CSV: one row per person per bill, then per person per trip ---------- */
function csv() {
  var q = function (v) { v = String(v == null ? '' : v); if (/^[=+\-@]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };
  var amt = function (c) { return (c / 100).toFixed(2); };
  var rows = [['kind', 'id', 'name', 'bill date', 'created', 'currency', 'total', 'total RM', 'person', 'role', 'share', 'share RM', 'status', 'paid or sent at']];
  A.data.bills.forEach(function (b) {
    var i = billInfo(b);
    i.people.forEach(function (p) { rows.push(['bill', b.id, b.title, b.date, when(b.createdAt), b.currency || 'MYR', amt(i.c.total), amt(i.totalRM), p.m.name, p.m.isPayer ? 'payer' : 'friend', amt(p.m.isPayer ? p.share : p.owes), amt(rmOf(p.m.isPayer ? p.share : p.owes, b)), p.status, when(p.at)]); });
  });
  A.data.trips.forEach(function (t) {
    var i = tripInfo(t);
    t.members.forEach(function (m) { var b = i.bal[m.id] || { owes: 0, net: 0 }; rows.push(['trip', t.id, t.title, '', when(t.createdAt), 'MYR', amt(i.totalRM), amt(i.totalRM), m.name, m.id === t.ownerId ? 'started it' : 'member', amt(b.owes), amt(b.owes), b.net > 0 ? 'gets back ' + amt(b.net) : b.net < 0 ? 'owes ' + amt(-b.net) : 'settled', '']); });
  });
  var blob = new Blob(['﻿' + rows.map(function (r) { return r.map(q).join(','); }).join('\r\n')], { type: 'text/csv' });
  var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'bei-cin-lah-' + dayOf(Date.now()) + '.csv'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
}

/* ---------- events ---------- */
document.addEventListener('submit', function (e) {
  if (e.target.id !== 'lockform') return; e.preventDefault();
  var v = $('#pw').value; if (!v) return;
  try { sessionStorage.setItem(KEY, v); } catch (x) {}
  load();
});
document.addEventListener('click', function (e) {
  var t = e.target.closest('[data-act],[data-range],[data-open]'); if (!t) return;
  if (t.hasAttribute('data-range')) { A.range = +t.getAttribute('data-range'); return paint(); }
  if (t.hasAttribute('data-open')) { var k = t.getAttribute('data-open'); A.open[k] = !A.open[k]; return paint(); }
  var act = t.getAttribute('data-act');
  if (act === 'refresh') load();
  else if (act === 'csv') csv();
  else if (act === 'lock') { try { sessionStorage.removeItem(KEY); } catch (x) {} A.data = null; A.err = ''; paint(); }
});
document.addEventListener('keydown', function (e) { if ((e.key === 'Enter' || e.key === ' ') && e.target.hasAttribute && e.target.hasAttribute('data-open')) { e.preventDefault(); e.target.click(); } });
document.addEventListener('input', function (e) { var k = e.target.getAttribute && e.target.getAttribute('data-q'); if (k) { A[k] = e.target.value; paint(); } });
// Chart tooltips.
var tip = $('#tip');
document.addEventListener('mousemove', function (e) {
  var t = e.target.closest && e.target.closest('[data-tip]');
  document.querySelectorAll('.bar.on').forEach(function (b) { b.classList.remove('on'); });
  if (!t) { tip.style.display = 'none'; return; }
  var bar = t.nextElementSibling; if (bar && bar.classList.contains('bar')) bar.classList.add('on');
  tip.textContent = t.getAttribute('data-tip'); tip.style.display = 'block';
  var x = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8); tip.style.left = x + 'px'; tip.style.top = (e.clientY - 36) + 'px';
});
setInterval(function () { if (A.data && !document.hidden && !A.busy) load(); }, 60000);
load();
})();
