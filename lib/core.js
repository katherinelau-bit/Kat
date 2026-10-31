'use strict';
/*
 * Bei Cin Lah API, independent of where it runs.
 * createApi({ store, apiKey, model }) returns async (Request) => Response.
 *
 * store (all async):
 *   getBill(id) -> bill | null          putBill(bill)           delBill(id)
 *   update(id, fn) -> { bill, result }  (runs fn(bill) on a fresh copy, saves it, retries on conflict)
 *   getImg(key) -> base64 | null        putImg(key, base64)     delImg(key)
 */
const crypto = require('node:crypto');
const Split = require('../public/split.js');

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);
const ALPHA = 'abcdefghijkmnpqrstuvwxyz23456789';
const rid = (n) => { let s = ''; for (let i = 0; i < n; i++) s += ALPHA[crypto.randomInt(ALPHA.length)]; return s; };
const newToken = () => crypto.randomBytes(24).toString('hex');
const cleanName = (s, max = 40) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
const cents = (n, lo, hi) => { n = Math.round(Number(n)); if (!Number.isFinite(n)) return 0; return Math.min(hi, Math.max(lo, n)); };
const MAXC = 10000000;
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
    payerId: b.payerId, createdAt: b.createdAt, hasQr: !!b.hasQr, hasReceipt: !!b.hasReceipt, youId: me ? me.id : null,
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
const newMember = (name) => ({ id: rid(8), name, token: null, picks: [], pay: { status: 'unpaid' }, remind: null, hasSlip: false, joinedAt: Date.now() });

const SCAN_PROMPT = 'This image is a restaurant receipt from Malaysia. Read it and reply with only a JSON object in this shape: {"merchant":string,"date":"YYYY-MM-DD or empty string","items":[{"name":string,"qty":number,"amount":number}],"service_charge":number,"sst":number,"rounding":number,"total":number}. "amount" is the full line amount in RM (quantity times unit price). "service_charge" and "sst" are the amounts in RM printed on the receipt, 0 if absent. Do not list service charge, SST, rounding, subtotal or total as items. "rounding" can be negative. Use 0 for anything the receipt does not show.';

function createApi({ store, apiKey = '', model = 'claude-sonnet-5-5' }) {
  const hits = new Map();
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

  async function route(req, url) {
    const p = url.pathname, m = req.method;
    let r;
    if (m === 'GET' && p === '/api/config') return json(200, { scan: !!apiKey });

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
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, 80).map((i, n) => ({
        id: 'i' + (n + 1), name: cleanName(i.name, 80) || 'Item ' + (n + 1),
        qty: Math.min(99, Math.max(1, Math.round(Number(i.qty)) || 1)), price: cents(i.price, 0, MAXC),
      })).filter((i) => i.price > 0);
      if (!items.length) throw bad('Add at least one item with an amount');
      const id = rid(10), token = newToken(), mid = rid(8);
      const qr = cleanImage(body.qr), receipt = cleanImage(body.receipt);
      const b = {
        id, title, date: /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : new Date().toISOString().slice(0, 10),
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
        return send(await store.update(id, (b) => {
          const me = need(authMember(b, req)); const amount = share(b, me.id);
          if (amount <= 0) throw bad('Pick what you ate first');
          me.hasSlip = true; me.pay = { status: 'sent', amount, slipAt: Date.now() };
        }));
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
