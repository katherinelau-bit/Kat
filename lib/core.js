'use strict';
/*
 * Bei Cin Lah API, independent of where it runs.
 * createApi({ store, trips, apiKey, model, push }) returns async (Request) => Response. `trips` has the same interface as `store` (for trip documents).
 * push (optional, see lib/push.js): { publicKey(), send(subscription, payload, origin) -> { gone } }; made from the store if left out.
 *
 * store (all async):
 *   getBill(id) -> bill | null          putBill(bill)           delBill(id)
 *   update(id, fn) -> { bill, result }  (runs fn(bill) on a fresh copy, saves it, retries on conflict)
 *   getImg(key) -> base64 | null        putImg(key, base64)     delImg(key)
 */
const crypto = require('node:crypto');
const Split = require('../public/split.js');
const { createPush } = require('./push.js');

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);
const ALPHA = 'abcdefghijkmnpqrstuvwxyz23456789';
const rid = (n) => { let s = ''; for (let i = 0; i < n; i++) s += ALPHA[crypto.randomInt(ALPHA.length)]; return s; };
const newToken = () => crypto.randomBytes(24).toString('hex');
const cleanName = (s, max = 40) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
const cents = (n, lo, hi) => { n = Math.round(Number(n)); if (!Number.isFinite(n)) return 0; return Math.min(hi, Math.max(lo, n)); };
const MAXC = 10000000;
const rm = (c) => 'RM ' + (c / 100).toFixed(2);
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

function cleanImage(s) {
  if (!s) return null;
  s = String(s).replace(/^data:image\/jpeg;base64,/, '');
  if (s.length > 900000 || !/^[A-Za-z0-9+/]+=*$/.test(s)) throw bad('Image is not valid or too large');
  const buf = Buffer.from(s, 'base64');
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) throw bad('Image must be a JPEG');
  return s;
}
async function readJson(req, limit) {
  const text = await req.text();
  if (text.length > limit) throw new HttpError(413, 'Too large');
  if (!text) return {};
  try { return JSON.parse(text); } catch (e) { throw bad('Invalid JSON'); }
}
const imgKey = (kind, billId, mid) => kind + '/' + billId + (mid ? '/' + mid : '');

function authMember(b, req) {
  const t = String(req.headers.get('x-token') || '');
  if (t.length !== 48) return null;
  const tb = Buffer.from(t);
  for (const m of b.members) {
    if (m.token && m.token.length === 48 && crypto.timingSafeEqual(Buffer.from(m.token), tb)) return m;
  }
  return null;
}
function view(b, me) {
  return {
    id: b.id, title: b.title, date: b.date, items: b.items, service: b.service, sst: b.sst, rounding: b.rounding,
    payerId: b.payerId, notify: !!(me && me.isPayer && me.push && me.push.length), createdAt: b.createdAt, editedAt: b.editedAt || null, hasQr: !!b.hasQr, qrAt: b.qrAt || null, hasReceipt: !!b.hasReceipt, youId: me ? me.id : null,
    members: b.members.map((m) => ({
      id: m.id, name: m.name, isPayer: !!m.isPayer, claimed: !!(m.token || m.isPayer), picks: m.picks || [],
      pay: m.pay || { status: 'unpaid' }, remind: m.remind || null, hasSlip: !!m.hasSlip,
    })),
  };
}
const need = (me) => { if (!me) throw new HttpError(401, 'Join this bill first'); return me; };
const needOwner = (me) => { need(me); if (!me.isPayer) throw new HttpError(403, 'Only the person who paid can do this'); return me; };
const findMember = (b, id) => { const m = b.members.find((x) => x.id === id); if (!m) throw new HttpError(404, 'Person not found'); return m; };
const share = (b, mid) => { const c = Split.calc(b).per[mid]; return c ? c.total : 0; };
const validDate = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : new Date().toISOString().slice(0, 10));
// Items from the browser. Ids in `keep` are kept (so people's ticks stay on an edited dish); everything else gets a new id.
function cleanItems(list, keep) {
  const used = new Set();
  let next = 1 + Math.max(0, ...[...(keep || [])].map((x) => parseInt(String(x).slice(1), 10) || 0));
  const items = (Array.isArray(list) ? list : []).slice(0, 80).map((i, n) => {
    let id = String(i.id || '');
    if (!keep || !keep.has(id) || used.has(id)) id = 'i' + next++;
    used.add(id);
    return { id, name: cleanName(i.name, 80) || 'Item ' + (n + 1), qty: Math.min(99, Math.max(1, Math.round(Number(i.qty)) || 1)), price: cents(i.price, 0, MAXC) };
  }).filter((i) => i.price > 0);
  if (!items.length) throw bad('Add at least one item with an amount');
  return items;
}
const newMember = (name) => ({ id: rid(8), name, token: null, picks: [], pay: { status: 'unpaid' }, remind: null, hasSlip: false, joinedAt: Date.now() });

const SCAN_PROMPT = 'This image is a restaurant receipt from Malaysia. Read it and reply with only a JSON object in this shape: {"merchant":string,"date":"YYYY-MM-DD or empty string","items":[{"name":string,"qty":number,"amount":number}],"service_charge":number,"sst":number,"rounding":number,"total":number}. "amount" is the full line amount in RM (quantity times unit price). "service_charge" and "sst" are the amounts in RM printed on the receipt, 0 if absent. Do not list service charge, SST, rounding, subtotal or total as items. "rounding" can be negative. Use 0 for anything the receipt does not show.';

function createApi({ store, trips = null, apiKey = '', model = 'claude-sonnet-5-5', push }) {
  const hits = new Map();
  if (push === undefined) push = createPush(store);

  // Tells the payer's phones that a slip arrived. Phones that unsubscribed are forgotten.
  async function notifyPayer(b, payload, origin) {
    const payer = b.members.find((x) => x.isPayer);
    if (!push || !payer || !payer.push || !payer.push.length) return;
    const res = await Promise.all(payer.push.map((s) => push.send(s, payload, origin).catch(() => ({ gone: false }))));
    const gone = new Set(payer.push.filter((s, i) => res[i].gone).map((s) => s.endpoint));
    if (gone.size) await store.update(b.id, (nb) => { const p = nb.members.find((x) => x.isPayer); p.push = (p.push || []).filter((s) => !gone.has(s.endpoint)); });
  }
  function limited(req, name, max, windowMs) {
    const ip = req.headers.get('x-nf-client-connection-ip') || String(req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'x';
    const k = name + ':' + ip, t = Date.now();
    const a = (hits.get(k) || []).filter((x) => t - x < windowMs);
    if (hits.size > 5000) hits.clear();
    if (a.length >= max) { hits.set(k, a); return true; }
    a.push(t); hits.set(k, a); return false;
  }

  async function scanReceipt(b64) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 2000, messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
        { type: 'text', text: SCAN_PROMPT }] }] }),
    });
    if (!r.ok) {
      // Log Anthropic's reason (bad key, no credit, unknown model...) so it shows in the function logs.
      console.error('Receipt reader error', r.status, (await r.text().catch(() => '')).slice(0, 500));
      throw new HttpError(502, 'Receipt reader is unavailable right now');
    }
    const j = await r.json();
    const text = (j.content || []).map((c) => c.text || '').join('');
    const a = text.indexOf('{'), z = text.lastIndexOf('}');
    if (a < 0 || z < a) throw new HttpError(502, 'Could not read that receipt');
    let o; try { o = JSON.parse(text.slice(a, z + 1)); } catch (e) { throw new HttpError(502, 'Could not read that receipt'); }
    const items = (Array.isArray(o.items) ? o.items : []).slice(0, 80).map((i) => {
      const qty = Math.max(1, Math.round(Number(i.qty) || 1)), line = cents(Number(i.amount) * 100, 0, MAXC);
      return { name: cleanName(i.name, 80), qty, line, each: Math.round(line / qty) };
    }).filter((i) => i.name || i.line);
    return {
      merchant: cleanName(o.merchant, 60), date: /^\d{4}-\d{2}-\d{2}$/.test(o.date || '') ? o.date : '', items,
      service: cents(Number(o.service_charge) * 100, 0, MAXC), sst: cents(Number(o.sst) * 100, 0, MAXC),
      rounding: cents(Number(o.rounding) * 100, -10000, 10000), total: cents(Number(o.total) * 100, 0, MAXC),
    };
  }

  const validId = (id) => { if (!/^[a-z0-9]{10}$/.test(id)) throw new HttpError(404, 'Bill not found'); return id; };

  /* ---------- trips: many expenses, paid by different people, settled up at the end ----------
   * trip: { id, kind: 'trip', title, createdAt, ownerId, nextE, nextP,
   *   members: [{ id, name, token, isOwner, joinedAt, hasQr, qrAt, push }],
   *   expenses: [{ id, title, date, paidBy, amount, mode: 'equal'|'exact'|'items', among, shares, addedBy, createdAt, editedAt, hasReceipt,
   *                 items, service, sst, rounding, picks: { memberId: [itemId] } (items only) }],
   *   payments: [{ id, from, to, amount, status: 'sent'|'paid', hasSlip, at, confirmedAt }] } */
  const tview = (t, me) => ({
    id: t.id, title: t.title, createdAt: t.createdAt, ownerId: t.ownerId, youId: me ? me.id : null,
    notify: !!(me && me.push && me.push.length),
    members: t.members.map((x) => ({ id: x.id, name: x.name, isOwner: !!x.isOwner, claimed: !!x.token, hasQr: !!x.hasQr, qrAt: x.qrAt || null })),
    expenses: t.expenses, payments: t.payments,
  });
  const tMember = (t, id) => { const x = t.members.find((y) => y.id === id); if (!x) throw new HttpError(404, 'Person not found'); return x; };
  // The expense as sent by the browser, checked: who paid and who shares it must be in the trip, exact shares must add up.
  // Split by items: the dishes and charges make the amount; picks already made on kept dishes survive an edit (prev).
  function cleanExpense(t, body, prev) {
    const ids = new Set(t.members.map((x) => x.id));
    const title = cleanName(body.title, 80), paidBy = String(body.paidBy || '');
    if (!title) throw bad('Give the expense a name');
    if (!ids.has(paidBy)) throw bad('Choose who paid');
    if (body.mode === 'items') {
      const items = cleanItems(body.items, prev && prev.mode === 'items' ? new Set(prev.items.map((i) => i.id)) : null);
      const service = cents(body.service, 0, MAXC), sst = cents(body.sst, 0, MAXC), rounding = cents(body.rounding, -10000, 10000);
      const total = items.reduce((s, i) => s + i.price, 0) + service + sst + rounding;
      if (total <= 0) throw bad('Enter the amount');
      const valid = new Set(items.map((i) => i.id)), picks = {};
      Object.keys((prev && prev.picks) || {}).forEach((id) => { const p = prev.picks[id].filter((x) => valid.has(x)); if (ids.has(id) && p.length) picks[id] = p; });
      return { title, date: validDate(body.date), paidBy, amount: total, mode: 'items', among: [], items, service, sst, rounding, picks };
    }
    const amount = cents(body.amount, 0, MAXC);
    if (amount <= 0) throw bad('Enter the amount');
    const among = [...new Set((Array.isArray(body.among) ? body.among : []).map(String))].filter((x) => ids.has(x));
    if (!among.length) throw bad('Choose who shares this expense');
    const mode = body.mode === 'exact' ? 'exact' : 'equal', out = { title, date: validDate(body.date), paidBy, amount, mode, among };
    if (mode === 'exact') {
      out.shares = {}; let sum = 0;
      among.forEach((x) => { const v = cents(body.shares && body.shares[x], 0, MAXC); out.shares[x] = v; sum += v; });
      if (sum !== amount) throw bad('The amounts for each person add up to RM ' + (sum / 100).toFixed(2) + ', not RM ' + (amount / 100).toFixed(2));
    }
    return out;
  }
  async function notifyMember(id, mid, payload, origin) {
    const t = await trips.getBill(id), x = t && t.members.find((y) => y.id === mid);
    if (!push || !x || !x.push || !x.push.length) return;
    const res = await Promise.all(x.push.map((s) => push.send(s, payload, origin).catch(() => ({ gone: false }))));
    const gone = new Set(x.push.filter((s, i) => res[i].gone).map((s) => s.endpoint));
    if (gone.size) await trips.update(id, (nt) => { const y = nt.members.find((z) => z.id === mid); y.push = (y.push || []).filter((s) => !gone.has(s.endpoint)); });
  }

  async function tripRoute(req, url) {
    if (!trips) throw new HttpError(501, 'Trips are not available on this server');
    const p = url.pathname, m = req.method;
    let r;
    if (m === 'POST' && p === '/api/trips') {
      if (limited(req, 'create', 20, 3600e3)) throw new HttpError(429, 'Too many new trips. Try again later.');
      const body = await readJson(req, 10e3);
      const title = cleanName(body.title, 80), name = cleanName(body.name, 40);
      if (!title) throw bad('Give the trip a name');
      if (!name) throw bad('Enter your name');
      const id = rid(10), token = newToken(), mid = rid(8);
      await trips.putBill({ id, kind: 'trip', title, createdAt: Date.now(), ownerId: mid, nextE: 1, nextP: 1, expenses: [], payments: [],
        members: [{ id: mid, name, token, isOwner: true, joinedAt: Date.now() }] });
      return json(200, { id, memberId: mid, token });
    }
    if (!(r = p.match(/^\/api\/trips\/([a-z0-9]+)(?:\/(.*))?$/))) throw new HttpError(404, 'Not found');
    if (!/^[a-z0-9]{10}$/.test(r[1])) throw new HttpError(404, 'Trip not found');
    const id = r[1], rest = r[2] || '';
    const who = (t) => authMember(t, req);
    const send = (u) => json(200, Object.assign({ trip: tview(u.bill, who(u.bill)) }, u.result || {}));
    const load = async () => { const t = await trips.getBill(id); if (!t) throw new HttpError(404, 'Trip not found'); return t; };
    const canEdit = (t, me, e) => me && (me.isOwner || e.addedBy === me.id);

    if (m === 'GET' && rest === '') { const t = await load(); return json(200, { trip: tview(t, who(t)) }); }
    if (m === 'POST' && rest === 'auth') { const t = await load(); const me = need(who(t)); return json(200, { trip: tview(t, me), memberId: me.id }); }

    if (m === 'GET' && (r = rest.match(/^img\/(qr|receipt|slip)\/([a-z0-9]+)$/))) {
      const t = await load(), kind = r[1], key = r[2];
      if (kind === 'slip') {
        const me = need(who(t)), pay = t.payments.find((x) => x.id === key);
        if (!pay || (me.id !== pay.from && me.id !== pay.to)) throw new HttpError(403, 'Not allowed');
      }
      const data = await store.getImg('trip-' + kind + '/' + id + '/' + key);
      if (!data) throw new HttpError(404, 'No image');
      return new Response(Buffer.from(data, 'base64'), { status: 200, headers: { 'content-type': 'image/jpeg', 'x-content-type-options': 'nosniff', 'cache-control': kind === 'slip' ? 'private, no-store' : 'public, max-age=3600' } });
    }

    if (m === 'POST' && rest === 'join') {
      if (limited(req, 'join', 40, 3600e3)) throw new HttpError(429, 'Too many tries. Try again later.');
      const body = await readJson(req, 10e3), name = cleanName(body.name), claim = body.memberId ? String(body.memberId) : '';
      if (!claim && !name) throw bad('Enter your name');
      const u = await trips.update(id, (t) => {
        let x;
        if (claim) { x = tMember(t, claim); if (x.token) throw new HttpError(409, 'That name is already taken. Join with a different name.'); }
        else { if (t.members.length >= 40) throw bad('This trip is full'); x = { id: rid(8), name, token: null, joinedAt: Date.now() }; t.members.push(x); }
        x.token = newToken();
        return { memberId: x.id, token: x.token };
      });
      return json(200, { trip: tview(u.bill, u.bill.members.find((x) => x.id === u.result.memberId)), memberId: u.result.memberId, token: u.result.token });
    }
    if (m === 'POST' && rest === 'leave') {
      return send(await trips.update(id, (t) => { const me = need(who(t)); if (me.isOwner) throw bad('The person who made the trip cannot leave it'); me.token = null; }));
    }
    // Anyone in the trip can add people by name (for friends who will join later).
    if (m === 'POST' && rest === 'members') {
      const name = cleanName((await readJson(req, 10e3)).name);
      if (!name) throw bad('Enter the person\'s name');
      return send(await trips.update(id, (t) => {
        need(who(t)); if (t.members.length >= 40) throw bad('This trip is full');
        const x = { id: rid(8), name, token: null, joinedAt: Date.now() }; t.members.push(x); return { memberId: x.id };
      }));
    }
    if ((r = rest.match(/^members\/([a-z0-9]+)(\/reset)?$/)) && (m === 'DELETE' || (m === 'POST' && r[2]))) {
      const mid = r[1];
      return send(await trips.update(id, (t) => {
        const me = need(who(t)); if (!me.isOwner) throw new HttpError(403, 'Only the person who made the trip can do this');
        const x = tMember(t, mid); if (x.isOwner) throw bad('You cannot remove or reset yourself');
        if (r[2]) { x.token = null; return; }
        if (t.expenses.some((e) => e.paidBy === mid || e.among.includes(mid) || (e.picks && e.picks[mid])) || t.payments.some((pp) => pp.from === mid || pp.to === mid)) throw bad(x.name + ' is in some expenses or payments. Take them out of those first.');
        t.members = t.members.filter((y) => y.id !== mid);
      }));
    }
    // Your own DuitNow QR, so others can pay you when settling up.
    if (m === 'POST' && rest === 'qr') {
      const img = cleanImage((await readJson(req, 1.5e6)).image); if (!img) throw bad('Attach your DuitNow QR picture');
      const me = need(who(await load()));
      await store.putImg('trip-qr/' + id + '/' + me.id, img);
      return send(await trips.update(id, (t) => { const x = tMember(t, me.id); x.hasQr = true; x.qrAt = Date.now(); }));
    }

    if (m === 'POST' && rest === 'expenses') {
      const body = await readJson(req, 1.5e6), receipt = cleanImage(body.receipt);
      const t0 = await load(); need(who(t0)); cleanExpense(t0, body);
      const u = await trips.update(id, (t) => {
        const me = need(who(t)), e = Object.assign({ id: 'e' + t.nextE++, addedBy: me.id, createdAt: Date.now(), hasReceipt: !!receipt }, cleanExpense(t, body));
        t.expenses.push(e); return { expenseId: e.id };
      });
      if (receipt) await store.putImg('trip-receipt/' + id + '/' + u.result.expenseId, receipt);
      return send(u);
    }
    if ((r = rest.match(/^expenses\/(e\d+)$/)) && (m === 'PUT' || m === 'DELETE')) {
      const eid = r[1], body = m === 'PUT' ? await readJson(req, 1.5e6) : {}, receipt = cleanImage(body.receipt);
      const u = await trips.update(id, (t) => {
        const me = need(who(t)), e = t.expenses.find((x) => x.id === eid);
        if (!e) throw new HttpError(404, 'Expense not found');
        if (!canEdit(t, me, e)) throw new HttpError(403, 'Only the person who added this, or who made the trip, can change it');
        if (m === 'DELETE') { t.expenses = t.expenses.filter((x) => x.id !== eid); return { had: e.hasReceipt }; }
        Object.assign(e, cleanExpense(t, body, e), { editedAt: Date.now() });
        if (e.mode !== 'exact') delete e.shares;
        if (e.mode !== 'items') ['items', 'service', 'sst', 'rounding', 'picks'].forEach((k) => delete e[k]);
        if (receipt) e.hasReceipt = true;
      });
      if (receipt) await store.putImg('trip-receipt/' + id + '/' + eid, receipt);
      if (m === 'DELETE' && u.result && u.result.had) await store.delImg('trip-receipt/' + id + '/' + eid);
      return send(u);
    }

    // Picking dishes on an expense split by items: your own, or anyone's if you added it, paid for it or made the trip.
    if (m === 'PUT' && (r = rest.match(/^expenses\/(e\d+)\/picks$/))) {
      const eid = r[1], body = await readJson(req, 10e3);
      return send(await trips.update(id, (t) => {
        const me = need(who(t)), e = t.expenses.find((x) => x.id === eid);
        if (!e) throw new HttpError(404, 'Expense not found');
        if (e.mode !== 'items') throw bad('This expense is not split by items');
        let target = me;
        if (body.memberId && body.memberId !== me.id) {
          if (!(me.isOwner || e.addedBy === me.id || e.paidBy === me.id)) throw new HttpError(403, 'You can only pick your own dishes');
          target = tMember(t, String(body.memberId));
        }
        const valid = new Set(e.items.map((i) => i.id));
        const p = [...new Set((Array.isArray(body.itemIds) ? body.itemIds : []).map(String).filter((x) => valid.has(x)))];
        e.picks = e.picks || {};
        if (p.length) e.picks[target.id] = p; else delete e.picks[target.id];
      }));
    }

    // Settling up. "I paid": the payer records a payment (slip optional) that the receiver confirms.
    // "I received": the receiver records cash (or anything) they got; it counts as confirmed straight away.
    if (m === 'POST' && (rest === 'payments' || rest === 'payments/received')) {
      const body = await readJson(req, 1.5e6), img = rest === 'payments' ? cleanImage(body.image) : null;
      const amount = cents(body.amount, 0, MAXC); if (amount <= 0) throw bad('Enter the amount');
      const u = await trips.update(id, (t) => {
        const me = need(who(t)), other = tMember(t, String(rest === 'payments' ? body.to : body.from));
        if (other.id === me.id) throw bad('Choose someone else');
        const pay = rest === 'payments'
          ? { id: 'p' + t.nextP++, from: me.id, to: other.id, amount, status: 'sent', hasSlip: !!img, at: Date.now() }
          : { id: 'p' + t.nextP++, from: other.id, to: me.id, amount, status: 'paid', hasSlip: false, at: Date.now(), confirmedAt: Date.now() };
        t.payments.push(pay); return { paymentId: pay.id, to: pay.to, fromName: me.name };
      });
      if (img) await store.putImg('trip-slip/' + id + '/' + u.result.paymentId, img);
      if (rest === 'payments') await notifyMember(id, u.result.to, { title: u.result.fromName + ' sent you RM ' + (amount / 100).toFixed(2), body: u.bill.title + ': tap to check and confirm', url: '/t/' + id, tag: 'trip-' + id + '-' + u.result.paymentId }, url.origin);
      return send(u);
    }
    if (m === 'POST' && (r = rest.match(/^payments\/(p\d+)$/))) {
      const action = String((await readJson(req, 10e3)).action), pid = r[1];
      const u = await trips.update(id, (t) => {
        const me = need(who(t)), pay = t.payments.find((x) => x.id === pid);
        if (!pay) throw new HttpError(404, 'Payment not found');
        if (action === 'confirm' || action === 'reject') { if (me.id !== pay.to) throw new HttpError(403, 'Only the person who received it can do this'); }
        else if (action === 'cancel') { if (me.id !== pay.from && me.id !== pay.to) throw new HttpError(403, 'Not allowed'); }
        else throw bad('Unknown action');
        if (action === 'confirm') { pay.status = 'paid'; pay.confirmedAt = Date.now(); return; }
        t.payments = t.payments.filter((x) => x.id !== pid); return { had: pay.hasSlip };
      });
      if (u.result && u.result.had) await store.delImg('trip-slip/' + id + '/' + pid);
      return send(u);
    }

    if (rest === 'push' && (m === 'POST' || m === 'DELETE')) {
      const body = await readJson(req, 10e3), sub = body.subscription || {};
      const endpoint = String(sub.endpoint || body.endpoint || ''), all = m === 'DELETE' && body.all === true;
      if (!all && (!/^https:\/\//.test(endpoint) || endpoint.length > 1000)) throw bad('Not a valid notification subscription');
      return send(await trips.update(id, (t) => {
        const me = need(who(t));
        me.push = all ? [] : (me.push || []).filter((s) => s.endpoint !== endpoint);
        if (m === 'POST') {
          const keys = sub.keys || {};
          if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' || keys.p256dh.length > 200 || keys.auth.length > 100) throw bad('Not a valid notification subscription');
          me.push = me.push.concat({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }).slice(-5);
        }
      }));
    }

    if (m === 'DELETE' && rest === '') {
      const t = await load(), me = need(who(t));
      if (!me.isOwner) throw new HttpError(403, 'Only the person who made the trip can delete it');
      const keys = [].concat(t.members.filter((x) => x.hasQr).map((x) => 'trip-qr/' + id + '/' + x.id), t.expenses.filter((e) => e.hasReceipt).map((e) => 'trip-receipt/' + id + '/' + e.id), t.payments.filter((x) => x.hasSlip).map((x) => 'trip-slip/' + id + '/' + x.id));
      await trips.delBill(id);
      await Promise.all(keys.map((k) => store.delImg(k)));
      return json(200, { ok: true });
    }
    throw new HttpError(404, 'Not found');
  }

  async function route(req, url) {
    const p = url.pathname, m = req.method;
    let r;
    if (p === '/api/trips' || p.startsWith('/api/trips/')) return tripRoute(req, url);
    if (m === 'GET' && p === '/api/config') return json(200, { scan: !!apiKey, push: !!push });
    if (m === 'GET' && p === '/api/push/key') {
      if (!push) throw new HttpError(501, 'Notifications are not available on this server');
      return json(200, { key: await push.publicKey() });
    }

    if (m === 'POST' && p === '/api/scan') {
      if (!apiKey) throw new HttpError(501, 'Receipt reading is not switched on');
      if (limited(req, 'scan', 15, 3600e3)) throw new HttpError(429, 'Too many scans. Try again later.');
      const body = await readJson(req, 1.5e6);
      return json(200, await scanReceipt(cleanImage(body.image)));
    }

    if (m === 'POST' && p === '/api/bills') {
      if (limited(req, 'create', 20, 3600e3)) throw new HttpError(429, 'Too many bills. Try again later.');
      const body = await readJson(req, 2.5e6);
      const title = cleanName(body.title, 80), payerName = cleanName(body.payerName, 40);
      if (!title) throw bad('Give the bill a name');
      if (!payerName) throw bad('Enter your name');
      const items = cleanItems(body.items, null);
      const id = rid(10), token = newToken(), mid = rid(8);
      const qr = cleanImage(body.qr), receipt = cleanImage(body.receipt);
      const b = {
        id, title, date: validDate(body.date),
        items, service: cents(body.service, 0, MAXC), sst: cents(body.sst, 0, MAXC), rounding: cents(body.rounding, -10000, 10000),
        payerId: mid, createdAt: Date.now(), hasQr: !!qr, hasReceipt: !!receipt,
        members: [{ id: mid, name: payerName, token, isPayer: true, picks: [], pay: { status: 'unpaid' }, remind: null, hasSlip: false, joinedAt: Date.now() }],
      };
      if (qr) await store.putImg(imgKey('qr', id), qr);
      if (receipt) await store.putImg(imgKey('receipt', id), receipt);
      await store.putBill(b);
      return json(200, { id, memberId: mid, token });
    }

    if ((r = p.match(/^\/api\/bills\/([a-z0-9]+)(?:\/(.*))?$/))) {
      const id = validId(r[1]), rest = r[2] || '';
      const send = (u) => json(200, Object.assign({ bill: view(u.bill, authMember(u.bill, req)) }, u.result || {}));

      if (m === 'GET' && rest === '') {
        const b = await store.getBill(id); if (!b) throw new HttpError(404, 'Bill not found');
        return json(200, { bill: view(b, authMember(b, req)) });
      }
      if (m === 'POST' && rest === 'auth') {
        const b = await store.getBill(id); if (!b) throw new HttpError(404, 'Bill not found');
        const me = need(authMember(b, req));
        return json(200, { bill: view(b, me), memberId: me.id });
      }

      if (m === 'GET' && (r = rest.match(/^img\/(qr|receipt|slip)(?:\/([a-z0-9]+))?$/))) {
        const kind = r[1], mid = r[2];
        const b = await store.getBill(id); if (!b) throw new HttpError(404, 'Bill not found');
        if (kind === 'slip') {
          const me = need(authMember(b, req));
          if (!mid || (!me.isPayer && me.id !== mid)) throw new HttpError(403, 'Not allowed');
        }
        const data = await store.getImg(imgKey(kind, id, kind === 'slip' ? mid : ''));
        if (!data) throw new HttpError(404, 'No image');
        return new Response(Buffer.from(data, 'base64'), { status: 200, headers: {
          'content-type': 'image/jpeg', 'x-content-type-options': 'nosniff',
          'cache-control': kind === 'slip' ? 'private, no-store' : 'public, max-age=3600' } });
      }

      if (m === 'POST' && rest === 'join') {
        if (limited(req, 'join', 40, 3600e3)) throw new HttpError(429, 'Too many tries. Try again later.');
        const body = await readJson(req, 10e3);
        const name = cleanName(body.name), claim = body.memberId ? String(body.memberId) : '';
        if (!claim && !name) throw bad('Enter your name');
        const u = await store.update(id, (b) => {
          let mem;
          if (claim) {
            mem = findMember(b, claim);
            if (mem.token || mem.isPayer) throw new HttpError(409, 'That name is already taken. Join with a different name.');
          } else {
            if (b.members.length >= 40) throw bad('This bill is full');
            mem = newMember(name); b.members.push(mem);
          }
          mem.token = newToken();
          return { memberId: mem.id, token: mem.token };
        });
        return json(200, { bill: view(u.bill, u.bill.members.find((x) => x.id === u.result.memberId)), memberId: u.result.memberId, token: u.result.token });
      }

      // Releasing a name, so the right person can claim it: "Not you? Switch person" (the member themselves),
      // or "Reset link" (the payer, for any friend). Picks and payments stay with the name.
      if (m === 'POST' && rest === 'leave') {
        return send(await store.update(id, (b) => {
          const me = need(authMember(b, req));
          if (me.isPayer) throw bad('The person who paid cannot leave the bill');
          me.token = null;
        }));
      }
      if (m === 'POST' && (r = rest.match(/^members\/([a-z0-9]+)\/reset$/))) {
        const mid = r[1];
        return send(await store.update(id, (b) => {
          needOwner(authMember(b, req));
          const mem = findMember(b, mid);
          if (mem.isPayer) throw bad('You cannot reset your own link');
          mem.token = null;
        }));
      }

      if (m === 'POST' && rest === 'members') {
        const name = cleanName((await readJson(req, 10e3)).name);
        if (!name) throw bad('Enter your friend\'s name');
        return send(await store.update(id, (b) => {
          needOwner(authMember(b, req));
          if (b.members.length >= 40) throw bad('This bill is full');
          const mem = newMember(name); b.members.push(mem); return { memberId: mem.id };
        }));
      }
      if (m === 'DELETE' && (r = rest.match(/^members\/([a-z0-9]+)$/))) {
        const mid = r[1];
        const u = await store.update(id, (b) => {
          needOwner(authMember(b, req));
          const mem = findMember(b, mid);
          if (mem.isPayer) throw bad('You cannot remove the person who paid');
          b.members = b.members.filter((x) => x.id !== mid); return { had: !!mem.hasSlip };
        });
        if (u.result.had) await store.delImg(imgKey('slip', id, mid));
        return send(u);
      }

      if (m === 'PUT' && rest === 'picks') {
        const body = await readJson(req, 10e3);
        return send(await store.update(id, (b) => {
          const me = need(authMember(b, req));
          const target = body.memberId && body.memberId !== me.id ? (needOwner(me), findMember(b, String(body.memberId))) : me;
          const valid = new Set(b.items.map((i) => i.id));
          target.picks = [...new Set((Array.isArray(body.itemIds) ? body.itemIds : []).map(String).filter((x) => valid.has(x)))];
          if (target.pay && target.pay.status === 'sent') target.pay.amount = share(b, target.id);
        }));
      }

      if (m === 'POST' && rest === 'slip') {
        const body = await readJson(req, 1.5e6);
        const img = cleanImage(body.image);
        if (!img) throw bad('Attach the payment slip');
        const cur = await store.getBill(id); if (!cur) throw new HttpError(404, 'Bill not found');
        const who = need(authMember(cur, req));
        if (who.isPayer) throw bad('You paid this bill');
        if (share(cur, who.id) <= 0) throw bad('Pick what you ate first');
        await store.putImg(imgKey('slip', id, who.id), img);
        const u = await store.update(id, (b) => {
          const me = need(authMember(b, req)); const amount = share(b, me.id);
          if (amount <= 0) throw bad('Pick what you ate first');
          me.hasSlip = true; me.pay = { status: 'sent', amount, slipAt: Date.now() };
          return { name: me.name, amount };
        });
        await notifyPayer(u.bill, { title: u.result.name + ' sent ' + rm(u.result.amount), body: u.bill.title + ': tap to check the slip and confirm', url: '/b/' + id, tag: 'slip-' + id + '-' + who.id }, url.origin);
        return send(u);
      }

      // The payer's phone asks to be told when slips arrive ("Notify me when someone pays"), or stops.
      if (rest === 'push' && (m === 'POST' || m === 'DELETE')) {
        const body = await readJson(req, 10e3), sub = body.subscription || {};
        const endpoint = String(sub.endpoint || body.endpoint || ''), all = m === 'DELETE' && body.all === true;
        if (!all && (!/^https:\/\//.test(endpoint) || endpoint.length > 1000)) throw bad('Not a valid notification subscription');
        return send(await store.update(id, (b) => {
          const me = needOwner(authMember(b, req));
          // "all" turns notifications off for every phone, e.g. from a phone that never turned them on.
          me.push = all ? [] : (me.push || []).filter((s) => s.endpoint !== endpoint);
          if (m === 'POST') {
            const keys = sub.keys || {};
            if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' || keys.p256dh.length > 200 || keys.auth.length > 100) throw bad('Not a valid notification subscription');
            me.push = me.push.concat({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }).slice(-5);
          }
        }));
      }

      // The payer adds or changes the DuitNow QR after creating the bill.
      if (m === 'POST' && rest === 'qr') {
        const body = await readJson(req, 1.5e6);
        const img = cleanImage(body.image);
        if (!img) throw bad('Attach your DuitNow QR picture');
        const cur = await store.getBill(id); if (!cur) throw new HttpError(404, 'Bill not found');
        needOwner(authMember(cur, req));
        await store.putImg(imgKey('qr', id), img);
        return send(await store.update(id, (b) => { needOwner(authMember(b, req)); b.hasQr = true; b.qrAt = Date.now(); }));
      }

      if (m === 'POST' && rest === 'pay') {
        const body = await readJson(req, 10e3), action = String(body.action), mid = String(body.memberId);
        if (!['confirm', 'markpaid', 'unconfirm'].includes(action)) throw bad('Unknown action');
        return send(await store.update(id, (b) => {
          needOwner(authMember(b, req));
          const mem = findMember(b, mid);
          if (action === 'unconfirm') mem.pay = mem.hasSlip ? { status: 'sent', amount: mem.pay.amount, slipAt: mem.pay.slipAt } : { status: 'unpaid' };
          else mem.pay = { status: 'paid', amount: mem.pay && mem.pay.status === 'sent' && mem.pay.amount != null ? mem.pay.amount : share(b, mem.id), slipAt: mem.pay && mem.pay.slipAt, confirmedAt: Date.now() };
        }));
      }

      if (m === 'POST' && rest === 'remind') {
        const body = await readJson(req, 10e3);
        const ids = (Array.isArray(body.memberIds) ? body.memberIds : []).map(String), ts = Date.now();
        return send(await store.update(id, (b) => {
          needOwner(authMember(b, req));
          b.members.forEach((x) => { if (!x.isPayer && ids.includes(x.id)) x.remind = { count: ((x.remind && x.remind.count) || 0) + 1, at: ts }; });
        }));
      }

      // The payer edits the name, date, items or charges. Ticks stay on dishes that are kept; a removed dish comes off
      // everyone's picks. Slips not yet confirmed follow the new share; confirmed payments keep the amount that was paid.
      if (m === 'PUT' && rest === '') {
        const body = await readJson(req, 100e3);
        const title = cleanName(body.title, 80);
        if (!title) throw bad('Give the bill a name');
        return send(await store.update(id, (b) => {
          needOwner(authMember(b, req));
          b.items = cleanItems(body.items, new Set(b.items.map((i) => i.id)));
          b.title = title; b.date = validDate(body.date);
          b.service = cents(body.service, 0, MAXC); b.sst = cents(body.sst, 0, MAXC); b.rounding = cents(body.rounding, -10000, 10000);
          const valid = new Set(b.items.map((i) => i.id));
          b.members.forEach((x) => {
            x.picks = (x.picks || []).filter((p) => valid.has(p));
            if (x.pay && x.pay.status === 'sent') x.pay.amount = share(b, x.id);
          });
          b.editedAt = Date.now();
        }));
      }

      if (m === 'DELETE' && rest === '') {
        const b = await store.getBill(id); if (!b) throw new HttpError(404, 'Bill not found');
        needOwner(authMember(b, req));
        const keys = [imgKey('qr', id), imgKey('receipt', id)].concat(b.members.filter((x) => x.hasSlip).map((x) => imgKey('slip', id, x.id)));
        await store.delBill(id);
        await Promise.all(keys.map((k) => store.delImg(k)));
        return json(200, { ok: true });
      }
    }
    throw new HttpError(404, 'Not found');
  }

  return async function handle(req) {
    try { return await route(req, new URL(req.url)); }
    catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message });
      console.error(e); return json(500, { error: 'Something went wrong' });
    }
  };
}
module.exports = { createApi, HttpError };
