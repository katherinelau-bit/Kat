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
  draft: null, acting: null, modal: null, busy: 0, chain: Promise.resolve(), scanning: false, creating: false, confirmDel: null, toastT: null, toastMsg: '' };

function loadStore() { try { var o = JSON.parse(localStorage.getItem('bcl.v1')); if (o && o.bills) return o; } catch (e) {} return { bills: {}, name: '' }; }
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
  if (p === '/new') { S.view = 'new'; if (!S.draft) S.draft = newDraft(); render(); return; }
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
  saveStore();
  S.home = res.filter(Boolean).sort(function (a, z) { return z.createdAt - a.createdAt; });
  S.homeLoaded = true; render();
}

/* ---------- drafts (new bill) ---------- */
function newDraft() { return { title: '', date: new Date().toISOString().slice(0, 10), payerName: S.store.name || '', items: [{ name: '', qty: '1', price: '' }], service: '', sst: '', rounding: '', qr: '', receipt: '', scanFile: null, scanTotal: 0, scanNote: '' }; }
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
    h += '<div class="field"><label for="jname">' + (open.length ? 'Or enter your name' : 'Your name') + '</label><input type="text" id="jname" maxlength="40" placeholder="e.g. Wei Jie" value="' + esc(S.store.name || '') + '"></div><div><button class="btn primary" data-act="join">Join and pick my dishes</button></div></div>';
    h += '<div class="card"><h3>What was ordered</h3><div class="receipt">' + b.items.map(function (it) { return '<div class="ln"><span class="nm">' + esc(it.name) + (it.qty > 1 ? '<span class="sub">' + it.qty + ' × ' + fmt(Math.round(it.price / it.qty)) + '</span>' : '') + '</span><span class="pr">' + fmt(it.price) + '</span></div>'; }).join('') + receiptTotals(b, c) + '</div></div>';
    return h;
  }

  var ac = meId; if (isPayer && S.acting && mem(b, S.acting)) ac = S.acting;
  var acm = mem(b, ac), my = c.per[ac], myPicks = acm.picks || [];

  if (isPayer) {
    var link = shareUrl(b), msg = 'Hi! Please pick what you ate for "' + b.title + '" and pay me by DuitNow here: ' + link;
    h += '<div class="card"><h3>Send this link to your friends</h3><div class="linkbox"><input type="text" id="sharelink" readonly aria-label="Bill link" value="' + esc(link) + '"><button class="btn" data-act="copylink">Copy link</button><a class="btn primary" href="https://wa.me/?text=' + encodeURIComponent(msg) + '" target="_blank" rel="noopener" style="text-decoration:none">WhatsApp</a></div><p class="small muted">Friends open the link, type their name and pick their dishes. No sign-up.</p></div>';
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
      if (b.hasQr) h += '<div><img class="qr" src="/api/bills/' + b.id + '/img/qr?v=' + b.createdAt + '" alt="DuitNow QR for ' + esc(nm(b, b.payerId)) + '" data-act="zoom" data-src="qr" style="cursor:zoom-in"></div>';
      h += '<div class="grow" style="display:flex;flex-direction:column;gap:8px"><p><b>Pay ' + esc(nm(b, b.payerId)) + ' ' + fmt(my.total) + '</b></p>' +
        (b.hasQr ? '<p class="small muted">Save the QR picture, open your banking app, choose Scan QR, then upload it. Transfer the exact amount.</p>' : '<p class="small muted">' + esc(nm(b, b.payerId)) + ' has not added a DuitNow QR yet.</p>') +
        (st === 'paid' ? '<p class="small" style="color:var(--good);font-weight:700">' + esc(nm(b, b.payerId)) + ' confirmed your payment.</p>' :
          st === 'sent' ? '<p class="small" style="color:var(--warn);font-weight:700">Slip sent. Waiting for ' + esc(nm(b, b.payerId)) + ' to confirm.</p><div><button class="btn small" data-act="slipbtn">Replace slip</button></div>' :
          '<div><button class="btn primary" data-act="slipbtn">I have paid, upload slip</button></div>') +
        (acm.hasSlip ? '<div><button class="btn small" data-act="viewslip" data-uid="' + ac + '">View my slip</button></div>' : '') + '</div></div>';
    }
    h += '</div>';
  } else if (ac === meId) h += '<div class="card"><p class="muted">Tap the dishes you ate above. Your share, with service charge and SST, appears here.</p></div>';

  h += '<div class="card"><div class="row between"><h3>Who has paid</h3>' + (isPayer ? '<button class="btn small" data-act="remindall">Remind everyone</button>' : '') + '</div><div>';
  b.members.forEach(function (m) {
    var s = c.per[m.id], st = m.pay.status;
    var acts = '';
    if (isPayer && !m.isPayer) {
      if (st === 'sent') acts = '<button class="btn small primary" data-act="confirm" data-uid="' + m.id + '">Confirm received</button><button class="btn small" data-act="viewslip" data-uid="' + m.id + '">View slip</button>';
      else if (st === 'paid') acts = '<button class="btn small" data-act="unconfirm" data-uid="' + m.id + '">Undo</button>';
      else { if (s) acts += '<button class="btn small" data-act="markpaid" data-uid="' + m.id + '">Mark paid (cash)</button>'; acts += '<button class="btn small" data-act="remind" data-uid="' + m.id + '">Remind</button>'; }
    }
    h += '<div class="person">' + av(b, m.id) + '<div class="grow"><div><b>' + esc(m.name) + (m.id === meId ? ' (you)' : '') + '</b></div><div class="small muted mono">' + (s ? fmt(owedBy(m, c)) : 'No items yet') + (m.remind && st === 'unpaid' && !m.isPayer ? ' · reminded ' + m.remind.count + '×, last ' + ago(m.remind.at) : '') + '</div></div>' + statusPill(m, c, m.isPayer) + (acts ? '<div class="acts" style="width:100%;padding-left:38px">' + acts + '</div>' : '') + '</div>';
  });
  h += '</div></div>';
  if (isPayer) h += '<div class="row" style="flex-wrap:wrap"><button class="btn small" data-act="copyadmin">Copy my payer link (keep private)</button><button class="btn small" data-act="delete" style="color:var(--bad)">Delete bill</button></div>';
  return h;
}
function totalsHtml(d) {
  var sum = draftSum(d), tot = draftTotal(d), w = '';
  if (d.scanTotal && Math.abs(d.scanTotal - tot) > 1) w = '<span class="small" style="color:var(--warn);display:block;font-weight:400">Receipt total read as ' + fmt(d.scanTotal) + '. Check the items and charges.</span>';
  return '<span>Total<span class="small" style="display:block;color:var(--muted);font-weight:400">Items ' + fmt(sum) + '</span>' + w + '</span><span>' + fmt(tot) + '</span>';
}
function viewNew() {
  var d = S.draft;
  var h = topbar() + '<button class="btn ghost" data-nav="/">← Your bills</button><h2>New bill</h2>';
  h += '<div class="card"><h3>1. Receipt</h3><div class="drop"><div class="row">' + (d.receipt ? '<img class="thumb" src="' + d.receipt + '" alt="Receipt photo">' : '') + '<div><b>' + (d.receipt ? 'Receipt attached' : 'Add a photo of the receipt') + '</b><div class="small muted">' + 'The items, service charge and SST are read for you. Check them before you create the bill. Friends can view the photo.' + '</div></div></div><div class="row"><button class="btn" data-act="pickreceipt">' + (d.receipt ? 'Change photo' : 'Choose photo') + '</button>' + (d.scanFile ? '<button class="btn primary" data-act="scan"' + (S.scanning ? ' disabled' : '') + '>' + (S.scanning ? 'Reading…' : 'Read receipt') + '</button>' : '') + '</div></div>' +
    (d.scanNote ? '<p class="small" style="color:var(--warn)">' + esc(d.scanNote) + '</p>' : '') + '</div>';
  h += '<div class="card"><h3>2. Items</h3><div class="two"><div class="field"><label for="f-title">Bill name</label><input type="text" id="f-title" data-f="title" maxlength="80" value="' + esc(d.title) + '" placeholder="e.g. Thai dinner"></div><div class="field"><label for="f-date">Date</label><input type="date" id="f-date" data-f="date" value="' + esc(d.date) + '"></div><div class="field"><label for="f-payer">Your name (you paid)</label><input type="text" id="f-payer" data-f="payerName" maxlength="40" value="' + esc(d.payerName) + '" placeholder="e.g. Katherine"></div></div>';
  h += '<div class="items"><div class="irow h"><span>Item</span><span>Qty</span><span>Each (RM)</span><span style="text-align:right">Total</span><span></span></div>';
  d.items.forEach(function (it, i) { h += '<div class="irow"><input type="text" aria-label="Item name" data-i="' + i + '" data-k="name" value="' + esc(it.name) + '" placeholder="Item"><input type="number" min="1" aria-label="Quantity" data-i="' + i + '" data-k="qty" value="' + esc(it.qty) + '"><input type="number" step="0.01" min="0" inputmode="decimal" aria-label="Price of one" data-i="' + i + '" data-k="price" value="' + esc(it.price) + '" placeholder="0.00"><span class="mono small" data-line="' + i + '">' + fmt(lineCents(it)) + '</span><button class="x" data-act="rmitem" data-i="' + i + '" aria-label="Remove item">×</button></div>'; });
  h += '</div><div><button class="btn small" data-act="additem">Add item</button></div><p class="small muted">Enter the price of one. The bill multiplies it by the quantity, so picking a dish with quantity 2 gives you both.</p></div>';
  h += '<div class="card"><h3>3. Charges</h3><div class="two"><div class="field"><label for="f-svc">Service charge (RM)</label><input type="number" step="0.01" id="f-svc" data-f="service" value="' + esc(d.service) + '" placeholder="0.00"></div><div class="field"><label for="f-sst">SST (RM)</label><input type="number" step="0.01" id="f-sst" data-f="sst" value="' + esc(d.sst) + '" placeholder="0.00"></div><div class="field"><label for="f-rnd">Rounding (RM)</label><input type="number" step="0.01" id="f-rnd" data-f="rounding" value="' + esc(d.rounding) + '" placeholder="0.00"></div></div><div class="chips"><button class="btn small" data-act="svc10">Service 10%</button><button class="btn small" data-act="sst6">SST 6%</button><button class="btn small" data-act="sst8">SST 8%</button></div><p class="small muted">The quick buttons work out the amount from your items. SST is applied after service charge. Match them to what the receipt prints.</p><div class="receipt"><div class="chg tot" id="draftTotals">' + totalsHtml(d) + '</div></div></div>';
  h += '<div class="card"><h3>4. Your DuitNow QR</h3><div class="drop"><div class="row">' + (d.qr ? '<img class="thumb" src="' + d.qr + '" alt="Your DuitNow QR" style="background:#fff">' : '') + '<div><b>' + (d.qr ? 'QR attached' : 'Add your DuitNow QR picture') + '</b><div class="small muted">Friends scan it to pay you the exact amount.</div></div></div><button class="btn" data-act="pickqr">' + (d.qr ? 'Change' : 'Choose picture') + '</button></div></div>';
  h += '<div class="row"><button class="btn primary" data-act="create"' + (S.creating ? ' disabled' : '') + '>' + (S.creating ? 'Creating…' : 'Create bill') + '</button><button class="btn" data-nav="/">Cancel</button></div>';
  return h;
}
function render() {
  var a = $('#app'); if (!a) return;
  a.innerHTML = S.view === 'new' ? viewNew() : S.view === 'bill' ? viewBill() : viewHome();
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
/* ---------- receipt reading ----------
 * Free and on the phone with Tesseract.js (served from /ocr, loaded on first use, language file cached by the browser).
 * If the server's Claude reader is switched on it is tried first, and the phone takes over if it fails. */
var ocr = null;
function loadScript(src) { return new Promise(function (ok, no) { var s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = no; document.head.appendChild(s); }); }
function scanLabel(t) { var b = document.querySelector('[data-act="scan"]'); if (b) b.textContent = t; }
function ocrWorker() {
  if (!ocr) ocr = (async function () {
    if (!window.Tesseract) await loadScript('/ocr/tesseract.min.js');
    var w = await window.Tesseract.createWorker('eng', 1, { workerPath: '/ocr/worker.min.js', corePath: '/ocr', langPath: '/ocr', workerBlobURL: false, gzip: true,
      logger: function (m) { scanLabel(m.status === 'recognizing text' ? 'Reading… ' + Math.round(m.progress * 100) + '%' : 'Getting ready…'); } });
    await w.setParameters({ preserve_interword_spaces: '1' });
    return w;
  })().catch(function (e) { ocr = null; throw e; });
  return ocr;
}
async function readOnPhone(file) {
  var bmp = await createImageBitmap(file);
  // The photo goes in as taken, only shrunk if it is very large: Tesseract's own black-and-white step copes with
  // coloured paper and shadows better than a grey or high-contrast version (tested on an orange receipt).
  var s = Math.min(1, 2200 / Math.max(bmp.width, bmp.height));
  var c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  var x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.drawImage(bmp, 0, 0, c.width, c.height);
  var P = window.ReceiptParse, w = await ocrWorker(), r = null;
  // Layout mode 6 (one block of text) usually keeps an item and its price together; mode 4 (one column) is the second try.
  // Each pass is read twice, from the text as Tesseract lines it up and from word positions, and the reading that adds up best wins.
  for (var psm of ['6', '4']) {
    await w.setParameters({ tessedit_pageseg_mode: psm });
    var out = (await w.recognize(c, {}, { text: true, blocks: true })).data;
    r = P.best([r, P.parse(out.text), P.parse(P.rowsFromBlocks(out.blocks))]);
    if (P.balanced(r)) break;
  }
  return r;
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
    if (r.merchant && !d.title) d.title = r.merchant;
    if (r.date) d.date = r.date;
    d.scanTotal = r.total;
    var gap = r.total ? r.total - draftTotal(d) : 0;
    d.scanNote = Math.abs(gap) > 1 ? 'Read ' + r.items.length + ' items. They come to ' + fmt(draftTotal(d)) + ' but the receipt says ' + fmt(r.total) + ', so ' + fmt(Math.abs(gap)) + (gap > 0 ? ' is missing or misread' : ' too much was read') + '. Please check the items against the receipt.' : 'Read ' + r.items.length + ' items. Please check them against the receipt.';
  } catch (e) { d.scanNote = e.status === 429 ? 'Too many scans for now. Type the items instead.' : 'Could not read that receipt. Try a clearer, flatter photo, or type the items.'; }
  S.scanning = false; render();
}
async function createBill() {
  var d = S.draft; if (S.creating) return;
  if (!d.title.trim()) return toast('Give the bill a name');
  if (!d.payerName.trim()) return toast('Enter your name');
  var items = d.items.filter(function (i) { return lineCents(i) > 0; }).map(function (i) { return { name: i.name, qty: Math.max(1, parseInt(i.qty, 10) || 1), price: lineCents(i) }; });
  if (!items.length) return toast('Add at least one item with an amount');
  S.creating = true; render();
  try {
    var r = await api('POST', '/api/bills', { title: d.title, date: d.date, payerName: d.payerName, items: items, service: toC(d.service), sst: toC(d.sst), rounding: toC(d.rounding), qr: b64(d.qr), receipt: b64(d.receipt) });
    S.store.bills[r.id] = { token: r.token, memberId: r.memberId, title: d.title }; S.store.name = d.payerName.trim(); saveStore();
    S.draft = null; S.creating = false; toast('Bill created. Send the link to your friends.'); nav('/b/' + r.id);
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
    case 'remindall': if (b) {
      var c = Split.calc(b), list = b.members.filter(function (m) { return !m.isPayer && (!c.per[m.id] || m.pay.status === 'unpaid'); }).map(function (m) { return m.id; });
      if (!list.length) toast('Everyone has paid or sent a slip'); else showReminder(list, 'Message for the group chat');
    } break;
    case 'copymodal': if (S.modal && S.modal.text != null) copyText(S.modal.text); break;
    case 'zoom': if (b) { var kind = t.getAttribute('data-src'); S.modal = { title: kind === 'qr' ? 'DuitNow QR' : 'Receipt', src: '/api/bills/' + b.id + '/img/' + kind + '?v=' + b.createdAt }; paintModal(); } break;
    case 'delete': if (b) {
      if (S.confirmDel === b.id) { S.confirmDel = null; bapi('DELETE', '').then(function () { delete S.store.bills[b.id]; saveStore(); nav('/'); }).catch(function (x) { toast(x.message); }); }
      else { S.confirmDel = b.id; toast('Tap Delete bill again to confirm'); setTimeout(function () { S.confirmDel = null; }, 4000); }
    } break;
    case 'pickreceipt': $('#fileReceipt').click(); break;
    case 'pickqr': $('#fileQR').click(); break;
    case 'scan': doScan(); break;
    case 'additem': d.items.push({ name: '', qty: '1', price: '' }); render(); break;
    case 'rmitem': if (d.items.length > 1) { d.items.splice(+t.getAttribute('data-i'), 1); render(); } break;
    case 'svc10': d.service = fixed(Math.round(draftSum(d) * 0.10)); render(); break;
    case 'sst6': case 'sst8': d.sst = fixed(Math.round((draftSum(d) + toC(d.service)) * (act === 'sst6' ? 0.06 : 0.08))); render(); break;
    case 'create': createBill(); break;
  }
});
document.addEventListener('input', function (e) {
  var t = e.target, d = S.draft; if (!d || S.view !== 'new') return;
  if (t.hasAttribute('data-f')) d[t.getAttribute('data-f')] = t.value;
  else if (t.hasAttribute('data-i')) {
    var ix = +t.getAttribute('data-i'), it = d.items[ix]; it[t.getAttribute('data-k')] = t.value;
    if (t.getAttribute('data-k') !== 'name') delete it.line;
    var ce = document.querySelector('[data-line="' + ix + '"]'); if (ce) ce.textContent = fmt(lineCents(it));
  } else return;
  var el = $('#draftTotals'); if (el) el.innerHTML = totalsHtml(d);
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && S.modal) closeModal();
  if (e.key === 'Enter' && e.target) {
    if (e.target.id === 'gname') { e.preventDefault(); addGuest(); }
    if (e.target.id === 'jname') { e.preventDefault(); joinBill({ name: e.target.value }); }
  }
});
window.addEventListener('popstate', function () { route(false); });

$('#fileReceipt').addEventListener('change', async function (e) {
  var f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f || !S.draft) return;
  try { S.draft.receipt = await toJpeg(f, 700, 70000); S.draft.scanFile = f; S.draft.scanNote = ''; render(); doScan(); }
  catch (x) { toast('That file is not a readable image'); }
});
$('#fileQR').addEventListener('change', async function (e) {
  var f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f || !S.draft) return;
  try { S.draft.qr = await toJpeg(f, 520, 90000); render(); } catch (x) { toast('That file is not a readable image'); }
});
$('#fileSlip').addEventListener('change', async function (e) {
  var f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f || !S.bill) return;
  try {
    var img = await toJpeg(f, 900, 120000);
    var j = await bapi('POST', '/slip', { image: b64(img) });
    setBill(j); render(); toast('Slip sent to ' + nm(S.bill, S.bill.payerId));
  } catch (x) { toast(x.status ? x.message : 'That file is not a readable image'); }
});

setInterval(function () {
  var a = document.activeElement, typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
  if (document.hidden || S.view !== 'bill' || S.busy || S.modal || typing) return;
  refresh();
}, 6000);

api('GET', '/api/config').then(function (c) { S.cfg = c; if (S.view === 'new') render(); }).catch(function () {});
route(false);
})();
