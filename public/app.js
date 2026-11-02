(function () {
'use strict';
var $ = function (s) { return document.querySelector(s); };
var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
var fmt = function (c) { return 'RM ' + (c < 0 ? '-' : '') + (Math.abs(c) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
var toC = function (s) { var n = parseFloat(String(s == null ? '' : s).replace(/,/g, '')); return isFinite(n) ? Math.round(n * 100) : 0; };
var fixed = function (c) { return (c / 100).toFixed(2); };
function ago(ms) { var m = Math.round((Date.now() - ms) / 60000); if (m < 1) return 'just now'; if (m < 60) return m + ' min ago'; var h = Math.round(m / 60); if (h < 24) return h + ' h ago'; var d = Math.round(h / 24); return d + ' day' + (d > 1 ? 's' : '') + ' ago'; }
function hue(id) { var h = 0; for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360; return h; }

var S = { cfg: { scan: false }, store: loadStore(), view: 'home', billId: null, bill: null, home: [], homeLoaded: false, err: '',
  draft: null, acting: null, modal: null, busy: 0, chain: Promise.resolve(), scanning: false, creating: false, slipChecks: {}, slipRun: false, tripId: null, trip: null, edraft: null, pickEid: null, pickAs: null, payTo: null, payAmt: 0, homeTrips: [], confirmDel: null, toastT: null, toastMsg: '' };

function loadStore() { try { var o = JSON.parse(localStorage.getItem('bcl.v1')); if (o && o.bills) { o.trips = o.trips || {}; return o; } } catch (e) {} return { bills: {}, trips: {}, name: '' }; }
function saveStore() { try { localStorage.setItem('bcl.v1', JSON.stringify(S.store)); } catch (e) {} }
function tok(id) { var r = S.store.bills[id]; return r ? r.token : ''; }

async function api(method, url, body, token) {
  var r = await fetch(url, { method: method, headers: { 'content-type': 'application/json', 'x-token': token || '' }, body: body ? JSON.stringify(body) : undefined });
  var j = {}; try { j = await r.json(); } catch (e) {}
  if (!r.ok) { var e = new Error(j.error || 'Something went wrong'); e.status = r.status; throw e; }
  return j;
}
function bapi(method, path, body) { return api(method, '/api/bills/' + S.billId + path, body, tok(S.billId)); }

/* ---------- helpers on the current bill ---------- */
function mem(b, id) { for (var i = 0; i < b.members.length; i++) if (b.members[i].id === id) return b.members[i]; return null; }
function nm(b, id) { var m = mem(b, id); return m ? m.name : 'Someone'; }
function myId(b) { var r = S.store.bills[b.id]; return r && mem(b, r.memberId) ? r.memberId : null; }
function owedBy(m, c) { var p = m.pay || {}; if (p.amount != null && (p.status === 'paid' || p.status === 'sent')) return p.amount; var s = c.per[m.id]; return s ? s.total : 0; }
function av(b, id) { var n = nm(b, id); return '<span class="av" style="background:hsl(' + hue(id) + ' 50% 40%)" title="' + esc(n) + '">' + esc(n.trim().charAt(0).toUpperCase() || '?') + '</span>'; }
function shareUrl(b) { return location.origin + '/b/' + b.id; }

/* ---------- images ---------- */
async function toJpeg(file, max, maxChars) {
  var bmp = await createImageBitmap(file);
  var s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
  var x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(bmp, 0, 0, c.width, c.height);
  var q = 0.85, url = c.toDataURL('image/jpeg', q);
  while (url.length > maxChars && q > 0.3) { q -= 0.12; url = c.toDataURL('image/jpeg', q); }
  return url;
}
var b64 = function (u) { return String(u || '').split(',')[1] || ''; };

/* ---------- toast + modal ---------- */
function toast(m) {
  S.toastMsg = m; paintToast(); clearTimeout(S.toastT);
  S.toastT = setTimeout(function () { S.toastMsg = ''; paintToast(); }, 2800);
}
function paintToast() {
  var o = $('#overlay'), el = o.querySelector('.toast');
  if (!S.toastMsg) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); o.appendChild(el); }
  el.textContent = S.toastMsg;
}
function paintModal() {
  var o = $('#overlay'), old = o.querySelector('.modal'); if (old) old.remove();
  var m = S.modal; if (!m) return;
  var d = document.createElement('div'); d.className = 'modal'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('data-act', 'closemodal');
  d.innerHTML = '<div class="box"><div class="row between"><b>' + esc(m.title) + '</b><button class="btn small" data-act="closemodal">Close</button></div>' +
    (m.src ? '<img src="' + esc(m.src) + '" alt="' + esc(m.title) + '">' : '') +
    (m.acts ? '<div class="row" style="flex-wrap:wrap">' + m.acts + '</div>' : '') +
    (m.text != null ? '<textarea id="mtext" readonly>' + esc(m.text) + '</textarea>' + (m.wa ? '<a class="btn primary" href="' + esc(m.wa) + '" target="_blank" rel="noopener" style="text-align:center;text-decoration:none">Open WhatsApp</a>' : '') + '<button class="btn" data-act="copymodal">Copy message</button>' : '') + '</div>';
  o.insertBefore(d, o.firstChild);
}
function closeModal() { if (S.modal && S.modal.src && S.modal.src.indexOf('blob:') === 0) URL.revokeObjectURL(S.modal.src); S.modal = null; paintModal(); }
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('Copied'); }
  catch (e) { var ta = $('#mtext'); if (ta) { ta.focus(); ta.select(); } toast('Press and hold the text to copy it'); }
}

/* ---------- routing ---------- */
function nav(p) { history.pushState(null, '', p); route(true); }
async function route(scroll) {
  var p = location.pathname, m;
  if (scroll) window.scrollTo(0, 0);
  S.acting = null; S.err = '';
  if (p === '/new') { S.view = 'new'; if (!S.draft || S.draft.editId) S.draft = loadDraft() || newDraft(); render(); return; }
  if ((m = p.match(/^\/b\/([a-z0-9]+)\/edit$/))) { S.view = 'new'; S.billId = m[1]; S.draft = null; render(); await startEdit(m[1]); return; }
  if (p === '/t/new') { S.view = 'tripnew'; render(); return; }
  if ((m = p.match(/^\/t\/([a-z0-9]+)\/(add|e\/(e\d+))$/))) { S.view = 'expense'; S.tripId = m[1]; S.edraft = null; render(); await startExpense(m[1], m[3] || null); return; }
  if ((m = p.match(/^\/t\/([a-z0-9]+)\/x\/(e\d+)$/))) {
    S.view = 'picks'; S.pickEid = m[2]; if (S.tripId !== m[1]) { S.trip = null; S.pickAs = null; } S.tripId = m[1]; render(); await loadTrip(m[1]); return;
  }
  if ((m = p.match(/^\/t\/([a-z0-9]+)$/))) { S.view = 'trip'; if (S.tripId !== m[1]) { S.trip = null; S.payTo = null; } S.tripId = m[1]; render(); await loadTrip(m[1]); return; }
  if ((m = p.match(/^\/b\/([a-z0-9]+)$/))) { S.view = 'bill'; S.billId = m[1]; S.bill = null; render(); await loadBill(m[1]); return; }
  S.view = 'home'; await loadHome();
}
async function loadBill(id) {
  var h = location.hash.match(/k=([a-f0-9]{48})/);
  if (h) {
    try { var r = await api('POST', '/api/bills/' + id + '/auth', null, h[1]); S.store.bills[id] = { token: h[1], memberId: r.memberId, title: r.bill.title }; saveStore(); } catch (e) {}
    history.replaceState(null, '', location.pathname);
  }
  try {
    var j = await api('GET', '/api/bills/' + id, null, tok(id));
    if (S.billId !== id) return;
    S.bill = j.bill;
    if (S.store.bills[id]) { S.store.bills[id].title = j.bill.title; saveStore(); }
  } catch (e) { S.err = e.status === 404 ? 'This bill was not found. It may have been deleted.' : 'Could not open this bill. Check your connection.'; }
  render();
}
async function refresh() {
  if (S.view !== 'bill' || !S.billId) return;
  try { var j = await api('GET', '/api/bills/' + S.billId, null, tok(S.billId)); if (!S.busy) { S.bill = j.bill; render(); } } catch (e) {}
}
async function loadHome() {
  S.homeLoaded = false; render();
  var ids = Object.keys(S.store.bills);
  var res = await Promise.all(ids.map(function (id) {
    return api('GET', '/api/bills/' + id, null, tok(id)).then(function (j) { return j.bill; }, function (e) { if (e.status === 404) { delete S.store.bills[id]; } return null; });
  }));
  var tids = Object.keys(S.store.trips);
  var tres = await Promise.all(tids.map(function (id) {
    return api('GET', '/api/trips/' + id, null, ttok(id)).then(function (j) { return j.trip; }, function (e) { if (e.status === 404) { delete S.store.trips[id]; } return null; });
  }));
  saveStore();
  S.homeTrips = tres.filter(Boolean).sort(function (a, z) { return z.createdAt - a.createdAt; });
  S.home = res.filter(Boolean).sort(function (a, z) { return z.createdAt - a.createdAt; });
  S.homeLoaded = true; render();
}

/* ---------- drafts (new bill, or editing one) ---------- */
function newDraft() { return { title: '', date: new Date().toISOString().slice(0, 10), payerName: S.store.name || '', items: [{ name: '', qty: '1', price: '' }], service: '', sst: '', rounding: '', qr: '', receipt: '', scanFile: null, scanTotal: 0, scanNote: '' }; }
// An unfinished new bill is kept on this phone, so a refresh or a closed tab does not lose a scanned receipt.
var DRAFT_KEY = 'bcl.draft.v1', DRAFT_FIELDS = ['title', 'date', 'payerName', 'items', 'service', 'sst', 'rounding', 'qr', 'receipt', 'scanTotal', 'scanNote', 'scanTitle'], draftT = null;
function saveDraft() {
  var d = S.draft; if (!d || d.editId) return;
  clearTimeout(draftT);
  draftT = setTimeout(function () {
    var o = {}; DRAFT_FIELDS.forEach(function (k) { o[k] = d[k]; });
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(o)); } catch (e) {}
  }, 300);
}
function loadDraft() {
  try { var o = JSON.parse(localStorage.getItem(DRAFT_KEY)); if (o && Array.isArray(o.items) && o.items.length) return Object.assign(newDraft(), o); } catch (e) {}
  return null;
}
function clearDraft() { clearTimeout(draftT); try { localStorage.removeItem(DRAFT_KEY); } catch (e) {} }
function draftStarted(d) { return !!(d && (d.title || d.receipt || d.items.some(function (i) { return i.name || i.price; }))); }
// Editing an existing bill uses the same form, filled from the bill. Item ids are kept so people's ticks stay.
async function startEdit(id) {
  try {
    var b = (await api('GET', '/api/bills/' + id, null, tok(id))).bill, me = myId(b);
    if (!me || !mem(b, me).isPayer) { toast('Only the person who paid can edit this bill'); nav('/b/' + id); return; }
    S.draft = { editId: id, title: b.title, date: b.date, payerName: nm(b, b.payerId), service: b.service ? fixed(b.service) : '', sst: b.sst ? fixed(b.sst) : '', rounding: b.rounding ? fixed(b.rounding) : '',
      items: b.items.map(function (i) { return { id: i.id, name: i.name, qty: String(i.qty), price: fixed(Math.round(i.price / i.qty)), line: i.price }; }),
      paidCount: b.members.filter(function (m) { return !m.isPayer && m.pay.status === 'paid'; }).length, qr: '', receipt: '', scanFile: null, scanTotal: 0, scanNote: '' };
  } catch (e) { toast(e.status === 404 ? 'This bill was not found' : 'Could not open this bill'); nav('/'); return; }
  render();
}
function lineCents(i) { var q = Math.max(1, parseInt(i.qty, 10) || 1); return i.line != null ? i.line : toC(i.price) * q; }
function draftSum(d) { var s = 0; d.items.forEach(function (i) { s += lineCents(i); }); return s; }
function draftTotal(d) { return draftSum(d) + toC(d.service) + toC(d.sst) + toC(d.rounding); }

/* ---------- views ---------- */
function topbar() {
  return '<div class="top"><div><button class="brand" data-nav="/" aria-label="Bei Cin Lah home">Bei <span>Cin</span> Lah</button><div class="tag">Scan the receipt. Everyone picks what they ate. Pay by DuitNow.</div></div></div>';
}
function statusPill(m, c, isPayerRow) {
  var s = c.per[m.id], st = (m.pay || {}).status || 'unpaid';
  if (isPayerRow) return '<span class="pill open">Paid the bill</span>';
  if (!s) return '<span class="pill none">Not picked</span>';
  return '<span class="pill ' + st + '">' + (st === 'paid' ? 'Paid' : st === 'sent' ? 'Slip sent' : 'Unpaid') + '</span>';
}
function alertsFor(bills) {
  var out = '';
  bills.forEach(function (b) {
    var id = myId(b); if (!id) return;
    var c = Split.calc(b), me = mem(b, id);
    if (!me.isPayer) {
      var s = c.per[id];
      if (s && s.total > 0 && me.pay.status === 'unpaid') out += '<div class="alert"><span>You still owe <b class="mono">' + fmt(s.total) + '</b> to ' + esc(nm(b, b.payerId)) + ' for ' + esc(b.title) + (me.remind ? '. Reminded ' + ago(me.remind.at) + '.' : '.') + '</span><button class="btn small" data-nav="/b/' + b.id + '">Pay now</button></div>';
      else if (!s) out += '<div class="alert info"><span>Pick what you ate in ' + esc(b.title) + '.</span><button class="btn small" data-nav="/b/' + b.id + '">Choose items</button></div>';
    } else {
      var n = b.members.filter(function (m) { return !m.isPayer && m.pay.status === 'sent'; }).length;
      if (n) out += '<div class="alert info"><span>' + n + ' payment slip' + (n > 1 ? 's' : '') + ' waiting for you to confirm in ' + esc(b.title) + '.</span><button class="btn small" data-nav="/b/' + b.id + '">Review</button></div>';
    }
  });
  return out;
}
function viewHome() {
  var h = topbar();
  if (!S.homeLoaded) return h + '<div class="card empty"><h3>Loading your bills…</h3></div>';
  var owe = 0, owed = 0;
  S.home.forEach(function (b) {
    var id = myId(b); if (!id) return; var c = Split.calc(b), me = mem(b, id);
    if (me.isPayer) b.members.forEach(function (m) { if (!m.isPayer && m.pay.status !== 'paid') owed += owedBy(m, c); });
    else if (c.per[id] && me.pay.status !== 'paid') owe += owedBy(me, c);
  });
  S.homeTrips.forEach(function (t) { var id = tmyId(t); if (!id) return; var n = tripNet(t, id); if (n > 0) owed += n; else owe -= n; });
  var ud = loadDraft();
  if (draftStarted(ud)) {
    var n = ud.items.filter(function (i) { return lineCents(i) > 0; }).length;
    h += '<div class="alert info"><span>You have an unfinished bill' + (ud.title ? ': <b>' + esc(ud.title) + '</b>' : '') + (n ? ' (' + n + ' item' + (n > 1 ? 's' : '') + ', ' + fmt(draftTotal(ud)) + ')' : '') + '.</span><span class="row" style="gap:6px"><button class="btn small primary" data-nav="/new">Continue</button><button class="btn small" data-act="discarddraft">Discard</button></span></div>';
  }
  h += alertsFor(S.home);
  h += '<div class="tiles"><div class="tile"><div class="k">You owe</div><div class="v">' + fmt(owe) + '</div></div><div class="tile"><div class="k">Owed to you</div><div class="v">' + fmt(owed) + '</div></div></div>';
  h += '<div class="row between"><h2>Your bills</h2><button class="btn primary" data-nav="/new">New bill</button></div>';
  if (!S.home.length) h += '<div class="card empty"><h3>No bills yet</h3><p class="muted">Add a receipt, send the link to your friends, and let them pick their dishes. Bills you create or join on this phone show up here.</p><button class="btn primary" data-nav="/new">Add a receipt</button></div>';
  S.home.forEach(function (b) {
    var id = myId(b), c = Split.calc(b), me = id ? mem(b, id) : null, pill = '', line = '';
    var others = b.members.filter(function (m) { return !m.isPayer && c.per[m.id]; });
    if (!me) pill = '<span class="pill none">Not joined</span>';
    else if (me.isPayer) { pill = '<span class="pill open">You paid</span>'; line = others.filter(function (m) { return m.pay.status === 'paid'; }).length + ' of ' + others.length + ' settled'; }
    else if (!c.per[id]) pill = '<span class="pill open">Pick items</span>';
    else { var st = me.pay.status; pill = '<span class="pill ' + st + '">' + (st === 'paid' ? 'Paid' : st === 'sent' ? 'Slip sent' : 'To pay') + '</span>'; line = 'Your share ' + fmt(owedBy(me, c)); }
    h += '<button class="bill" data-nav="/b/' + b.id + '"><div class="grow"><div class="t">' + esc(b.title) + '</div><div class="small muted">' + esc(b.date || '') + ' · paid by ' + esc(nm(b, b.payerId)) + ' · ' + fmt(c.total) + '</div>' + (line ? '<div class="small mono">' + esc(line) + '</div>' : '') + '</div>' + pill + '</button>';
  });
  h += '<div class="row between"><h2>Your trips</h2><button class="btn primary" data-nav="/t/new">New trip</button></div>';
  if (!S.homeTrips.length) h += '<div class="card empty"><h3>No trips yet</h3><p class="muted">Going away or holding an event where different people pay? Start a trip, everyone adds what they paid, and the app works out who pays whom at the end.</p></div>';
  S.homeTrips.forEach(function (tr) {
    var id = tmyId(tr), n = id ? tripNet(tr, id) : 0;
    var pill = !id ? '<span class="pill none">Not joined</span>' : n > 0 ? '<span class="pill open">Gets back</span>' : n < 0 ? '<span class="pill unpaid">To pay</span>' : '<span class="pill paid">Settled</span>';
    h += '<button class="bill" data-nav="/t/' + tr.id + '"><div class="grow"><div class="t">' + esc(tr.title) + '</div><div class="small muted">Trip · ' + tr.members.length + (tr.members.length === 1 ? ' person · ' : ' people · ') + fmt(Settle.total(tr)) + '</div>' + (id && n ? '<div class="small mono">' + (n > 0 ? 'You get back ' + fmt(n) : 'You owe ' + fmt(-n)) + '</div>' : '') + '</div>' + pill + '</button>';
  });
  h += '<p class="foot">Reminders show up when someone opens the bill. To send them on WhatsApp, use the Remind button on a bill.</p>';
  return h;
}
function receiptTotals(b, c) {
  var h = '<div class="chg"><span>Subtotal</span><span>' + fmt(c.sum) + '</span></div>';
  if (b.service) h += '<div class="chg"><span>Service charge' + (c.sum ? ' (' + (b.service / c.sum * 100).toFixed(0) + '%)' : '') + '</span><span>' + fmt(b.service) + '</span></div>';
  if (b.sst) h += '<div class="chg"><span>SST' + (c.sum + b.service ? ' (' + (b.sst / (c.sum + b.service) * 100).toFixed(0) + '%)' : '') + '</span><span>' + fmt(b.sst) + '</span></div>';
  if (b.rounding) h += '<div class="chg"><span>Rounding</span><span>' + fmt(b.rounding) + '</span></div>';
  return h + '<div class="chg tot"><span>Total</span><span>' + fmt(c.total) + '</span></div>';
}
function viewBill() {
  if (S.err) return topbar() + '<div class="card empty"><h3>' + esc(S.err) + '</h3><button class="btn primary" data-nav="/">Back to your bills</button></div>';
  var b = S.bill;
  if (!b) return topbar() + '<div class="card empty"><h3>Opening bill…</h3></div>';
  var c = Split.calc(b), meId = myId(b), me = meId ? mem(b, meId) : null, isPayer = !!(me && me.isPayer);
  var h = topbar() + alertsFor([b]) + '<button class="btn ghost" data-nav="/">← Your bills</button>';
  h += '<div class="row between" style="align-items:flex-start"><div class="grow"><h2>' + esc(b.title) + '</h2><div class="small muted">' + esc(b.date || '') + ' · paid by ' + esc(nm(b, b.payerId)) + (isPayer ? ' (you)' : '') + '</div></div><div class="mono" style="font-size:20px">' + fmt(c.total) + '</div></div>';

  if (!me) {
    var open = b.members.filter(function (m) { return !m.claimed; });
    h += '<div class="card"><h3>Join this bill</h3><p class="muted">' + esc(nm(b, b.payerId)) + ' paid and is sharing this bill with you. Join to pick what you ate.</p>';
    if (open.length) h += '<div><div class="small muted" style="margin-bottom:6px">Are you one of these?</div><div class="chips">' + open.map(function (m) { return '<button class="btn small" data-act="claim" data-uid="' + m.id + '">I am ' + esc(m.name) + '</button>'; }).join('') + '</div></div>';
    h += '<div class="field"><label for="jname">' + (open.length ? 'Or enter your name' : 'Your name') + '</label><input type="text" id="jname" maxlength="40" placeholder="e.g. Wei Jie" value="' + esc(S.store.name || '') + '"></div><div><button class="btn primary" data-act="join">Join and pick my dishes</button></div><p class="small muted">Paid this bill yourself? Don\'t pick a name here. Open the bill on the phone you created it on, or use your payer link.</p></div>';
    h += '<div class="card"><h3>What was ordered</h3><div class="receipt">' + b.items.map(function (it) { return '<div class="ln"><span class="nm">' + esc(it.name) + (it.qty > 1 ? '<span class="sub">' + it.qty + ' × ' + fmt(Math.round(it.price / it.qty)) + '</span>' : '') + '</span><span class="pr">' + fmt(it.price) + '</span></div>'; }).join('') + receiptTotals(b, c) + '</div></div>';
    return h;
  }

  if (!isPayer) h += '<p class="small muted">You are <b>' + esc(me.name) + '</b> on this bill. <button class="btn small" data-act="leave">Not ' + esc(me.name) + '? Switch person</button></p>';
  var ac = meId; if (isPayer && S.acting && mem(b, S.acting)) ac = S.acting;
  var acm = mem(b, ac), my = c.per[ac], myPicks = acm.picks || [];

  if (isPayer) {
    var link = shareUrl(b), msg = 'Hi! Please pick what you ate for "' + b.title + '" and pay me by DuitNow here: ' + link;
    h += '<div class="card"><h3>Send this link to your friends</h3><div class="linkbox"><input type="text" id="sharelink" readonly aria-label="Bill link" value="' + esc(link) + '"><button class="btn" data-act="copylink">Copy link</button><a class="btn primary" href="https://wa.me/?text=' + encodeURIComponent(msg) + '" target="_blank" rel="noopener" style="text-decoration:none">WhatsApp</a></div><p class="small muted">Friends open the link, type their name and pick their dishes. No sign-up.</p></div>';
    if (!b.hasQr) h += '<div class="alert"><span>Add your DuitNow QR so friends can scan it and pay you.</span><button class="btn small primary" data-act="addqr">Add DuitNow QR</button></div>';
    h += notifyHtml(b);
    h += '<div class="card"><h3>People on this bill</h3><div class="chips">' + b.members.map(function (m) { return '<button class="btn small' + (m.id === ac ? ' primary' : '') + '" data-act="acting" data-uid="' + m.id + '">' + esc(m.id === meId ? 'You' : m.name) + '</button>'; }).join('') + '</div><p class="small muted">Tap a name, then tap the dishes that person ate. A dish picked by 2 or more people is split equally. Add friends here if you want to pick for them.</p><div class="row"><input type="text" id="gname" aria-label="Friend name" placeholder="Friend name" maxlength="40"><button class="btn" data-act="addguest">Add friend</button></div>' + ((!acm.isPayer && ac !== meId) ? '<div><button class="btn small" data-act="rmguest" style="color:var(--bad)">Remove ' + esc(acm.name) + '</button></div>' : '') + '</div>';
  }

  h += '<div class="card"><div class="row between"><h3>' + (ac === meId ? 'Tap what you ate' : 'Tap what ' + esc(acm.name) + ' ate') + '</h3>' + (b.hasReceipt ? '<button class="btn small" data-act="zoom" data-src="receipt">View receipt</button>' : '') + '</div><div class="receipt">';
  b.items.forEach(function (it) {
    var who = b.members.filter(function (m) { return (m.picks || []).indexOf(it.id) > -1; });
    var on = myPicks.indexOf(it.id) > -1, part = '';
    if (on && my) { var l = my.lines.filter(function (x) { return x.id === it.id; })[0]; if (l && l.n > 1) part = '<span class="sub">part ' + fmt(l.cents) + ' (÷' + l.n + ')</span>'; }
    var unit = it.qty > 1 ? '<span class="sub">' + it.qty + ' × ' + fmt(Math.round(it.price / it.qty)) + '</span>' : '';
    h += '<button class="ln' + (on ? ' on' : '') + '" data-act="pick" data-id="' + it.id + '" aria-pressed="' + on + '"><span class="chk">' + (on ? '✓' : '') + '</span><span class="nm">' + esc(it.name) + unit + '</span><span class="avs">' + who.slice(0, 4).map(function (m) { return av(b, m.id); }).join('') + '</span><span class="pr">' + fmt(it.price) + part + '</span></button>';
  });
  h += receiptTotals(b, c) + '</div>';
  if (c.unclaimed.sub > 0) h += '<p class="small muted">' + fmt(c.unclaimed.total) + ' of unclaimed items stays with ' + esc(nm(b, b.payerId)) + ' until someone picks them.</p>';
  h += '</div>';

  if (my) {
    var st = acm.pay.status, you = ac === meId;
    h += '<div class="card share"><div class="row between"><h3>' + (you ? 'Your share' : esc(acm.name) + "'s share") + '</h3><span class="pill ' + (acm.isPayer ? 'open' : st) + '">' + (acm.isPayer ? 'Paid the bill' : st === 'paid' ? 'Paid' : st === 'sent' ? 'Slip sent' : 'To pay') + '</span></div><div class="receipt">';
    my.lines.forEach(function (l) { h += '<div class="chg" style="color:var(--ink)"><span>' + esc(l.name) + (l.n > 1 ? ' (÷' + l.n + ')' : '') + '</span><span>' + fmt(l.cents) + '</span></div>'; });
    if (my.svc) h += '<div class="chg"><span>Service charge</span><span>' + fmt(my.svc) + '</span></div>';
    if (my.sst) h += '<div class="chg"><span>SST</span><span>' + fmt(my.sst) + '</span></div>';
    if (my.rnd) h += '<div class="chg"><span>Rounding</span><span>' + fmt(my.rnd) + '</span></div>';
    h += '<div class="chg tot"><span>' + (you ? 'You pay' : esc(acm.name) + ' pays') + '</span><span class="big" style="font-size:22px">' + fmt(my.total) + '</span></div></div>';
    if (!isPayer) {
      h += '<div class="pay">';
      if (b.hasQr) h += '<div><img class="qr" src="/api/bills/' + b.id + '/img/qr?v=' + (b.qrAt || b.createdAt) + '" alt="DuitNow QR for ' + esc(nm(b, b.payerId)) + '" data-act="zoom" data-src="qr" style="cursor:zoom-in"></div>';
      h += '<div class="grow" style="display:flex;flex-direction:column;gap:8px"><p><b>Pay ' + esc(nm(b, b.payerId)) + ' ' + fmt(my.total) + '</b></p>' +
        (b.hasQr ? '<p class="small muted">Save the QR picture, open your banking app, choose Scan QR, then upload it. Transfer the exact amount.</p>' : '<p class="small muted">' + esc(nm(b, b.payerId)) + ' has not added a DuitNow QR yet.</p>') +
        (st === 'paid' ? '<p class="small" style="color:var(--good);font-weight:700">' + esc(nm(b, b.payerId)) + ' confirmed your payment.</p>' :
          st === 'sent' ? '<p class="small" style="color:var(--warn);font-weight:700">Slip sent. Waiting for ' + esc(nm(b, b.payerId)) + ' to confirm.</p><div><button class="btn small" data-act="slipbtn">Replace slip</button></div>' :
          '<div><button class="btn primary" data-act="slipbtn">I have paid, upload slip</button></div>') +
        (acm.hasSlip ? '<div><button class="btn small" data-act="viewslip" data-uid="' + ac + '">View my slip</button></div>' : '') + '</div></div>';
    }
    h += '</div>';
  } else if (ac === meId) h += '<div class="card"><p class="muted">Tap the dishes you ate above. Your share, with service charge and SST, appears here.</p></div>';

  h += '<div class="card"><div class="row between"><h3>Who has paid</h3>' + (isPayer ? '<span class="row" style="gap:6px;flex-wrap:wrap">' + (matchingSlips(b).length ? '<button class="btn small primary" data-act="confirmmatching">Confirm all matching (' + matchingSlips(b).length + ')</button>' : '') + '<button class="btn small" data-act="remindall">Remind everyone</button></span>' : '') + '</div><div>';
  b.members.forEach(function (m) {
    var s = c.per[m.id], st = m.pay.status;
    var acts = '';
    if (isPayer && !m.isPayer) {
      if (st === 'sent') acts = '<button class="btn small primary" data-act="confirm" data-uid="' + m.id + '">Confirm received</button><button class="btn small" data-act="viewslip" data-uid="' + m.id + '">View slip</button>';
      else if (st === 'paid') acts = '<button class="btn small" data-act="unconfirm" data-uid="' + m.id + '">Undo</button>' + (m.hasSlip ? '<button class="btn small" data-act="viewslip" data-uid="' + m.id + '">View slip</button>' : '');
      else { if (s) acts += '<button class="btn small" data-act="markpaid" data-uid="' + m.id + '">Mark paid (cash)</button>'; acts += '<button class="btn small" data-act="remind" data-uid="' + m.id + '">Remind</button>'; }
      if (m.claimed) acts += '<button class="btn small" data-act="resetlink" data-uid="' + m.id + '">Reset link</button>';
    }
    h += '<div class="person">' + av(b, m.id) + '<div class="grow"><div><b>' + esc(m.name) + (m.id === meId ? ' (you)' : '') + '</b></div><div class="small muted mono">' + (s ? fmt(owedBy(m, c)) : 'No items yet') + (m.remind && st === 'unpaid' && !m.isPayer ? ' · reminded ' + m.remind.count + '×, last ' + ago(m.remind.at) : '') + '</div>' + (isPayer && st === 'sent' ? slipCheckHtml(m) : '') + '</div>' + statusPill(m, c, m.isPayer) + (acts ? '<div class="acts" style="width:100%;padding-left:38px">' + acts + '</div>' : '') + '</div>';
  });
  h += '</div></div>';
  h += '<div class="row" style="flex-wrap:wrap"><button class="btn small" data-act="summary">Share summary</button>' + (isPayer ? '<button class="btn small" data-nav="/b/' + b.id + '/edit">Edit items</button>' + (b.hasQr ? '<button class="btn small" data-act="addqr">Change DuitNow QR</button>' : '') + '<button class="btn small" data-act="copyadmin">Copy my payer link (keep private)</button><button class="btn small" data-act="delete" style="color:var(--bad)">Delete bill</button>' : '') + '</div>';
  return h;
}
function totalsHtml(d) {
  var sum = draftSum(d), tot = draftTotal(d), w = '';
  if (d.scanTotal && Math.abs(d.scanTotal - tot) > 1) w = '<span class="small" style="color:var(--warn);display:block;font-weight:400">Receipt total read as ' + fmt(d.scanTotal) + '. Check the items and charges.</span>';
  return '<span>Total<span class="small" style="display:block;color:var(--muted);font-weight:400">Items ' + fmt(sum) + '</span>' + w + '</span><span>' + fmt(tot) + '</span>';
}
function viewNew() {
  var d = S.draft;
  if (!d) return topbar() + '<div class="card empty"><h3>Opening bill…</h3></div>';
  var ed = d.editId, back = ed ? '/b/' + ed : '/';
  var h = topbar() + '<button class="btn ghost" data-nav="' + back + '">' + (ed ? '← Back to the bill' : '← Your bills') + '</button><h2>' + (ed ? 'Edit bill' : 'New bill') + '</h2>';
  if (ed) h += '<div class="alert info"><span>Ticks stay on the dishes you keep. A dish you remove comes off whoever ticked it.' + (d.paidCount ? ' ' + d.paidCount + (d.paidCount > 1 ? ' people have' : ' person has') + ' already paid; their confirmed amount stays the same.' : '') + '</span></div>';
  else if (draftStarted(d)) h += '<p class="small muted">Saved on this phone as you go. <button class="btn small" data-act="discarddraft">Start over</button></p>';
  if (!ed) h += '<div class="card"><h3>1. Receipt</h3><div class="drop"><div class="row">' + (d.receipt ? '<img class="thumb" src="' + d.receipt + '" alt="Receipt photo">' : '') + '<div><b>' + (d.receipt ? 'Receipt attached' : 'Add a photo of the receipt') + '</b><div class="small muted">' + 'The items, service charge and SST are read for you. Check them before you create the bill. Friends can view the photo.' + '</div></div></div><div class="row"><button class="btn" data-act="pickreceipt">' + (d.receipt ? 'Change photo' : 'Choose photo') + '</button>' + (d.scanFile ? '<button class="btn primary" data-act="scan"' + (S.scanning ? ' disabled' : '') + '>' + (S.scanning ? 'Reading…' : 'Read receipt') + '</button>' : '') + '</div></div>' +
    (d.scanNote ? '<p class="small" style="color:var(--warn)">' + esc(d.scanNote) + '</p>' : '') + '</div>';
  h += '<div class="card"><h3>' + (ed ? 'Items' : '2. Items') + '</h3><div class="two"><div class="field"><label for="f-title">Bill name</label><input type="text" id="f-title" data-f="title" maxlength="80" value="' + esc(d.title) + '" placeholder="e.g. Thai dinner"></div><div class="field"><label for="f-date">Date</label><input type="date" id="f-date" data-f="date" value="' + esc(d.date) + '"></div><div class="field"><label for="f-payer">Your name (you paid)</label><input type="text" id="f-payer" data-f="payerName" maxlength="40"' + (ed ? ' disabled' : '') + ' value="' + esc(d.payerName) + '" placeholder="e.g. Katherine"></div></div>';
  h += '<div class="items"><div class="irow h"><span>Item</span><span>Qty</span><span>Each (RM)</span><span style="text-align:right">Total</span><span></span></div>';
  d.items.forEach(function (it, i) { h += '<div class="irow"><input type="text" aria-label="Item name" data-i="' + i + '" data-k="name" value="' + esc(it.name) + '" placeholder="Item"><input type="number" min="1" aria-label="Quantity" data-i="' + i + '" data-k="qty" value="' + esc(it.qty) + '"><input type="number" step="0.01" min="0" inputmode="decimal" aria-label="Price of one" data-i="' + i + '" data-k="price" value="' + esc(it.price) + '" placeholder="0.00"><span class="mono small" data-line="' + i + '">' + fmt(lineCents(it)) + '</span><button class="x" data-act="rmitem" data-i="' + i + '" aria-label="Remove item">×</button></div>'; });
  h += '</div><div><button class="btn small" data-act="additem">Add item</button></div><p class="small muted">Enter the price of one. The bill multiplies it by the quantity, so picking a dish with quantity 2 gives you both.</p></div>';
  h += '<div class="card"><h3>' + (ed ? 'Charges' : '3. Charges') + '</h3><div class="two"><div class="field"><label for="f-svc">Service charge (RM)</label><input type="number" step="0.01" id="f-svc" data-f="service" value="' + esc(d.service) + '" placeholder="0.00"></div><div class="field"><label for="f-sst">SST (RM)</label><input type="number" step="0.01" id="f-sst" data-f="sst" value="' + esc(d.sst) + '" placeholder="0.00"></div><div class="field"><label for="f-rnd">Rounding (RM)</label><input type="number" step="0.01" id="f-rnd" data-f="rounding" value="' + esc(d.rounding) + '" placeholder="0.00"></div></div><div class="chips"><button class="btn small" data-act="svc10">Service 10%</button><button class="btn small" data-act="sst6">SST 6%</button><button class="btn small" data-act="sst8">SST 8%</button></div><p class="small muted">The quick buttons work out the amount from your items. SST is applied after service charge. Match them to what the receipt prints.</p><div class="receipt"><div class="chg tot" id="draftTotals">' + totalsHtml(d) + '</div></div></div>';
  if (!ed) h += '<div class="card"><h3>4. Your DuitNow QR</h3><div class="drop"><div class="row">' + (d.qr ? '<img class="thumb" src="' + d.qr + '" alt="Your DuitNow QR" style="background:#fff">' : '') + '<div><b>' + (d.qr ? 'QR attached' : 'Add your DuitNow QR picture') + '</b><div class="small muted">Friends scan it to pay you the exact amount.</div></div></div><button class="btn" data-act="pickqr">' + (d.qr ? 'Change' : 'Choose picture') + '</button></div></div>';
  h += '<div class="row"><button class="btn primary" data-act="create"' + (S.creating ? ' disabled' : '') + '>' + (S.creating ? (ed ? 'Saving…' : 'Creating…') : (ed ? 'Save changes' : 'Create bill')) + '</button><button class="btn" data-nav="' + back + '">Cancel</button></div>';
  return h;
}
function render() {
  var a = $('#app'); if (!a) return;
  a.innerHTML = S.view === 'new' ? viewNew() : S.view === 'bill' ? viewBill() : S.view === 'trip' ? viewTrip() : S.view === 'tripnew' ? viewTripNew() : S.view === 'expense' ? viewExpense() : S.view === 'picks' ? viewPicks() : viewHome();
  if (S.view === 'new') saveDraft();
  if (S.view === 'bill' && S.bill) checkSlips(S.bill);
}

/* ---------- actions ---------- */
function setBill(j) { S.bill = j.bill; }
function queueWrite(fn) { S.busy++; S.chain = S.chain.then(fn).catch(function (e) { toast(e.message || 'That did not save'); return refreshForce(); }).then(function () { S.busy--; render(); }); return S.chain; }
async function refreshForce() { try { var j = await api('GET', '/api/bills/' + S.billId, null, tok(S.billId)); S.bill = j.bill; } catch (e) {} }

function remindText(b, uids) {
  var c = Split.calc(b);
  var lines = uids.map(function (id) { var m = mem(b, id), s = c.per[id]; return '• ' + m.name + ': ' + (s ? fmt(owedBy(m, c)) : 'please pick your dishes'); });
  return 'Hi, a reminder for "' + b.title + '" (paid by ' + nm(b, b.payerId) + ').\n' + lines.join('\n') + '\nPlease pay via my DuitNow QR and upload your slip here: ' + shareUrl(b) + '\nThank you!';
}
function showReminder(uids, title) {
  var b = S.bill, t = remindText(b, uids);
  S.modal = { title: title, text: t, wa: 'https://wa.me/?text=' + encodeURIComponent(t) }; paintModal();
  bapi('POST', '/remind', { memberIds: uids }).then(function (j) { setBill(j); if (!S.modal) render(); }).catch(function () {});
}
/* ---------- trips: several people pay along the way, everyone settles up at the end ----------
 * A trip (or event) has people and expenses. Anyone in it adds what they paid and who shares it;
 * the trip page shows each person's balance and the transfers that settle everything (public/settle.js). */
function ttok(id) { var r = S.store.trips[id]; return r ? r.token : ''; }
function tapi(method, path, body) { return api(method, '/api/trips/' + S.tripId + path, body, ttok(S.tripId)); }
function tmem(t, id) { for (var i = 0; i < t.members.length; i++) if (t.members[i].id === id) return t.members[i]; return null; }
function tnm(t, id) { var m = tmem(t, id); return m ? m.name : 'Someone'; }
function tmyId(t) { var r = S.store.trips[t.id]; return r && tmem(t, r.memberId) ? r.memberId : null; }
function tripUrl(t) { return location.origin + '/t/' + t.id; }
function tav(t, id) { var n = tnm(t, id); return '<span class="av" style="background:hsl(' + hue(id) + ' 50% 40%)" title="' + esc(n) + '">' + esc(n.trim().charAt(0).toUpperCase() || '?') + '</span>'; }
function setTrip(j) { S.trip = j.trip; if (S.store.trips[j.trip.id]) { S.store.trips[j.trip.id].title = j.trip.title; saveStore(); } }
function tripNet(t, id) { var b = Settle.balances(t)[id]; return b ? b.net : 0; }

async function loadTrip(id) {
  var h = location.hash.match(/k=([a-f0-9]{48})/);
  if (h) {
    try { var r = await api('POST', '/api/trips/' + id + '/auth', null, h[1]); S.store.trips[id] = { token: h[1], memberId: r.memberId, title: r.trip.title }; saveStore(); } catch (e) {}
    history.replaceState(null, '', location.pathname);
  }
  try {
    var j = await api('GET', '/api/trips/' + id, null, ttok(id));
    if (S.tripId !== id) return;
    setTrip(j);
  } catch (e) { S.err = e.status === 404 ? 'This trip was not found. It may have been deleted.' : 'Could not open this trip. Check your connection.'; }
  render();
}
async function refreshTrip() {
  if ((S.view !== 'trip' && S.view !== 'picks') || !S.tripId) return;
  try { var j = await api('GET', '/api/trips/' + S.tripId, null, ttok(S.tripId)); if (!S.busy) { S.trip = j.trip; render(); } } catch (e) {}
}

function viewTripNew() {
  return topbar() + '<button class="btn ghost" data-nav="/">← Your bills</button><h2>New trip</h2>' +
    '<div class="card"><p class="muted">For a trip or an event where different people pay along the way. Everyone adds what they paid, chooses who shares it, and the app works out who pays whom at the end.</p>' +
    '<div class="two"><div class="field"><label for="tn-title">Trip or event name</label><input type="text" id="tn-title" maxlength="80" placeholder="e.g. Penang weekend"></div>' +
    '<div class="field"><label for="tn-name">Your name</label><input type="text" id="tn-name" maxlength="40" placeholder="e.g. Katherine" value="' + esc(S.store.name || '') + '"></div></div>' +
    '<div class="row"><button class="btn primary" data-act="tcreate">Create trip</button><button class="btn" data-nav="/">Cancel</button></div></div>';
}
async function createTrip() {
  var title = ($('#tn-title') || {}).value || '', name = ($('#tn-name') || {}).value || '';
  if (!title.trim()) return toast('Give the trip a name');
  if (!name.trim()) return toast('Enter your name');
  try {
    var r = await api('POST', '/api/trips', { title: title, name: name });
    S.store.trips[r.id] = { token: r.token, memberId: r.memberId, title: title.trim() }; S.store.name = name.trim(); saveStore();
    toast('Trip created. Send the link to everyone going.'); nav('/t/' + r.id);
  } catch (e) { toast(e.message); }
}

function splitText(t, e) {
  if (e.mode === 'items') { var n = Object.keys(e.picks || {}).length; return 'Split by items · ' + (n ? n + (n === 1 ? ' person has' : ' people have') + ' picked' : 'nobody has picked yet'); }
  var names = e.among.map(function (id) { return tnm(t, id); });
  if (e.among.length === t.members.length && e.mode === 'equal') return 'Split equally among everyone';
  return (e.mode === 'exact' ? 'Split by amount: ' : 'Split equally: ') + names.join(', ');
}
function viewTrip() {
  if (S.err) return topbar() + '<div class="card empty"><h3>' + esc(S.err) + '</h3><button class="btn primary" data-nav="/">Back to your bills</button></div>';
  var t = S.trip;
  if (!t) return topbar() + '<div class="card empty"><h3>Opening trip…</h3></div>';
  var meId = tmyId(t), me = meId ? tmem(t, meId) : null, bal = Settle.balances(t), total = Settle.total(t);
  var h = topbar() + '<button class="btn ghost" data-nav="/">← Your bills</button>';
  h += '<div class="row between" style="align-items:flex-start"><div class="grow"><h2>' + esc(t.title) + '</h2><div class="small muted">Trip · ' + t.members.length + (t.members.length === 1 ? ' person · ' : ' people · ') + t.expenses.length + ' expense' + (t.expenses.length === 1 ? '' : 's') + '</div></div><div class="mono" style="font-size:20px">' + fmt(total) + '</div></div>';

  if (!me) {
    var open = t.members.filter(function (m) { return !m.claimed; });
    h += '<div class="card"><h3>Join this trip</h3><p class="muted">Join to add what you paid and see what you owe.</p>';
    if (open.length) h += '<div><div class="small muted" style="margin-bottom:6px">Are you one of these?</div><div class="chips">' + open.map(function (m) { return '<button class="btn small" data-act="tclaim" data-uid="' + m.id + '">I am ' + esc(m.name) + '</button>'; }).join('') + '</div></div>';
    h += '<div class="field"><label for="tjname">' + (open.length ? 'Or enter your name' : 'Your name') + '</label><input type="text" id="tjname" maxlength="40" placeholder="e.g. Wei Jie" value="' + esc(S.store.name || '') + '"></div><div><button class="btn primary" data-act="tjoin">Join the trip</button></div>' +
      '<p class="small muted">Already in this trip on another phone? Open it with your private link instead of picking a name.</p></div>';
    return h + tripExpensesHtml(t, null);
  }

  h += '<p class="small muted">You are <b>' + esc(me.name) + '</b> in this trip.' + (me.isOwner ? '' : ' <button class="btn small" data-act="tleave">Not ' + esc(me.name) + '? Switch person</button>') + '</p>';
  h += '<div class="card"><h3>Invite everyone</h3><div class="linkbox"><input type="text" id="tsharelink" readonly aria-label="Trip link" value="' + esc(tripUrl(t)) + '"><button class="btn" data-act="tcopylink">Copy link</button><a class="btn primary" href="https://wa.me/?text=' + encodeURIComponent('Join "' + t.title + '" on Bei Cin Lah to add what you paid and see who owes whom: ' + tripUrl(t)) + '" target="_blank" rel="noopener" style="text-decoration:none">WhatsApp</a></div><p class="small muted">Everyone opens the link and joins with their name. No sign-up.</p></div>';

  // Your position
  var my = bal[meId] || { net: 0, paid: 0, owes: 0 };
  h += '<div class="tiles"><div class="tile"><div class="k">' + (my.net > 0 ? 'You get back' : my.net < 0 ? 'You owe' : 'You are') + '</div><div class="v">' + (my.net ? fmt(Math.abs(my.net)) : 'Settled') + '</div></div><div class="tile"><div class="k">You paid · your share</div><div class="v" style="font-size:18px">' + fmt(my.paid) + ' · ' + fmt(my.owes) + '</div></div></div>';
  if (!me.hasQr) h += '<div class="alert"><span>Add your DuitNow QR so others can pay you when settling up.</span><button class="btn small primary" data-act="tqr">Add my DuitNow QR</button></div>';
  h += notifyHtml(t, 'someone pays you');
  h += tripSettleHtml(t, meId);
  h += tripExpensesHtml(t, me);
  h += tripPeopleHtml(t, me, bal);
  h += '<div class="row" style="flex-wrap:wrap"><button class="btn small" data-act="tcopyprivate">Copy my private link (keep private)</button>' + (me.hasQr ? '<button class="btn small" data-act="tqr">Change my DuitNow QR</button>' : '') + (me.isOwner ? '<button class="btn small" data-act="tdelete" style="color:var(--bad)">Delete trip</button>' : '') + '</div>';
  return h;
}
function tripSettleHtml(t, meId) {
  var tr = Settle.transfers(Settle.balances(t)), pending = t.payments.filter(function (p) { return p.status === 'sent'; }), done = t.payments.filter(function (p) { return p.status === 'paid'; });
  var h = '<div class="card"><h3>Settle up</h3>';
  if (!t.expenses.length) return h + '<p class="muted">Add expenses below. Who pays whom shows up here.</p></div>';
  if (!tr.length && !pending.length) h += '<p style="color:var(--good);font-weight:700">Everyone is settled up.</p>';
  tr.forEach(function (x) {
    var mine = x.from === meId, toMe = x.to === meId;
    h += '<div class="person">' + tav(t, x.from) + '<div class="grow"><div><b>' + esc(mine ? 'You' : tnm(t, x.from)) + '</b> ' + (mine ? 'pay' : 'pays') + ' <b>' + esc(toMe ? 'you' : tnm(t, x.to)) + '</b></div></div><span class="mono">' + fmt(x.amount) + '</span>' +
      (mine ? '<div class="acts" style="width:100%;padding-left:38px"><button class="btn small primary" data-act="tpay" data-uid="' + x.to + '" data-amt="' + x.amount + '">Pay ' + esc(tnm(t, x.to)) + '</button></div>' : '') +
      (toMe ? '<div class="acts" style="width:100%;padding-left:38px"><button class="btn small" data-act="tgotcash" data-uid="' + x.from + '" data-amt="' + x.amount + '">Mark received (cash)</button></div>' : '') + '</div>';
    if (mine && S.payTo === x.to) {
      var to = tmem(t, x.to);
      h += '<div class="pay" style="margin:6px 0 12px">' + (to && to.hasQr ? '<div><img class="qr" src="/api/trips/' + t.id + '/img/qr/' + x.to + '?v=' + (to.qrAt || 0) + '" alt="DuitNow QR for ' + esc(tnm(t, x.to)) + '" data-act="tzoomqr" data-uid="' + x.to + '" style="cursor:zoom-in"></div>' : '') +
        '<div class="grow" style="display:flex;flex-direction:column;gap:8px"><p><b>Pay ' + esc(tnm(t, x.to)) + ' ' + fmt(x.amount) + '</b></p>' +
        (to && to.hasQr ? '<p class="small muted">Save the QR picture, open your banking app, choose Scan QR, then upload it. Transfer the exact amount.</p>' : '<p class="small muted">' + esc(tnm(t, x.to)) + ' has not added a DuitNow QR yet. Ask them for their account, or pay in cash.</p>') +
        '<div class="row" style="flex-wrap:wrap;gap:6px"><button class="btn small primary" data-act="tslip">I have paid, upload slip</button><button class="btn small" data-act="tpaidcash">I paid in cash</button><button class="btn small" data-act="tpayclose">Close</button></div></div></div>';
    }
  });
  if (pending.length) {
    h += '<div class="small muted" style="margin-top:10px">Waiting to be confirmed</div>';
    pending.forEach(function (p) {
      var toMe = p.to === meId, fromMe = p.from === meId, acts = '';
      if (toMe) acts = '<button class="btn small primary" data-act="tconfirm" data-pid="' + p.id + '">Confirm received</button>' + (p.hasSlip ? '<button class="btn small" data-act="tviewslip" data-pid="' + p.id + '">View slip</button>' : '') + '<button class="btn small" data-act="treject" data-pid="' + p.id + '">Not received</button>';
      else if (fromMe) acts = (p.hasSlip ? '<button class="btn small" data-act="tviewslip" data-pid="' + p.id + '">View my slip</button>' : '') + '<button class="btn small" data-act="tcancel" data-pid="' + p.id + '">Cancel</button>';
      h += '<div class="person">' + tav(t, p.from) + '<div class="grow"><div><b>' + esc(fromMe ? 'You' : tnm(t, p.from)) + '</b> sent <b>' + esc(toMe ? 'you' : tnm(t, p.to)) + '</b> ' + fmt(p.amount) + '</div><div class="small muted">' + (p.hasSlip ? 'Slip sent ' : 'Marked as paid ') + ago(p.at) + '</div></div><span class="pill sent">Waiting</span>' + (acts ? '<div class="acts" style="width:100%;padding-left:38px">' + acts + '</div>' : '') + '</div>';
    });
  }
  if (done.length) h += '<details style="margin-top:10px"><summary class="small muted">Payments done (' + done.length + ')</summary>' + done.map(function (p) {
    return '<div class="small" style="padding:4px 0">✓ ' + esc(tnm(t, p.from)) + ' paid ' + esc(tnm(t, p.to)) + ' <span class="mono">' + fmt(p.amount) + '</span>' + (p.hasSlip && (p.from === meId || p.to === meId) ? ' <button class="btn small" data-act="tviewslip" data-pid="' + p.id + '">Slip</button>' : '') + (p.to === meId ? ' <button class="btn small" data-act="treject" data-pid="' + p.id + '">Undo</button>' : '') + '</div>';
  }).join('') + '</details>';
  return h + '</div>';
}
function tripExpensesHtml(t, me) {
  var h = '<div class="card"><div class="row between"><h3>Expenses</h3>' + (me ? '<button class="btn small primary" data-nav="/t/' + t.id + '/add">Add expense</button>' : '') + '</div>';
  if (!t.expenses.length) return h + '<p class="muted">Nothing added yet.' + (me ? ' Whoever pays for something adds it here: hotel, meals, petrol, tickets…' : '') + '</p></div>';
  t.expenses.slice().reverse().forEach(function (e) {
    var sh = Settle.shares(e), mine = me ? sh[me.id] || 0 : 0, canEdit = me && (me.isOwner || e.addedBy === me.id);
    h += '<div class="person">' + tav(t, e.paidBy) + '<div class="grow"><div><b>' + esc(e.title) + '</b></div><div class="small muted">' + esc(e.date || '') + ' · paid by ' + esc(me && e.paidBy === me.id ? 'you' : tnm(t, e.paidBy)) + '</div><div class="small muted">' + esc(splitText(t, e)) + (mine ? ' · your share <span class="mono">' + fmt(mine) + '</span>' : '') + '</div></div><span class="mono">' + fmt(e.amount) + '</span>' +
      ((e.hasReceipt || canEdit || e.mode === 'items') ? '<div class="acts" style="width:100%;padding-left:38px">' + (e.mode === 'items' && me ? '<button class="btn small primary" data-nav="/t/' + t.id + '/x/' + e.id + '">' + (mine ? 'Change what you ate' : 'Choose what you ate') + '</button>' : '') + (e.hasReceipt ? '<button class="btn small" data-act="treceipt" data-eid="' + e.id + '">Receipt</button>' : '') + (canEdit ? '<button class="btn small" data-nav="/t/' + t.id + '/e/' + e.id + '">Edit</button>' : '') + '</div>' : '') + '</div>';
  });
  return h + '</div>';
}
function tripPeopleHtml(t, me, bal) {
  var h = '<div class="card"><h3>People</h3>';
  t.members.forEach(function (m) {
    var n = (bal[m.id] || {}).net || 0, acts = '';
    if (me.isOwner && !m.isOwner) acts = (m.claimed ? '<button class="btn small" data-act="treset" data-uid="' + m.id + '">Reset link</button>' : '') + '<button class="btn small" data-act="tremove" data-uid="' + m.id + '" style="color:var(--bad)">Remove</button>';
    h += '<div class="person">' + tav(t, m.id) + '<div class="grow"><div><b>' + esc(m.name) + (m.id === me.id ? ' (you)' : '') + '</b></div><div class="small muted">' + (n > 0 ? 'Gets back ' + fmt(n) : n < 0 ? 'Owes ' + fmt(-n) : 'Settled') + (m.claimed ? '' : ' · not joined yet') + (m.hasQr ? ' · has QR' : '') + '</div></div>' + (acts ? '<div class="acts" style="width:100%;padding-left:38px">' + acts + '</div>' : '') + '</div>';
  });
  return h + '<div class="row"><input type="text" id="tgname" aria-label="Name" placeholder="Add someone by name" maxlength="40"><button class="btn" data-act="taddperson">Add</button></div><p class="small muted">Add people who have not joined yet, so you can include them in expenses. They can claim their name from the trip link.</p></div>';
}

// The add / edit expense form.
function newExpense(t) {
  var me = tmyId(t), among = {};
  t.members.forEach(function (m) { among[m.id] = true; });
  return { tripId: t.id, eid: null, title: '', date: new Date().toISOString().slice(0, 10), paidBy: me, amount: '', mode: 'equal', among: among, shares: {},
    items: [{ name: '', qty: '1', price: '' }], service: '', sst: '', rounding: '', receipt: '', scanNote: '', scanning: false };
}
function expenseFrom(t, e) {
  var among = {}, shares = {};
  e.among.forEach(function (id) { among[id] = true; if (e.mode === 'exact') shares[id] = fixed(e.shares[id] || 0); });
  if (e.mode === 'items') t.members.forEach(function (m) { among[m.id] = true; });
  var items = e.mode === 'items' ? e.items.map(function (i) { return { id: i.id, name: i.name, qty: String(i.qty), price: fixed(Math.round(i.price / i.qty)), line: i.price }; }) : [{ name: '', qty: '1', price: '' }];
  return { tripId: t.id, eid: e.id, title: e.title, date: e.date, paidBy: e.paidBy, amount: fixed(e.amount), mode: e.mode, among: among, shares: shares,
    items: items, service: e.service ? fixed(e.service) : '', sst: e.sst ? fixed(e.sst) : '', rounding: e.rounding ? fixed(e.rounding) : '', receipt: '', hadReceipt: e.hasReceipt, scanNote: '', scanning: false };
}
// Split by items: the dishes plus charges are the total.
function edTotal(d) {
  if (d.mode !== 'items') return toC(d.amount);
  var s = 0; d.items.forEach(function (i) { s += lineCents(i); });
  return s + toC(d.service) + toC(d.sst) + toC(d.rounding);
}
function edAmong(d) { return Object.keys(d.among).filter(function (id) { return d.among[id]; }); }
function edRemain(d) { var s = 0; edAmong(d).forEach(function (id) { s += toC(d.shares[id]); }); return toC(d.amount) - s; }
function remainHtml(d) {
  if (d.mode !== 'exact') { var n = edAmong(d).length; return n ? fmt(Math.floor(toC(d.amount) / n)) + ' each (' + n + (n === 1 ? ' person)' : ' people)') : 'Choose who shares it'; }
  var r = edRemain(d);
  return r === 0 ? '<span style="color:var(--good)">Adds up to the total</span>' : '<span style="color:var(--warn)">' + fmt(Math.abs(r)) + (r > 0 ? ' still to assign' : ' too much') + '</span>';
}
function viewExpense() {
  var t = S.trip, d = S.edraft;
  if (!t || !d) return topbar() + '<div class="card empty"><h3>Opening trip…</h3></div>';
  var h = topbar() + '<button class="btn ghost" data-nav="/t/' + t.id + '">← ' + esc(t.title) + '</button><h2>' + (d.eid ? 'Edit expense' : 'Add expense') + '</h2>';
  h += '<div class="card"><h3>Receipt (optional)</h3><div class="drop"><div class="row">' + (d.receipt ? '<img class="thumb" src="' + d.receipt + '" alt="Receipt photo">' : '') + '<div><b>' + (d.receipt ? 'Receipt attached' : d.hadReceipt ? 'Receipt already attached' : 'Add a photo of the receipt') + '</b><div class="small muted">The dishes, total, shop name and date are read for you. Everyone in the trip can view the photo.</div></div></div><button class="btn" data-act="epick"' + (d.scanning ? ' disabled' : '') + '>' + (d.scanning ? 'Reading…' : d.receipt ? 'Change photo' : 'Choose photo') + '</button></div>' + (d.scanNote ? '<p class="small" style="color:var(--warn)">' + esc(d.scanNote) + '</p>' : '') + '</div>';
  h += '<div class="card"><h3>What and who paid</h3><div class="two"><div class="field"><label for="e-title">What was it</label><input type="text" id="e-title" data-ef="title" maxlength="80" value="' + esc(d.title) + '" placeholder="e.g. Hotel, dinner, petrol"></div><div class="field"><label for="e-date">Date</label><input type="date" id="e-date" data-ef="date" value="' + esc(d.date) + '"></div>' +
    '<div class="field"><label for="e-amount">Total (RM)</label><input type="number" step="0.01" min="0" inputmode="decimal" id="e-amount" data-ef="amount" value="' + esc(d.mode === 'items' ? fixed(edTotal(d)) : d.amount) + '" placeholder="0.00"' + (d.mode === 'items' ? ' readonly title="Worked out from the items below"' : '') + '></div>' +
    '<div class="field"><label for="e-paid">Paid by</label><select id="e-paid" data-ef="paidBy">' + t.members.map(function (m) { return '<option value="' + m.id + '"' + (m.id === d.paidBy ? ' selected' : '') + '>' + esc(m.name) + (m.id === tmyId(t) ? ' (you)' : '') + '</option>'; }).join('') + '</select></div></div></div>';
  var modeBtn = function (m, label) { return '<button class="btn small' + (d.mode === m ? ' primary' : '') + '" data-act="emode" data-mode="' + m + '">' + label + '</button>'; };
  h += '<div class="card"><h3>Split</h3><div class="chips">' + modeBtn('items', 'By items') + modeBtn('equal', 'Equally') + modeBtn('exact', 'By exact amounts') + '</div>';
  if (d.mode === 'items') {
    // The dishes (from the receipt, or typed), then charges. After saving, everyone ticks what they ate.
    h += '<div class="items"><div class="irow h"><span>Item</span><span>Qty</span><span>Each (RM)</span><span style="text-align:right">Total</span><span></span></div>';
    d.items.forEach(function (it, i) { h += '<div class="irow"><input type="text" aria-label="Item name" data-ei="' + i + '" data-ek="name" value="' + esc(it.name) + '" placeholder="Item"><input type="number" min="1" aria-label="Quantity" data-ei="' + i + '" data-ek="qty" value="' + esc(it.qty) + '"><input type="number" step="0.01" min="0" inputmode="decimal" aria-label="Price of one" data-ei="' + i + '" data-ek="price" value="' + esc(it.price) + '" placeholder="0.00"><span class="mono small" data-eline="' + i + '">' + fmt(lineCents(it)) + '</span><button class="x" data-act="ermi" data-i="' + i + '" aria-label="Remove item">×</button></div>'; });
    h += '</div><div><button class="btn small" data-act="eaddi">Add item</button></div>';
    h += '<div class="two"><div class="field"><label for="e-svc">Service charge (RM)</label><input type="number" step="0.01" id="e-svc" data-ef="service" value="' + esc(d.service) + '" placeholder="0.00"></div><div class="field"><label for="e-sst">SST (RM)</label><input type="number" step="0.01" id="e-sst" data-ef="sst" value="' + esc(d.sst) + '" placeholder="0.00"></div><div class="field"><label for="e-rnd">Rounding (RM)</label><input type="number" step="0.01" id="e-rnd" data-ef="rounding" value="' + esc(d.rounding) + '" placeholder="0.00"></div></div>';
    h += '<div class="chips"><button class="btn small" data-act="esvc10">Service 10%</button><button class="btn small" data-act="esst6">SST 6%</button><button class="btn small" data-act="esst8">SST 8%</button></div>';
    h += '<p class="small" id="eTotal"><b>Total ' + fmt(edTotal(d)) + '</b></p><p class="small muted">After saving, everyone in the trip taps the dishes they ate. Service charge and SST follow each person\'s dishes, and dishes nobody picks stay with whoever paid.</p></div>';
  } else {
  h += '<div class="chips"><button class="btn small" data-act="eall">Everyone</button><button class="btn small" data-act="enone">No one</button></div>';
  h += '<div class="receipt">';
  t.members.forEach(function (m) {
    var on = !!d.among[m.id];
    h += '<div class="row" style="gap:8px;align-items:center"><button type="button" class="ln' + (on ? ' on' : '') + '" data-act="etoggle" data-uid="' + m.id + '" aria-pressed="' + on + '" style="flex:1"><span class="chk">' + (on ? '✓' : '') + '</span><span class="nm"><b>' + esc(m.name) + '</b></span></button>' +
      (on && d.mode === 'exact' ? '<input type="number" step="0.01" min="0" inputmode="decimal" aria-label="Amount for ' + esc(m.name) + '" data-share="' + m.id + '" value="' + esc(d.shares[m.id] || '') + '" placeholder="0.00" style="width:110px;flex:none">' : '') + '</div>';
  });
  h += '</div>';
  h += '<p class="small" id="eRemain">' + remainHtml(d) + '</p></div>';
  }
  h += '<div class="row"><button class="btn primary" data-act="esave">' + (d.eid ? 'Save changes' : 'Add expense') + '</button><button class="btn" data-nav="/t/' + t.id + '">Cancel</button>' + (d.eid ? '<button class="btn" data-act="edelete" style="color:var(--bad)">Delete</button>' : '') + '</div>';
  return h;
}
async function startExpense(id, eid) {
  if (!S.trip || S.trip.id !== id) { try { setTrip(await api('GET', '/api/trips/' + id, null, ttok(id))); } catch (e) { toast('Could not open this trip'); nav('/'); return; } }
  var t = S.trip, me = tmyId(t);
  if (!me) { toast('Join the trip first'); nav('/t/' + id); return; }
  if (eid) {
    var e = t.expenses.filter(function (x) { return x.id === eid; })[0];
    if (!e) { toast('That expense was deleted'); nav('/t/' + id); return; }
    if (!(tmem(t, me).isOwner || e.addedBy === me)) { toast('Only whoever added it, or who made the trip, can edit it'); nav('/t/' + id); return; }
    S.edraft = expenseFrom(t, e);
  } else S.edraft = newExpense(t);
  render();
}
async function saveExpense() {
  var d = S.edraft, among = edAmong(d), shares = {}, body;
  if (!d.title.trim()) return toast('Say what the expense was');
  if (d.mode === 'items') {
    var items = d.items.filter(function (i) { return lineCents(i) > 0; }).map(function (i) { return { id: i.id, name: i.name, qty: Math.max(1, parseInt(i.qty, 10) || 1), price: lineCents(i) }; });
    if (!items.length) return toast('Add at least one item with a price');
    body = { title: d.title, date: d.date, paidBy: d.paidBy, mode: 'items', items: items, service: toC(d.service), sst: toC(d.sst), rounding: toC(d.rounding), receipt: d.receipt ? b64(d.receipt) : undefined };
  } else {
    if (toC(d.amount) <= 0) return toast('Enter the total');
    if (!among.length) return toast('Choose who shares it');
    if (d.mode === 'exact') { if (edRemain(d) !== 0) return toast('The amounts must add up to the total'); among.forEach(function (id) { shares[id] = toC(d.shares[id]); }); }
    body = { title: d.title, date: d.date, paidBy: d.paidBy, amount: toC(d.amount), mode: d.mode, among: among, shares: shares, receipt: d.receipt ? b64(d.receipt) : undefined };
  }
  try {
    var j = await api(d.eid ? 'PUT' : 'POST', '/api/trips/' + d.tripId + '/expenses' + (d.eid ? '/' + d.eid : ''), body, ttok(d.tripId));
    setTrip(j); var id = d.tripId; S.edraft = null; toast(d.eid ? 'Expense updated' : 'Expense added');
    // A new expense split by items opens straight on "choose what you ate".
    var made = j.expenseId || d.eid;
    nav(d.mode === 'items' && made ? '/t/' + id + '/x/' + made : '/t/' + id);
  } catch (e) { toast(e.message); }
}
async function scanExpense(f) {
  var d = S.edraft; d.scanning = true; d.scanNote = ''; render();
  try {
    var r = await readOnPhone(f), sum = r.service + r.sst + r.rounding;
    r.items.forEach(function (i) { sum += i.line; });
    var total = r.total || sum;
    if (!total) throw new Error('empty');
    d.amount = fixed(total);
    if (!d.title && r.merchant) d.title = r.merchant;
    if (r.date) d.date = r.date;
    if (r.items.length) {
      // Dishes found: split by items, so everyone can pick what they ate.
      d.mode = 'items';
      d.items = r.items.map(function (i) { return { name: i.name, qty: String(i.qty), price: fixed(i.each), line: i.line }; });
      d.service = r.service ? fixed(r.service) : ''; d.sst = r.sst ? fixed(r.sst) : ''; d.rounding = r.rounding ? fixed(r.rounding) : '';
      var gap = r.total ? r.total - edTotal(d) : 0;
      d.scanNote = 'Read ' + r.items.length + ' item' + (r.items.length > 1 ? 's' : '') + (r.merchant ? ' at ' + r.merchant : '') + (Math.abs(gap) > 1 ? '. They come to ' + fmt(edTotal(d)) + ' but the receipt says ' + fmt(r.total) + ', so check the items.' : ', matching the total of ' + fmt(edTotal(d)) + '.') + ' Please check them against the receipt.';
    } else d.scanNote = 'Read a total of ' + fmt(total) + (r.merchant ? ' at ' + r.merchant : '') + '. Please check it against the receipt.';
  } catch (e) { d.scanNote = 'Could not read the total. Type it in.'; }
  d.scanning = false; render();
}
function joinTrip(body) {
  if (body.memberId == null && !String(body.name || '').trim()) return toast('Enter your name');
  api('POST', '/api/trips/' + S.tripId + '/join', body).then(function (j) {
    S.store.trips[S.tripId] = { token: j.token, memberId: j.memberId, title: j.trip.title };
    var m = tmem(j.trip, j.memberId); if (m) S.store.name = m.name; saveStore(); S.trip = j.trip; render(); window.scrollTo(0, 0);
  }).catch(function (e) { toast(e.message); refreshTrip(); });
}
// Every trip action: the button's data-act starts with "t" or "e".
function tripAction(act, el) {
  var t = S.trip, d = S.edraft, uid = el.getAttribute('data-uid'), pid = el.getAttribute('data-pid'), done = function (msg) { return function (j) { setTrip(j); render(); if (msg) toast(msg); }; }, fail = function (x) { toast(x.message || 'That did not save'); };
  switch (act) {
    case 'tcreate': createTrip(); return true;
    case 'tjoin': joinTrip({ name: ($('#tjname') || {}).value }); return true;
    case 'tclaim': joinTrip({ memberId: uid }); return true;
    case 'tleave': { var was = (tmem(t, tmyId(t)) || {}).name, tid = t.id; tapi('POST', '/leave').then(function (j) { delete S.store.trips[tid]; if (S.store.name === was) S.store.name = ''; saveStore(); S.trip = j.trip; render(); toast('Done. Pick your own name, or join with it.'); }).catch(fail); return true; }
    case 'tcopylink': copyText(tripUrl(t)); return true;
    case 'tcopyprivate': copyText(tripUrl(t) + '#k=' + ttok(t.id)).then(function () { toast('Private link copied. Open it on another phone to use the trip as you.'); }); return true;
    case 'tqr': $('#fileQR').click(); return true;
    case 'tzoomqr': S.modal = { title: 'DuitNow QR for ' + tnm(t, uid), src: '/api/trips/' + t.id + '/img/qr/' + uid + '?v=' + ((tmem(t, uid) || {}).qrAt || 0) }; paintModal(); return true;
    case 'treceipt': S.modal = { title: 'Receipt', src: '/api/trips/' + t.id + '/img/receipt/' + el.getAttribute('data-eid') }; paintModal(); return true;
    case 'tpay': S.payTo = S.payTo === uid ? null : uid; S.payAmt = +el.getAttribute('data-amt'); render(); return true;
    case 'tpayclose': S.payTo = null; render(); return true;
    case 'tslip': $('#fileSlip').click(); return true;
    case 'tpaidcash': { var to = S.payTo; tapi('POST', '/payments', { to: to, amount: S.payAmt }).then(function (j) { S.payTo = null; done('Marked as paid. ' + tnm(j.trip, to) + ' will confirm.')(j); }).catch(fail); return true; }
    case 'tgotcash': tapi('POST', '/payments/received', { from: uid, amount: +el.getAttribute('data-amt') }).then(done('Recorded as received')).catch(fail); return true;
    case 'tconfirm': tapi('POST', '/payments/' + pid, { action: 'confirm' }).then(done('Payment confirmed')).catch(fail); return true;
    case 'treject': tapi('POST', '/payments/' + pid, { action: 'reject' }).then(done('Payment removed')).catch(fail); return true;
    case 'tcancel': tapi('POST', '/payments/' + pid, { action: 'cancel' }).then(done('Payment cancelled')).catch(fail); return true;
    case 'tviewslip':
      fetch('/api/trips/' + t.id + '/img/slip/' + pid, { headers: { 'x-token': ttok(t.id) } }).then(function (r) { if (!r.ok) throw new Error(); return r.blob(); })
        .then(function (bl) { S.modal = { title: 'Payment slip', src: URL.createObjectURL(bl) }; paintModal(); }).catch(function () { toast('Could not load the slip'); });
      return true;
    case 'taddperson': { var inp = $('#tgname'), name = inp ? inp.value.trim() : ''; if (!name) { toast('Type a name first'); return true; } tapi('POST', '/members', { name: name }).then(done(name + ' added')).catch(fail); return true; }
    case 'treset':
      if (S.confirmReset !== uid) { S.confirmReset = uid; toast('Tap Reset link again: ' + tnm(t, uid) + ' will need to pick their name again'); setTimeout(function () { S.confirmReset = null; }, 4000); return true; }
      S.confirmReset = null; tapi('POST', '/members/' + uid + '/reset').then(done(tnm(t, uid) + ' can pick their name again')).catch(fail); return true;
    case 'tremove': tapi('DELETE', '/members/' + uid).then(done('Removed')).catch(fail); return true;
    case 'tdelete':
      if (S.confirmDel !== t.id) { S.confirmDel = t.id; toast('Tap Delete trip again to confirm'); setTimeout(function () { S.confirmDel = null; }, 4000); return true; }
      S.confirmDel = null; tapi('DELETE', '').then(function () { delete S.store.trips[t.id]; saveStore(); nav('/'); }).catch(fail); return true;
    case 'epick': $('#fileReceipt').click(); return true;
    case 'emode': if (d.mode === 'items' && edItemsSum(d)) d.amount = fixed(edTotal(d)); d.mode = el.getAttribute('data-mode'); render(); return true;
    case 'eall': t.members.forEach(function (m) { d.among[m.id] = true; }); render(); return true;
    case 'etoggle': d.among[uid] = !d.among[uid]; render(); return true;
    case 'enone': d.among = {}; render(); return true;
    case 'esave': saveExpense(); return true;
    case 'eaddi': d.items.push({ name: '', qty: '1', price: '' }); render(); return true;
    case 'ermi': if (d.items.length > 1) { d.items.splice(+el.getAttribute('data-i'), 1); render(); } return true;
    case 'esvc10': d.service = fixed(Math.round(edItemsSum(d) * 0.10)); render(); return true;
    case 'esst6': case 'esst8': d.sst = fixed(Math.round((edItemsSum(d) + toC(d.service)) * (act === 'esst6' ? 0.06 : 0.08))); render(); return true;
    case 'xas': S.pickAs = uid; render(); return true;
    case 'xpick': pickDish(el.getAttribute('data-id')); return true;
    case 'edelete':
      if (S.confirmDel !== d.eid) { S.confirmDel = d.eid; toast('Tap Delete again to confirm'); setTimeout(function () { S.confirmDel = null; }, 4000); return true; }
      S.confirmDel = null; api('DELETE', '/api/trips/' + d.tripId + '/expenses/' + d.eid, null, ttok(d.tripId)).then(function (j) { setTrip(j); var id = d.tripId; S.edraft = null; toast('Expense deleted'); nav('/t/' + id); }).catch(fail); return true;
  }
  return false;
}
function edItemsSum(d) { var s = 0; d.items.forEach(function (i) { s += lineCents(i); }); return s; }
function expenseInput(t) {
  var d = S.edraft; if (!d) return false;
  if (t.hasAttribute('data-ei')) {
    var ix = +t.getAttribute('data-ei'), it = d.items[ix], k = t.getAttribute('data-ek'); it[k] = t.value;
    if (k !== 'name') delete it.line;
    var ce = document.querySelector('[data-eline="' + ix + '"]'); if (ce) ce.textContent = fmt(lineCents(it));
  } else if (t.hasAttribute('data-ef')) d[t.getAttribute('data-ef')] = t.value;
  else if (t.hasAttribute('data-share')) d.shares[t.getAttribute('data-share')] = t.value;
  else if (t.hasAttribute('data-among')) { d.among[t.getAttribute('data-among')] = t.checked; render(); return true; }
  else return false;
  var el = $('#eRemain'); if (el) el.innerHTML = remainHtml(d);
  if (d.mode === 'items') { var tt = $('#eTotal'), am = $('#e-amount'); if (tt) tt.innerHTML = '<b>Total ' + fmt(edTotal(d)) + '</b>'; if (am) am.value = fixed(edTotal(d)); }
  return true;
}

// "Choose what you ate" on an expense split by items: like a bill's dish list. Whoever added or paid for it,
// or made the trip, can also tick for others (for friends who have not opened the link).
function pickExpense() { var t = S.trip; return t && t.expenses.filter(function (x) { return x.id === S.pickEid; })[0]; }
function canPickFor(t, me, e) { return me && (me.isOwner || e.addedBy === me.id || e.paidBy === me.id); }
function viewPicks() {
  var t = S.trip, e = pickExpense();
  if (!t) return topbar() + '<div class="card empty"><h3>Opening trip…</h3></div>';
  if (!e || e.mode !== 'items') return topbar() + '<div class="card empty"><h3>This expense is not split by items.</h3><button class="btn primary" data-nav="/t/' + t.id + '">Back to the trip</button></div>';
  var meId = tmyId(t), me = meId ? tmem(t, meId) : null;
  if (!me) return topbar() + '<div class="card empty"><h3>Join the trip first</h3><button class="btn primary" data-nav="/t/' + t.id + '">Open the trip</button></div>';
  var c = Settle.itemsCalc(e), others = canPickFor(t, me, e), ac = others && S.pickAs && tmem(t, S.pickAs) ? S.pickAs : meId;
  var picks = (e.picks && e.picks[ac]) || [], my = c.per[ac];
  var h = topbar() + '<button class="btn ghost" data-nav="/t/' + t.id + '">← ' + esc(t.title) + '</button>';
  h += '<div class="row between" style="align-items:flex-start"><div class="grow"><h2>' + esc(e.title) + '</h2><div class="small muted">' + esc(e.date || '') + ' · paid by ' + esc(e.paidBy === meId ? 'you' : tnm(t, e.paidBy)) + '</div></div><div class="mono" style="font-size:20px">' + fmt(e.amount) + '</div></div>';
  if (others) h += '<div class="card"><h3>Picking for</h3><div class="chips">' + t.members.map(function (m) { return '<button class="btn small' + (m.id === ac ? ' primary' : '') + '" data-act="xas" data-uid="' + m.id + '">' + esc(m.id === meId ? 'You' : m.name) + '</button>'; }).join('') + '</div><p class="small muted">Tap a name, then tap the dishes that person ate. A dish picked by 2 or more people is split equally.</p></div>';
  h += '<div class="card"><div class="row between"><h3>' + (ac === meId ? 'Tap what you ate' : 'Tap what ' + esc(tnm(t, ac)) + ' ate') + '</h3>' + (e.hasReceipt ? '<button class="btn small" data-act="treceipt" data-eid="' + e.id + '">View receipt</button>' : '') + '</div><div class="receipt">';
  e.items.forEach(function (it) {
    var who = Object.keys(e.picks || {}).filter(function (id) { return e.picks[id].indexOf(it.id) > -1; });
    var on = picks.indexOf(it.id) > -1, part = '';
    if (on && my) { var l = my.lines.filter(function (x) { return x.id === it.id; })[0]; if (l && l.n > 1) part = '<span class="sub">part ' + fmt(l.cents) + ' (÷' + l.n + ')</span>'; }
    var unit = it.qty > 1 ? '<span class="sub">' + it.qty + ' × ' + fmt(Math.round(it.price / it.qty)) + '</span>' : '';
    h += '<button class="ln' + (on ? ' on' : '') + '" data-act="xpick" data-id="' + it.id + '" aria-pressed="' + on + '"><span class="chk">' + (on ? '✓' : '') + '</span><span class="nm">' + esc(it.name) + unit + '</span><span class="avs">' + who.slice(0, 4).map(function (id) { return tav(t, id); }).join('') + '</span><span class="pr">' + fmt(it.price) + part + '</span></button>';
  });
  h += receiptTotals(e, c) + '</div>';
  if (c.unclaimed.sub > 0) h += '<p class="small muted">' + fmt(c.unclaimed.total) + ' of dishes nobody picked stays with ' + esc(tnm(t, e.paidBy)) + ', who paid.</p>';
  h += '</div>';
  if (my) {
    h += '<div class="card share"><h3>' + (ac === meId ? 'Your share' : esc(tnm(t, ac)) + '\'s share') + '</h3><div class="receipt">';
    my.lines.forEach(function (l) { h += '<div class="chg" style="color:var(--ink)"><span>' + esc(l.name) + (l.n > 1 ? ' (÷' + l.n + ')' : '') + '</span><span>' + fmt(l.cents) + '</span></div>'; });
    if (my.svc) h += '<div class="chg"><span>Service charge</span><span>' + fmt(my.svc) + '</span></div>';
    if (my.sst) h += '<div class="chg"><span>SST</span><span>' + fmt(my.sst) + '</span></div>';
    if (my.rnd) h += '<div class="chg"><span>Rounding</span><span>' + fmt(my.rnd) + '</span></div>';
    h += '<div class="chg tot"><span>Total</span><span class="big" style="font-size:22px">' + fmt(my.total) + '</span></div></div><p class="small muted">This is added to the trip. You pay it when settling up at the end, not now.</p></div>';
  } else if (ac === meId) h += '<div class="card"><p class="muted">Tap the dishes you ate above. Your share, with service charge and SST, appears here and is added to the trip.</p></div>';
  h += '<div class="row" style="flex-wrap:wrap"><button class="btn primary" data-nav="/t/' + t.id + '">Done</button>' + (me.isOwner || e.addedBy === meId ? '<button class="btn small" data-nav="/t/' + t.id + '/e/' + e.id + '">Edit items</button>' : '') + '</div>';
  return h;
}
function pickDish(itemId) {
  var t = S.trip, e = pickExpense(), meId = tmyId(t); if (!e || !meId) return;
  var ac = canPickFor(t, tmem(t, meId), e) && S.pickAs && tmem(t, S.pickAs) ? S.pickAs : meId;
  e.picks = e.picks || {};
  var arr = (e.picks[ac] || []).slice(), ix = arr.indexOf(itemId);
  if (ix > -1) arr.splice(ix, 1); else arr.push(itemId);
  if (arr.length) e.picks[ac] = arr; else delete e.picks[ac];
  render();
  queueWrite(function () { return tapi('PUT', '/expenses/' + e.id + '/picks', { memberId: ac, itemIds: arr }).then(function (j) { if (S.busy === 1) S.trip = j.trip; }); });
}

/* ---------- summary picture ----------
 * A picture of who ate what and who has paid, to post in the group chat or keep. Always drawn light, since it is shared. */
var SUM = { bg: '#f3f4f8', card: '#ffffff', ink: '#161a2b', muted: '#5d6479', line: '#dfe2ec', accent: '#d4206b', good: '#14804a', warn: '#8f5200',
  display: '"Bricolage Grotesque","Trebuchet MS",system-ui,sans-serif', body: '"Figtree",system-ui,-apple-system,"Segoe UI",sans-serif', mono: '"IBM Plex Mono",ui-monospace,Menlo,monospace' };
function wrapText(x, text, width) {
  var words = String(text).split(' '), lines = [], cur = '';
  words.forEach(function (w) { var t = cur ? cur + ' ' + w : w; if (x.measureText(t).width > width && cur) { lines.push(cur); cur = w; } else cur = t; });
  if (cur) lines.push(cur);
  return lines;
}
// Lays the picture out twice: once to measure its height, once to draw.
function summaryCanvas(b) {
  var c = Split.calc(b), W = 1080, P = 56, inner = W - 2 * P - 64, cv = document.createElement('canvas'), x = cv.getContext('2d');
  var rows = b.members.filter(function (m) { return c.per[m.id]; }).map(function (m) {
    var s = c.per[m.id], st = m.isPayer ? 'Paid the bill' : m.pay.status === 'paid' ? 'Paid' : m.pay.status === 'sent' ? 'Slip sent' : 'To pay';
    return { name: m.name, status: st, amount: s ? owedBy(m, c) : 0, dishes: s ? s.lines.map(function (l) { return l.name + (l.n > 1 ? ' (÷' + l.n + ')' : ''); }).join(', ') : 'Nothing picked',
      color: m.isPayer ? SUM.muted : st === 'Paid' ? SUM.good : st === 'Slip sent' ? SUM.warn : SUM.accent };
  });
  if (c.unclaimed.sub > 0) rows.push({ name: 'Not picked yet', status: 'With ' + nm(b, b.payerId), amount: c.unclaimed.total, dishes: c.unclaimed.items.map(function (i) { return i.name; }).join(', '), color: SUM.muted });
  function lay(draw) {
    var y = P;
    if (draw) { x.fillStyle = SUM.bg; x.fillRect(0, 0, W, cv.height); }
    // Header
    x.font = '700 30px ' + SUM.display; if (draw) { x.fillStyle = SUM.accent; x.fillText('Bei Cin Lah', P, y + 30); }
    y += 56;
    x.font = '800 52px ' + SUM.display;
    var tl = wrapText(x, b.title, W - 2 * P);
    tl.forEach(function (l) { if (draw) { x.fillStyle = SUM.ink; x.fillText(l, P, y + 50); } y += 62; });
    x.font = '400 28px ' + SUM.body; if (draw) { x.fillStyle = SUM.muted; x.fillText((b.date ? b.date + ' · ' : '') + 'paid by ' + nm(b, b.payerId), P, y + 30); }
    y += 52;
    x.font = '600 40px ' + SUM.mono; if (draw) { x.fillStyle = SUM.ink; x.fillText('Total ' + fmt(c.total), P, y + 40); }
    y += 76;
    // One card per person
    rows.forEach(function (r) {
      x.font = '400 26px ' + SUM.body; var dl = wrapText(x, r.dishes, inner);
      var h = 32 + 40 + dl.length * 34 + 28;
      if (draw) {
        x.fillStyle = SUM.card; x.fillRect(P, y, W - 2 * P, h); x.fillStyle = r.color; x.fillRect(P, y, 8, h);
        x.font = '700 32px ' + SUM.body; x.fillStyle = SUM.ink; x.textAlign = 'left'; x.fillText(r.name, P + 32, y + 32 + 30);
        x.font = '600 32px ' + SUM.mono; x.textAlign = 'right'; x.fillText(fmt(r.amount), W - P - 32, y + 32 + 30);
        x.font = '600 24px ' + SUM.body; x.fillStyle = r.color; x.fillText(r.status, W - P - 32, y + 32 + 64);
        x.textAlign = 'left'; x.font = '400 26px ' + SUM.body; x.fillStyle = SUM.muted;
        dl.forEach(function (l, i) { x.fillText(l, P + 32, y + 32 + 40 + 28 + i * 34); });
      }
      y += h + 16;
    });
    // Footer with the bill link
    y += 16;
    x.font = '400 26px ' + SUM.body; if (draw) { x.fillStyle = SUM.muted; x.fillText('Pick your dishes and pay at', P, y + 26); }
    y += 40;
    x.font = '600 28px ' + SUM.mono; if (draw) { x.fillStyle = SUM.accent; x.fillText(shareUrl(b), P, y + 28); }
    return y + 28 + P;
  }
  cv.width = W; cv.height = Math.ceil(lay(false)); lay(true);
  return cv;
}
async function showSummary(b) {
  try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) {}
  var blob = await new Promise(function (ok) { summaryCanvas(b).toBlob(ok, 'image/png'); });
  if (!blob) return toast('Could not make the picture');
  var name = (b.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'bill') + '-summary.png';
  S.modal = { title: 'Bill summary', src: URL.createObjectURL(blob), blob: blob, file: name, text: undefined,
    acts: (navigator.canShare ? '<button class="btn primary" data-act="sharesum">Share</button>' : '') + '<button class="btn" data-act="savesum">Save picture</button>' };
  paintModal();
}
async function shareSummary() {
  var m = S.modal; if (!m || !m.blob) return;
  var f = new File([m.blob], m.file, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [f] })) {
    try { await navigator.share({ files: [f], title: S.bill ? S.bill.title : 'Bill summary' }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  saveSummary();
}
function saveSummary() {
  var m = S.modal; if (!m || !m.blob) return;
  var a = document.createElement('a'); a.href = m.src; a.download = m.file; document.body.appendChild(a); a.click(); a.remove();
  toast('Picture saved');
}

/* ---------- receipt reading ----------
 * Free and on the phone with Tesseract.js (served from /ocr, loaded on first use, language file cached by the browser).
 * If the server's Claude reader is switched on it is tried first, and the phone takes over if it fails. */
var ocr = null, ocrTry = '';
function loadScript(src) { return new Promise(function (ok, no) { var s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = no; document.head.appendChild(s); }); }
function scanLabel(t) { var b = document.querySelector('[data-act="scan"]'); if (b) b.textContent = t; }
function ocrWorker() {
  if (!ocr) ocr = (async function () {
    if (!window.Tesseract) await loadScript('/ocr/tesseract.min.js');
    var w = await window.Tesseract.createWorker('eng', 1, { workerPath: '/ocr/worker.min.js', corePath: '/ocr', langPath: '/ocr', workerBlobURL: false, gzip: true,
      logger: function (m) { scanLabel(m.status === 'recognizing text' ? 'Reading' + ocrTry + '… ' + Math.round(m.progress * 100) + '%' : 'Getting ready…'); } });
    await w.setParameters({ preserve_interword_spaces: '1' });
    return w;
  })().catch(function (e) { ocr = null; throw e; });
  return ocr;
}
// The photo at 2400px on its long side: small ones (saved from WhatsApp) are enlarged so the letters are big enough
// to read, very large ones shrunk. Turned by `angle` (radians) about the centre to straighten a tilted receipt.
function photoCanvas(bmp, angle) {
  var s = 2400 / Math.max(bmp.width, bmp.height), c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  var x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.imageSmoothingQuality = 'high';
  x.translate(c.width / 2, c.height / 2); x.rotate(angle || 0);
  x.drawImage(bmp, -c.width / 2, -c.height / 2, c.width, c.height);
  return c;
}
function blackWhite(c) {
  var d = document.createElement('canvas'); d.width = c.width; d.height = c.height;
  var x = d.getContext('2d'); x.drawImage(c, 0, 0);
  x.putImageData(window.ReceiptParse.binarize(x.getImageData(0, 0, d.width, d.height)), 0, 0);
  return d;
}
async function readOnPhone(file) {
  var bmp = await createImageBitmap(file), c = photoCanvas(bmp, 0);
  var P = window.ReceiptParse, w = await ocrWorker(), r = null, n = 0;
  // Each try is read twice, from the text as Tesseract lines it up and from word positions; the reading that adds up best wins.
  var read = async function (canvas, psm) {
    ocrTry = ++n > 1 ? ' (try ' + n + ')' : '';
    await w.setParameters({ tessedit_pageseg_mode: psm });
    var out = (await w.recognize(canvas, {}, { text: true, blocks: true })).data;
    r = P.best([r, P.parse(out.text), P.parse(P.rowsFromBlocks(out.blocks))]);
    return out;
  };
  try {
    // First the photo as taken, in layout mode 6 (one block of text), which usually keeps a dish and its price together.
    var first = await read(c, '6');
    if (P.goodEnough(r)) return r;
    // Then straightened if it is tilted more than 2°, and a black-and-white copy that drops shadows and folds,
    // each also in layout mode 4 (one column). It stops as soon as a reading adds up.
    var a = P.tilt(first.blocks), turned = Math.abs(a) > 0.035;
    if (turned) c = photoCanvas(bmp, -a);
    var bw = blackWhite(c), tries = (turned ? [[c, '6']] : []).concat([[bw, '6'], [c, '4'], [bw, '4']]);
    for (var k = 0; k < tries.length; k++) { await read(tries[k][0], tries[k][1]); if (P.goodEnough(r)) break; }
    return r;
  } finally { ocrTry = ''; }
}
/* ---------- notifications ("ring me when someone pays") ----------
 * The payer's phone subscribes once per bill; the server sends "Victor sent RM 25.40" when a slip arrives.
 * iPhones allow this only for the app opened from the Home Screen. */
function pushReady() { return !!(S.cfg.push && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window); }
function notifyHtml(b, what) {
  what = what || 'someone sends a payment slip';
  if (b.notify) return '<div class="alert info"><span>You get a notification when ' + what + '.</span><button class="btn small" data-act="notifyoff">Turn off</button></div>';
  if (pushReady()) return '<div class="alert info"><span>Get a notification on this phone when ' + what + '.</span><button class="btn small primary" data-act="notifyon">Notify me</button></div>';
  var ios = /iPhone|iPad|iPod/.test(navigator.userAgent), standalone = navigator.standalone || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  if (ios && !standalone && S.cfg.push) return '<div class="alert info"><span>To get a notification when someone pays: tap Share, then Add to Home Screen. Open Bei Cin Lah from your Home Screen and turn it on there.</span></div>';
  return '';
}
function keyBytes(k) { var s = atob((k + '==='.slice((k.length + 3) % 4)).replace(/-/g, '+').replace(/_/g, '/')), a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
async function notifyOn(b) {
  try {
    if ((await Notification.requestPermission()) !== 'granted') return toast('Notifications are blocked. Allow them in your phone settings for this site.');
    var reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes((await api('GET', '/api/push/key')).key) });
    var body = { subscription: sub.toJSON() };
    if (S.view === 'trip') setTrip(await tapi('POST', '/push', body)); else setBill(await bapi('POST', '/push', body));
    render();
    toast('Done. This phone will ring when someone sends a slip.');
  } catch (e) { toast(e.status ? e.message : 'Could not turn on notifications on this phone'); }
}
async function notifyOff(b) {
  try {
    var reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null, sub = reg && reg.pushManager ? await reg.pushManager.getSubscription() : null;
    var body = sub ? { endpoint: sub.endpoint } : { all: true };
    if (S.view === 'trip') setTrip(await tapi('DELETE', '/push', body)); else setBill(await bapi('DELETE', '/push', body));
    render(); toast('Notifications turned off');
  } catch (e) { toast(e.message || 'Could not turn off notifications'); }
}

/* ---------- checking payment slips ----------
 * On the payer's phone, each new slip is read and its amount compared with what that person owes,
 * so the payer can confirm without opening every slip. Done here, not on the friend's phone, so it cannot be faked there. */
async function checkSlips(b) {
  if (S.slipRun || !b || !myId(b) || !mem(b, myId(b)).isPayer) return;
  var todo = b.members.filter(function (m) { var c = S.slipChecks[m.id]; return m.pay.status === 'sent' && m.hasSlip && (!c || c.slipAt !== m.pay.slipAt || c.expected !== m.pay.amount); });
  if (!todo.length) return;
  S.slipRun = true;
  try {
    for (var k = 0; k < todo.length; k++) {
      var m = todo[k];
      S.slipChecks[m.id] = { slipAt: m.pay.slipAt, expected: m.pay.amount, result: 'pending' }; render();
      try {
        var r = await fetch('/api/bills/' + b.id + '/img/slip/' + m.id, { headers: { 'x-token': tok(b.id) } });
        if (!r.ok) throw new Error('slip');
        var w = await ocrWorker();
        await w.setParameters({ tessedit_pageseg_mode: '3' });
        var c = window.ReceiptParse.checkSlip((await w.recognize(await r.blob())).data.text, m.pay.amount);
        S.slipChecks[m.id] = { slipAt: m.pay.slipAt, expected: m.pay.amount, result: c.result, amount: c.amount };
      } catch (e) { S.slipChecks[m.id] = { slipAt: m.pay.slipAt, expected: m.pay.amount, result: 'unread' }; }
      render();
    }
  } finally { S.slipRun = false; }
}
function slipCheckHtml(m) {
  var c = S.slipChecks[m.id];
  if (!c || c.slipAt !== m.pay.slipAt) return '';
  if (c.result === 'pending') return '<div class="small muted">Checking the slip…</div>';
  if (c.result === 'match') return '<div class="small" style="color:var(--good);font-weight:700">✓ Slip shows ' + fmt(c.amount) + ', matches</div>';
  if (c.result === 'mismatch') return '<div class="small" style="color:var(--warn);font-weight:700">Slip shows ' + fmt(c.amount) + ', expected ' + fmt(c.expected) + '. View the slip.</div>';
  return '<div class="small muted">Could not read the amount. View the slip to check.</div>';
}
function matchingSlips(b) {
  return b.members.filter(function (m) { var c = S.slipChecks[m.id]; return m.pay.status === 'sent' && c && c.result === 'match' && c.slipAt === m.pay.slipAt && c.expected === m.pay.amount; });
}
async function confirmMatching(b) {
  var list = matchingSlips(b); if (!list.length) return;
  for (var k = 0; k < list.length; k++) { try { setBill(await bapi('POST', '/pay', { memberId: list[k].id, action: 'confirm' })); } catch (e) { toast(e.message); break; } }
  render(); toast(list.length + ' payment' + (list.length > 1 ? 's' : '') + ' confirmed');
}

async function doScan() {
  var d = S.draft; if (!d.scanFile || S.scanning) return;
  S.scanning = true; d.scanNote = ''; render();
  try {
    var r = null;
    if (S.cfg.scan) { try { r = await api('POST', '/api/scan', { image: b64(await toJpeg(d.scanFile, 1400, 600000)) }); } catch (e) { r = null; } }
    if (!r || !r.items.length) r = await readOnPhone(d.scanFile);
    if (!r.items.length) throw new Error('empty');
    d.items = r.items.map(function (i) { return { name: i.name, qty: String(i.qty), price: fixed(i.each), line: i.line }; });
    d.service = r.service ? fixed(r.service) : ''; d.sst = r.sst ? fixed(r.sst) : ''; d.rounding = r.rounding ? fixed(r.rounding) : '';
    if (r.merchant && (!d.title || d.title === d.scanTitle)) d.title = d.scanTitle = r.merchant;
    if (r.date) d.date = r.date;
    d.scanTotal = r.total;
    var gap = r.total ? r.total - draftTotal(d) : 0;
    // Prices worked out from the receipt's totals (not read directly) are named so the payer can check them.
    var worked = r.filled ? ' ' + (r.filled === 1 ? 'One price was' : r.filled + ' prices were') + ' unreadable and worked out from the receipt total: ' +
      r.items.filter(function (i) { return i.filled; }).map(function (i) { return i.name + ' (' + fmt(i.line) + ')'; }).join(', ') + '.' : '';
    d.scanNote = !r.total ? 'Read ' + r.items.length + ' items coming to ' + fmt(draftTotal(d)) + ', but the receipt total could not be read. Please check the items and charges against the receipt.'
      : Math.abs(gap) > 1 ? 'Read ' + r.items.length + ' items. They come to ' + fmt(draftTotal(d)) + ' but the receipt says ' + fmt(r.total) + ', so ' + fmt(Math.abs(gap)) + (gap > 0 ? ' is missing or misread' : ' too much was read') + '. Please check the items against the receipt.'
      : 'Read ' + r.items.length + ' items, matching the receipt total of ' + fmt(draftTotal(d)) + '.' + worked + ' Please check them against the receipt.';
  } catch (e) { d.scanNote = e.status === 429 ? 'Too many scans for now. Type the items instead.' : 'Could not read that receipt. Try a clearer, flatter photo, or type the items.'; }
  S.scanning = false; render();
}
async function createBill() {
  var d = S.draft; if (S.creating) return;
  if (!d.title.trim()) return toast('Give the bill a name');
  if (!d.payerName.trim()) return toast('Enter your name');
  var items = d.items.filter(function (i) { return lineCents(i) > 0; }).map(function (i) { return { id: i.id, name: i.name, qty: Math.max(1, parseInt(i.qty, 10) || 1), price: lineCents(i) }; });
  if (!items.length) return toast('Add at least one item with an amount');
  S.creating = true; render();
  if (d.editId) {
    try {
      var j = await api('PUT', '/api/bills/' + d.editId, { title: d.title, date: d.date, items: items, service: toC(d.service), sst: toC(d.sst), rounding: toC(d.rounding) }, tok(d.editId));
      var eid = d.editId; S.draft = null; S.creating = false; S.bill = j.bill; toast('Bill updated'); nav('/b/' + eid);
    } catch (e) { S.creating = false; toast(e.message); render(); }
    return;
  }
  try {
    var r = await api('POST', '/api/bills', { title: d.title, date: d.date, payerName: d.payerName, items: items, service: toC(d.service), sst: toC(d.sst), rounding: toC(d.rounding), qr: b64(d.qr), receipt: b64(d.receipt) });
    S.store.bills[r.id] = { token: r.token, memberId: r.memberId, title: d.title }; S.store.name = d.payerName.trim(); saveStore();
    S.draft = null; clearDraft(); S.creating = false; toast('Bill created. Send the link to your friends.'); nav('/b/' + r.id);
  } catch (e) { S.creating = false; toast(e.message); render(); }
}
function joinBill(body) {
  var name = body.name; if (body.memberId == null && !String(name || '').trim()) return toast('Enter your name');
  api('POST', '/api/bills/' + S.billId + '/join', body).then(function (j) {
    S.store.bills[S.billId] = { token: j.token, memberId: j.memberId, title: j.bill.title };
    var m = mem(j.bill, j.memberId); if (m) S.store.name = m.name; saveStore(); S.bill = j.bill; render(); window.scrollTo(0, 0);
  }).catch(function (e) { toast(e.message); refreshForce().then(render); });
}
function addGuest() {
  var el = $('#gname'); if (!el) return; var name = el.value.trim();
  if (!name) return toast('Type your friend\'s name first');
  bapi('POST', '/members', { name: name }).then(function (j) { setBill(j); S.acting = j.memberId; render(); toast(name + ' added. Tap their dishes.'); }).catch(function (e) { toast(e.message); });
}

document.addEventListener('click', function (e) {
  var nv = e.target.closest('[data-nav]');
  if (nv) { e.preventDefault(); nav(nv.getAttribute('data-nav')); return; }
  var t = e.target.closest('[data-act]'); if (!t) return;
  var act = t.getAttribute('data-act');
  if (act === 'closemodal') { if (t.classList.contains('modal') && e.target !== t) return; closeModal(); return; }
  if (tripAction(act, t)) return;
  var b = S.bill, d = S.draft, uid = t.getAttribute('data-uid');
  switch (act) {
    case 'join': joinBill({ name: ($('#jname') || {}).value }); break;
    case 'claim': joinBill({ memberId: uid }); break;
    case 'copylink': if (b) { var inp = $('#sharelink'); copyText(shareUrl(b)).then(function () { if (inp) inp.select(); }); } break;
    case 'copyadmin': if (b) copyText(location.origin + '/b/' + b.id + '#k=' + tok(b.id)).then(function () { toast('Payer link copied. Anyone with it can manage this bill.'); }); break;
    case 'acting': S.acting = uid; render(); break;
    case 'addguest': addGuest(); break;
    case 'rmguest': if (b && S.acting) { var rm = S.acting; S.acting = null; bapi('DELETE', '/members/' + rm).then(function (j) { setBill(j); render(); }).catch(function (x) { toast(x.message); }); } break;
    case 'pick': if (b) {
      var meId = myId(b), ac = (b.payerId === meId && S.acting && mem(b, S.acting)) ? S.acting : meId, m = mem(b, ac); if (!m) break;
      var id = t.getAttribute('data-id'), arr = m.picks.slice(), ix = arr.indexOf(id); if (ix > -1) arr.splice(ix, 1); else arr.push(id);
      m.picks = arr; render();
      queueWrite(function () { return bapi('PUT', '/picks', { memberId: ac, itemIds: arr }).then(function (j) { if (S.busy === 1) setBill(j); }); });
    } break;
    case 'slipbtn': $('#fileSlip').click(); break;
    case 'confirm': case 'unconfirm': case 'markpaid':
      bapi('POST', '/pay', { memberId: uid, action: act }).then(function (j) { setBill(j); render(); if (act !== 'unconfirm') toast('Marked as paid'); }).catch(function (x) { toast(x.message); }); break;
    case 'viewslip': if (b) {
      fetch('/api/bills/' + b.id + '/img/slip/' + uid, { headers: { 'x-token': tok(b.id) } }).then(function (r) { if (!r.ok) throw new Error(); return r.blob(); })
        .then(function (bl) { S.modal = { title: 'Payment slip from ' + nm(b, uid), src: URL.createObjectURL(bl) }; paintModal(); }).catch(function () { toast('Could not load the slip'); });
    } break;
    case 'remind': showReminder([uid], 'Remind ' + nm(b, uid)); break;
    case 'confirmmatching': if (b) confirmMatching(b); break;
    case 'notifyon': notifyOn(); break;
    case 'notifyoff': notifyOff(); break;
    case 'leave': if (b) {
      var bid = b.id, was = (mem(b, myId(b)) || {}).name;
      bapi('POST', '/leave').then(function (j) { delete S.store.bills[bid]; if (S.store.name === was) S.store.name = ''; saveStore(); S.acting = null; S.bill = j.bill; render(); window.scrollTo(0, 0); toast('Done. Pick your own name, or join with it.'); }).catch(function (x) { toast(x.message); });
    } break;
    case 'resetlink': if (b) {
      if (S.confirmReset !== uid) { S.confirmReset = uid; toast('Tap Reset link again: ' + nm(b, uid) + ' will need to pick their name again from the bill link'); setTimeout(function () { S.confirmReset = null; }, 4000); break; }
      S.confirmReset = null;
      bapi('POST', '/members/' + uid + '/reset').then(function (j) { setBill(j); render(); toast(nm(j.bill, uid) + ' can now pick their name again from the bill link'); }).catch(function (x) { toast(x.message); });
    } break;
    case 'remindall': if (b) {
      var c = Split.calc(b), list = b.members.filter(function (m) { return !m.isPayer && (!c.per[m.id] || m.pay.status === 'unpaid'); }).map(function (m) { return m.id; });
      if (!list.length) toast('Everyone has paid or sent a slip'); else showReminder(list, 'Message for the group chat');
    } break;
    case 'copymodal': if (S.modal && S.modal.text != null) copyText(S.modal.text); break;
    case 'zoom': if (b) { var kind = t.getAttribute('data-src'); S.modal = { title: kind === 'qr' ? 'DuitNow QR' : 'Receipt', src: '/api/bills/' + b.id + '/img/' + kind + '?v=' + ((kind === 'qr' && b.qrAt) || b.createdAt) }; paintModal(); } break;
    case 'delete': if (b) {
      if (S.confirmDel === b.id) { S.confirmDel = null; bapi('DELETE', '').then(function () { delete S.store.bills[b.id]; saveStore(); nav('/'); }).catch(function (x) { toast(x.message); }); }
      else { S.confirmDel = b.id; toast('Tap Delete bill again to confirm'); setTimeout(function () { S.confirmDel = null; }, 4000); }
    } break;
    case 'pickreceipt': $('#fileReceipt').click(); break;
    case 'pickqr': case 'addqr': $('#fileQR').click(); break;
    case 'scan': doScan(); break;
    case 'additem': d.items.push({ name: '', qty: '1', price: '' }); render(); break;
    case 'rmitem': if (d.items.length > 1) { d.items.splice(+t.getAttribute('data-i'), 1); render(); } break;
    case 'svc10': d.service = fixed(Math.round(draftSum(d) * 0.10)); render(); break;
    case 'sst6': case 'sst8': d.sst = fixed(Math.round((draftSum(d) + toC(d.service)) * (act === 'sst6' ? 0.06 : 0.08))); render(); break;
    case 'create': createBill(); break;
    case 'discarddraft': clearDraft(); S.draft = S.view === 'new' ? newDraft() : null; render(); toast('Unfinished bill cleared'); break;
    case 'summary': if (b) showSummary(b); break;
    case 'sharesum': shareSummary(); break;
    case 'savesum': saveSummary(); break;
  }
});
document.addEventListener('input', function (e) {
  if (S.view === 'expense') { expenseInput(e.target); return; }
  var t = e.target, d = S.draft; if (!d || S.view !== 'new') return;
  if (t.hasAttribute('data-f')) d[t.getAttribute('data-f')] = t.value;
  else if (t.hasAttribute('data-i')) {
    var ix = +t.getAttribute('data-i'), it = d.items[ix]; it[t.getAttribute('data-k')] = t.value;
    if (t.getAttribute('data-k') !== 'name') delete it.line;
    var ce = document.querySelector('[data-line="' + ix + '"]'); if (ce) ce.textContent = fmt(lineCents(it));
  } else return;
  var el = $('#draftTotals'); if (el) el.innerHTML = totalsHtml(d);
  saveDraft();
});
document.addEventListener('change', function (e) {
  if (S.view === 'expense') expenseInput(e.target);
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && S.modal) closeModal();
  if (e.key === 'Enter' && e.target) {
    if (e.target.id === 'gname') { e.preventDefault(); addGuest(); }
    if (e.target.id === 'jname') { e.preventDefault(); joinBill({ name: e.target.value }); }
    if (e.target.id === 'tjname') { e.preventDefault(); joinTrip({ name: e.target.value }); }
    if (e.target.id === 'tgname') { e.preventDefault(); tripAction('taddperson', e.target); }
    if (e.target.id === 'tn-name' || e.target.id === 'tn-title') { e.preventDefault(); createTrip(); }
  }
});
window.addEventListener('popstate', function () { route(false); });

$('#fileReceipt').addEventListener('change', async function (e) {
  var f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return;
  if (S.view === 'expense' && S.edraft) {
    try { S.edraft.receipt = await toJpeg(f, 700, 70000); render(); scanExpense(f); } catch (x) { toast('That file is not a readable image'); }
    return;
  }
  if (!S.draft) return;
  try { S.draft.receipt = await toJpeg(f, 700, 70000); S.draft.scanFile = f; S.draft.scanNote = ''; render(); doScan(); }
  catch (x) { toast('That file is not a readable image'); }
});
$('#fileQR').addEventListener('change', async function (e) {
  var f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return;
  if (S.view === 'trip' && S.trip) {
    try { setTrip(await tapi('POST', '/qr', { image: b64(await toJpeg(f, 520, 90000)) })); render(); toast('DuitNow QR saved. Others can pay you with it.'); }
    catch (x) { toast(x.status ? x.message : 'That file is not a readable image'); }
    return;
  }
  if (S.view === 'bill' && S.bill) {
    try { var j = await bapi('POST', '/qr', { image: b64(await toJpeg(f, 520, 90000)) }); setBill(j); render(); toast('DuitNow QR saved. Friends now see it on the bill.'); }
    catch (x) { toast(x.status ? x.message : 'That file is not a readable image'); }
    return;
  }
  if (!S.draft) return;
  try { S.draft.qr = await toJpeg(f, 520, 90000); render(); } catch (x) { toast('That file is not a readable image'); }
});
$('#fileSlip').addEventListener('change', async function (e) {
  var f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return;
  if (S.view === 'trip' && S.trip && S.payTo) {
    var to = S.payTo;
    try { var tj = await tapi('POST', '/payments', { to: to, amount: S.payAmt, image: b64(await toJpeg(f, 900, 120000)) }); S.payTo = null; setTrip(tj); render(); toast('Slip sent to ' + tnm(tj.trip, to)); }
    catch (x) { toast(x.status ? x.message : 'That file is not a readable image'); }
    return;
  }
  if (!S.bill) return;
  try {
    var img = await toJpeg(f, 900, 120000);
    var j = await bapi('POST', '/slip', { image: b64(img) });
    setBill(j); render(); toast('Slip sent to ' + nm(S.bill, S.bill.payerId));
  } catch (x) { toast(x.status ? x.message : 'That file is not a readable image'); }
});

setInterval(function () {
  var a = document.activeElement, typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
  if (document.hidden || S.busy || S.modal || typing) return;
  if (S.view === 'bill') refresh();
  if ((S.view === 'trip' && !S.payTo) || S.view === 'picks') refreshTrip();
}, 6000);

api('GET', '/api/config').then(function (c) { S.cfg = c; if (S.view === 'new' || S.view === 'bill' || S.view === 'trip') render(); }).catch(function () {});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});
route(false);
})();
