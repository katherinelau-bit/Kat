/* Bei Cin Lah back office: visits, bills, trips and who owes what, for the owner of the site and their team.
 * Sign in as "owner" with the ADMIN_KEY password, or with a team account. The session (12 hours) is kept in this tab only.
 * What each role sees is decided by the server; all numbers are worked out here from GET /api/admin. */
(function () {
'use strict';
var $ = function (s) { return document.querySelector(s); };
var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
var KEY = 'bcl.admin.session';
var ROLE = { admin: 'Admin', manager: 'Manager', viewer: 'Viewer' };
var ROLE_INFO = { admin: 'Everything, and can manage the team', manager: 'Everything except the team', viewer: 'Numbers and charts only, no names' };
var A = { data: null, staff: null, range: 30, q: '', tq: '', open: {}, err: '', busy: false, user: '', flash: '',
  add: { name: '', username: '', role: 'viewer', password: '' }, reset: '', resetPw: '', confirmDel: '', pwOpen: false, mypw: { old: '', pw: '' } };

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
var token = function () { try { return sessionStorage.getItem(KEY) || ''; } catch (e) { return ''; } };
var setToken = function (t) { try { if (t) sessionStorage.setItem(KEY, t); else sessionStorage.removeItem(KEY); } catch (e) {} };
async function call(method, path, body) {
  var r;
  try { r = await fetch('/api/admin' + path, { method: method, headers: { 'content-type': 'application/json', 'x-token': token() }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' }); }
  catch (e) { throw new Error('No connection. Try again.'); }
  var j = {}; try { j = await r.json(); } catch (e) {}
  // Signed out (expired, password changed, account removed): back to the sign-in form.
  if (r.status === 401 && path !== '/login') { setToken(''); A.data = null; A.staff = null; A.err = j.error || 'Please sign in'; }
  if (!r.ok) { var x = new Error(j.error || 'Something went wrong'); x.status = r.status; throw x; }
  return j;
}
async function load() {
  if (!token()) return paint();
  A.busy = true; paint();
  try {
    var j = await call('GET', '');
    j.bills.sort(function (a, z) { return z.createdAt - a.createdAt; }); j.trips.sort(function (a, z) { return z.createdAt - a.createdAt; });
    A.data = j; A.err = '';
    A.staff = j.me.role === 'admin' ? (await call('GET', '/staff')).staff : null;
    A.reports = j.full ? (await call('GET', '/reports')).reports : null;
  } catch (e) { if (e.status !== 401) A.err = e.message; }
  A.busy = false; paint();
}
async function signIn() {
  A.user = ($('#un').value || '').trim(); var pw = $('#pw').value;
  if (!A.user || !pw) return;
  A.busy = true; A.err = ''; paint();
  try { var j = await call('POST', '/login', { username: A.user, password: pw }); setToken(j.token); A.busy = false; await load(); }
  catch (e) { A.err = e.message; A.busy = false; paint(); }
}
// A password to hand to a new team member: 14 letters and numbers, without look-alikes.
function makePassword() {
  var abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789', a = new Uint32Array(14); crypto.getRandomValues(a);
  return Array.prototype.map.call(a, function (n) { return abc[n % abc.length]; }).join('');
}

/* ---------- drawing ---------- */
function paint() {
  var root = $('#admin'), focus = document.activeElement && document.activeElement.id, at = focus ? document.activeElement.selectionStart : 0;
  root.innerHTML = A.data ? dashView() : lockView();
  if (focus && $('#' + focus)) { var el = $('#' + focus); el.focus(); try { el.setSelectionRange(at, at); } catch (e) {} }
}
function lockView() {
  var dis = A.busy ? ' disabled' : '';
  return '<form class="card lock" id="lockform"><h1>Back office</h1><p class="muted small" style="margin:0">Sign in with the username and password you were given. The site owner signs in as <b>owner</b> with the ADMIN_KEY password.</p>' +
    '<label class="small" for="un"><b>Username</b></label><input type="text" id="un" autocomplete="username" autocapitalize="none" spellcheck="false" value="' + esc(A.user) + '"' + dis + '>' +
    '<label class="small" for="pw"><b>Password</b></label><input type="password" id="pw" autocomplete="current-password"' + dis + '>' +
    (A.err ? '<p class="err" role="alert">' + esc(A.err) + '</p>' : '') + '<button class="primary" type="submit"' + dis + '>' + (A.busy ? 'Signing in…' : 'Sign in') + '</button></form>';
}

// The same totals from either view of a bill: the full one (admins, managers) or numbers only (viewers).
function billNums(b) {
  if (!A.data.full) {
    var paid = 0, wait = 0; b.owed.forEach(function (o) { if (o.paid) paid += rmOf(o.amount, b); else wait += rmOf(o.amount, b); });
    return { totalRM: rmOf(b.total, b), people: b.people, paidRM: paid, waitRM: wait, slips: b.slips };
  }
  var i = billInfo(b);
  return { totalRM: i.totalRM, people: b.members.length, paidRM: i.paidRM, waitRM: i.waitRM, slips: b.members.filter(function (m) { return m.hasSlip; }).length };
}
function tripNums(t) { return A.data.full ? { totalRM: Settle.total(t), people: t.members.length } : { totalRM: t.total, people: t.people }; }

function dashView() {
  var d = A.data, me = d.me, bills = d.bills, trips = d.trips;
  var rb = bills.filter(function (b) { return inRange(b.createdAt); }), rt = trips.filter(function (t) { return inRange(t.createdAt); });
  var days = A.range ? lastDays(A.range) : lastDays(Math.min(365, Math.max(30, Math.ceil((Date.now() - Math.min.apply(null, [Date.now()].concat(bills.map(function (b) { return b.createdAt; })))) / 864e5) + 1)));
  var visits = 0, fresh = 0;
  Object.keys(d.visits).forEach(function (k) { if (A.range === 0 || days.indexOf(k) > -1) { visits += d.visits[k].visits; fresh += d.visits[k].newDevices; } });
  var people = 0, splitRM = 0, paidRM = 0, waitRM = 0, receipts = 0, abroad = 0, slips = 0, cur = {};
  rb.forEach(function (b) {
    var i = billNums(b); people += i.people; splitRM += i.totalRM; paidRM += i.paidRM; waitRM += i.waitRM; slips += i.slips;
    if (b.hasReceipt) receipts++; if (fx(b)) abroad++;
    var k = b.currency || 'MYR'; cur[k] = cur[k] || { n: 0, rm: 0 }; cur[k].n++; cur[k].rm += i.totalRM;
  });
  var tripRM = 0, tripPeople = 0; rt.forEach(function (t) { var i = tripNums(t); tripRM += i.totalRM; tripPeople += i.people; });
  var label = A.range ? 'last ' + A.range + ' days' : 'all time';

  var h = '<div class="row between"><div><h1>Bei Cin Lah back office</h1><div class="muted small">Signed in as <b>' + esc(me.name) + '</b> · ' + ROLE[me.role] + (me.owner ? ' (owner)' : '') + ' · updated ' + esc(when(d.at)) + ' (Malaysia time)</div></div>' +
    '<div class="row"><button data-act="refresh">' + (A.busy ? 'Refreshing…' : 'Refresh') + '</button>' + (d.full ? '<button data-act="csv">Download CSV</button>' : '') + (me.owner ? '' : '<button data-act="mypw" aria-expanded="' + A.pwOpen + '">My password</button>') + '<button data-act="signout">Sign out</button></div></div>';
  if (A.err) h += '<p class="err" role="alert" style="margin-top:12px">' + esc(A.err) + '</p>';
  if (A.pwOpen) h += myPasswordView();
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

  if (d.full) h += billsTable(bills) + tripsTable(trips) + reportsView();
  else h += '<div class="card" style="margin-top:28px"><b>Numbers only</b><p class="muted small" style="margin:4px 0 0">As a Viewer you see totals and charts, without bill names or people. Ask an admin if you need more.</p></div>';
  if (me.role === 'admin') h += teamView();
  return h;
}

/* ---------- receipt reports ----------
 * Receipts people said were read wrong: the text the phone read (no photo, no names), what it made of it, and their note.
 * Download them all to have the reading rules fixed; delete the ones that are dealt with. */
function reportsView() {
  var list = A.reports || [];
  var h = '<div class="row between" style="margin-top:28px"><h2 style="margin:0">Receipt reports</h2>' + (list.length ? '<button data-act="repdl">Download all (' + list.length + ')</button>' : '') + '</div>';
  h += '<p class="muted small">Receipts people said the app read wrong: the text the phone read, what the app made of it, and (once they saved the bill) the dishes as they corrected them. No photos or names.</p>';
  if (!list.length) return h + '<div class="card empty">No reports yet. 🎉</div>';
  h += '<div class="tablewrap"><table><thead><tr><th>When</th><th>Shop (as read)</th><th class="n">Dishes read</th><th class="n">Total read</th><th>Corrected</th><th>Note</th><th></th></tr></thead><tbody>';
  list.forEach(function (r) {
    var shop = (r.texts[0] || '').split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return /[A-Za-z]{3}/.test(l); })[0] || '?', open = A.open['r' + r.id];
    h += '<tr class="main" data-open="r' + r.id + '" tabindex="0" aria-expanded="' + !!open + '"><td class="muted">' + esc(when(r.createdAt)) + '</td><td><b>' + esc(shop.slice(0, 40)) + '</b></td><td class="n">' + r.got.items.length + '</td><td class="n">' + (r.got.total ? RM(r.got.total) : '–') + '</td><td>' + (r.fixed ? '<span class="pill paid">✓ ' + r.fixed.items.length + ' dishes · ' + RM(r.fixed.total) + '</span>' : '<span class="muted small">not yet</span>') + '</td><td>' + esc(r.note || '') + '</td>' +
      '<td><button data-act="repdel" data-r="' + esc(r.id) + '" style="color:var(--bad)">' + (A.confirmDel === 'r' + r.id ? 'Tap again to delete' : 'Delete') + '</button></td></tr>';
    if (open) h += '<tr class="detail"><td colspan="7"><div class="sub"><div><b>What the app read</b><pre style="white-space:pre-wrap;font-size:12px;margin:6px 0 0">' + esc(r.texts[0]) + '</pre></div>' +
      '<div><b>What it made of it</b>' + readingList(r.got, r.fixed) + (r.fixed ? '<b style="display:block;margin-top:12px">What it should be (as corrected)</b>' + readingList(r.fixed, r.got) : '<p class="small muted">The corrected dishes arrive when the bill is saved.</p>') + '</div></div></td></tr>';
  });
  return h + '</tbody></table></div>';
}

// One reading as a list; lines missing from the other reading (or with another amount) are marked.
function readingList(a, other) {
  var key = function (i) { return i.qty + '|' + i.line; }, theirs = other ? other.items.map(key) : null;
  var li = a.items.map(function (i) { var diff = theirs && theirs.indexOf(key(i)) < 0; return '<li' + (diff ? ' style="color:var(--bad);font-weight:700"' : '') + '>' + esc(i.name) + ' ×' + i.qty + ' · ' + RM(i.line) + (diff ? ' ✱' : '') + '</li>'; }).join('') || '<li>No dishes</li>';
  var ch = [a.service ? 'service ' + RM(a.service) : '', a.sst ? 'SST ' + RM(a.sst) : '', a.rounding ? 'rounding ' + RM(a.rounding) : ''].filter(Boolean).join(' · ');
  return '<ul class="small" style="margin:6px 0 0">' + li + '</ul><div class="small muted">' + (ch ? ch + ' · ' : '') + 'total ' + (a.total ? RM(a.total) : '–') + '</div>';
}

/* ---------- the team (admins only) ---------- */
function teamView() {
  var list = A.staff || [], me = A.data.me, f = A.add;
  var h = '<h2 style="margin-top:36px">Team</h2><p class="muted small">Who can sign in to this back office. <b>Admin</b>: ' + ROLE_INFO.admin.toLowerCase() + '. <b>Manager</b>: ' + ROLE_INFO.manager.toLowerCase() + '. <b>Viewer</b>: ' + ROLE_INFO.viewer.toLowerCase() + '.</p>';
  if (A.flash) h += '<div class="card" role="status" style="border-color:var(--good);margin-bottom:10px"><div class="row between"><span>' + A.flash + '</span><button data-act="flashclose">Done</button></div></div>';
  if (!list.length) h += '<div class="card empty">No team members yet. Add someone below.</div>';
  else {
    h += '<div class="tablewrap"><table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th class="hide-sm">Last sign-in</th><th>Status</th><th></th></tr></thead><tbody>';
    list.forEach(function (u) {
      var self = u.username === me.username;
      h += '<tr><td><b>' + esc(u.name) + '</b></td><td>' + esc(u.username) + '</td><td>' + (self ? ROLE[u.role] + ' <span class="muted small">(you)</span>' :
        '<select data-role-of="' + esc(u.username) + '" aria-label="Role for ' + esc(u.name) + '">' + Object.keys(ROLE).map(function (r) { return '<option value="' + r + '"' + (u.role === r ? ' selected' : '') + '>' + ROLE[r] + '</option>'; }).join('') + '</select>') +
        '</td><td class="hide-sm muted">' + (u.lastLoginAt ? esc(when(u.lastLoginAt)) : 'Never') + '</td><td><span class="pill ' + (u.disabled ? 'unpaid">Turned off' : 'paid">Active') + '</span></td><td>' +
        (self ? '' : '<div class="row" style="gap:6px;flex-wrap:nowrap"><button data-act="resetopen" data-u="' + esc(u.username) + '">Reset password</button><button data-act="toggle" data-u="' + esc(u.username) + '">' + (u.disabled ? 'Turn on' : 'Turn off') + '</button><button data-act="remove" data-u="' + esc(u.username) + '" style="color:var(--bad)">' + (A.confirmDel === u.username ? 'Tap again to remove' : 'Remove') + '</button></div>') + '</td></tr>';
      if (A.reset === u.username) h += '<tr class="detail"><td colspan="6"><div class="row"><label class="small" for="rpw"><b>New password for ' + esc(u.name) + '</b></label><input type="text" id="rpw" data-reset autocomplete="new-password" spellcheck="false" value="' + esc(A.resetPw) + '" style="flex:1;min-width:180px"><button data-act="resetgen">Make one</button><button class="primary" data-act="resetsave">Save</button><button data-act="resetcancel">Cancel</button></div><p class="muted small" style="margin:6px 0 0">They are signed out everywhere and use this new password next time.</p></td></tr>';
    });
    h += '</tbody></table></div>';
  }
  h += '<form class="card" id="addform" style="margin-top:12px;display:flex;flex-direction:column;gap:10px"><b>Add a team member</b>' +
    '<div class="sub"><div style="display:flex;flex-direction:column;gap:4px"><label class="small" for="an">Name</label><input type="text" id="an" data-add="name" maxlength="40" value="' + esc(f.name) + '" placeholder="e.g. Aisha"></div>' +
    '<div style="display:flex;flex-direction:column;gap:4px"><label class="small" for="au">Username</label><input type="text" id="au" data-add="username" maxlength="30" autocapitalize="none" spellcheck="false" value="' + esc(f.username) + '" placeholder="e.g. aisha"></div>' +
    '<div style="display:flex;flex-direction:column;gap:4px"><label class="small" for="ar">Role</label><select id="ar" data-add="role">' + Object.keys(ROLE).map(function (r) { return '<option value="' + r + '"' + (f.role === r ? ' selected' : '') + '>' + ROLE[r] + ': ' + ROLE_INFO[r] + '</option>'; }).join('') + '</select></div>' +
    '<div style="display:flex;flex-direction:column;gap:4px"><label class="small" for="ap">Password (at least 10 characters)</label><div class="row" style="flex-wrap:nowrap"><input type="text" id="ap" data-add="password" autocomplete="new-password" spellcheck="false" value="' + esc(f.password) + '" style="flex:1"><button type="button" data-act="addgen">Make one</button></div></div></div>' +
    '<div><button class="primary" type="submit">Add to team</button></div></form>';
  return h;
}
function myPasswordView() {
  return '<form class="card" id="mypwform" style="margin-top:12px;display:flex;flex-direction:column;gap:8px;max-width:420px"><b>Change my password</b>' +
    '<label class="small" for="mo">Current password</label><input type="password" id="mo" data-mypw="old" autocomplete="current-password" value="' + esc(A.mypw.old) + '">' +
    '<label class="small" for="mn">New password (at least 10 characters)</label><input type="password" id="mn" data-mypw="pw" autocomplete="new-password" value="' + esc(A.mypw.pw) + '">' +
    '<div class="row"><button class="primary" type="submit">Save</button><button type="button" data-act="mypw">Cancel</button></div></form>';
}
async function teamCall(method, path, body, msg) {
  try { await call(method, '/staff' + path, body); A.staff = (await call('GET', '/staff')).staff; A.err = ''; if (msg) A.flash = msg; }
  catch (e) { A.err = e.message; window.scrollTo(0, 0); }
  paint();
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
document.addEventListener('submit', async function (e) {
  var id = e.target.id; if (id !== 'lockform' && id !== 'addform' && id !== 'mypwform') return;
  e.preventDefault();
  if (id === 'lockform') return signIn();
  if (id === 'addform') {
    var f = A.add, pw = f.password, name = f.name.trim(), user = f.username.trim().toLowerCase();
    try { await call('POST', '/staff', f); } catch (x) { A.err = x.message; return paint(); }
    A.add = { name: '', username: '', role: f.role, password: '' }; A.err = '';
    A.staff = (await call('GET', '/staff')).staff;
    A.flash = 'Added ' + esc(name) + '. Send them the link <b>' + esc(location.origin + '/admin') + '</b>, username <b>' + esc(user) + '</b> and password <b>' + esc(pw) + '</b> privately. This password is not shown again.';
    return paint();
  }
  try { var j = await call('POST', '/password', { old: A.mypw.old, password: A.mypw.pw }); setToken(j.token); A.pwOpen = false; A.mypw = { old: '', pw: '' }; A.err = ''; A.flash = ''; alert('Password changed.'); }
  catch (x) { A.err = x.message; }
  paint();
});
document.addEventListener('click', function (e) {
  var t = e.target.closest('[data-act],[data-range],[data-open]'); if (!t) return;
  if (t.hasAttribute('data-range')) { A.range = +t.getAttribute('data-range'); return paint(); }
  if (t.hasAttribute('data-open')) { var k = t.getAttribute('data-open'); A.open[k] = !A.open[k]; return paint(); }
  var act = t.getAttribute('data-act'), u = t.getAttribute('data-u');
  if (act !== 'remove' && act !== 'repdel') A.confirmDel = '';
  if (act === 'refresh') load();
  else if (act === 'csv') csv();
  else if (act === 'repdl') { var blob = new Blob([JSON.stringify(A.reports, null, 1)], { type: 'application/json' }), a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'bei-cin-lah-receipt-reports-' + dayOf(Date.now()) + '.json'; document.body.appendChild(a); a.click(); a.remove(); }
  else if (act === 'repdel') { var rk = 'r' + t.getAttribute('data-r'); if (A.confirmDel !== rk) { A.confirmDel = rk; return paint(); } A.confirmDel = ''; call('DELETE', '/reports/' + t.getAttribute('data-r')).then(function () { A.reports = A.reports.filter(function (x) { return 'r' + x.id !== rk; }); paint(); }).catch(function (x) { A.err = x.message; paint(); }); }
  else if (act === 'signout') { setToken(''); A.data = null; A.staff = null; A.err = ''; A.flash = ''; A.pwOpen = false; paint(); }
  else if (act === 'mypw') { A.pwOpen = !A.pwOpen; A.mypw = { old: '', pw: '' }; A.err = ''; paint(); }
  else if (act === 'flashclose') { A.flash = ''; paint(); }
  else if (act === 'addgen') { A.add.password = makePassword(); paint(); }
  else if (act === 'resetopen') { A.reset = u; A.resetPw = ''; paint(); }
  else if (act === 'resetgen') { A.resetPw = makePassword(); paint(); }
  else if (act === 'resetcancel') { A.reset = ''; paint(); }
  else if (act === 'resetsave') { var who = A.reset, pw = A.resetPw, nm = (A.staff.filter(function (x) { return x.username === who; })[0] || {}).name; A.reset = ''; teamCall('PUT', '/' + encodeURIComponent(who), { password: pw }, 'New password for ' + esc(nm) + ': <b>' + esc(pw) + '</b>. Send it to them privately. It is not shown again.'); }
  else if (act === 'toggle') { var s = A.staff.filter(function (x) { return x.username === u; })[0]; teamCall('PUT', '/' + encodeURIComponent(u), { disabled: !s.disabled }); }
  else if (act === 'remove') { if (A.confirmDel !== u) { A.confirmDel = u; return paint(); } A.confirmDel = ''; teamCall('DELETE', '/' + encodeURIComponent(u)); }
});
document.addEventListener('change', function (e) {
  var u = e.target.getAttribute && e.target.getAttribute('data-role-of');
  if (u) teamCall('PUT', '/' + encodeURIComponent(u), { role: e.target.value });
  var k = e.target.getAttribute && e.target.getAttribute('data-add'); if (k) A.add[k] = e.target.value;
});
document.addEventListener('keydown', function (e) { if ((e.key === 'Enter' || e.key === ' ') && e.target.hasAttribute && e.target.hasAttribute('data-open')) { e.preventDefault(); e.target.click(); } });
document.addEventListener('input', function (e) {
  var g = function (a) { return e.target.getAttribute && e.target.getAttribute(a); };
  if (g('data-q')) { A[g('data-q')] = e.target.value; return paint(); }
  if (g('data-add')) A.add[g('data-add')] = e.target.value;
  else if (e.target.hasAttribute && e.target.hasAttribute('data-reset')) A.resetPw = e.target.value;
  else if (g('data-mypw')) A.mypw[g('data-mypw')] = e.target.value;
});
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
// Fresh numbers every minute, unless someone is typing.
setInterval(function () { var a = document.activeElement; if (A.data && !document.hidden && !A.busy && !(a && /INPUT|SELECT/.test(a.tagName))) load(); }, 60000);
load();
})();
