'use strict';
// Checks the API end to end, once on the self-hosted server (SQLite) and once the way Netlify runs it (Blobs).
// Run with: node test.js
process.env.DATA_DIR = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'bcl-'));
const assert = require('node:assert/strict');
const { server } = require('./server.js');
const { createApi } = require('./lib/core.js');
const { createBlobStore } = require('./lib/blobs-store.js');
const Split = require('./public/split.js');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]).toString('base64');

// A stand-in for @netlify/blobs: strong reads and etag-checked writes, with a small delay so writes can collide.
function fakeBlobs() {
  const m = new Map(); let n = 0; const tick = () => new Promise((r) => setTimeout(r, Math.random() * 8));
  return {
    async get(k, o) { await tick(); const v = m.get(k); if (!v) return null; return o && o.type === 'json' ? JSON.parse(v.data) : v.data; },
    async getWithMetadata(k, o) { await tick(); const v = m.get(k); if (!v) return null; return { data: o && o.type === 'json' ? JSON.parse(v.data) : v.data, etag: v.etag }; },
    async set(k, data, o) { await tick(); const v = m.get(k); if (o && o.onlyIfMatch && (!v || v.etag !== o.onlyIfMatch)) return { modified: false }; m.set(k, { data, etag: 'e' + (++n) }); return { modified: true, etag: 'e' + n }; },
    async delete(k) { await tick(); m.delete(k); },
  };
}

async function suite(name, call) {
  const items = [['Nasi lemak', 1, 1350], ['Mee goreng', 1, 900], ['Roti canai', 2, 440], ['Teh tarik', 3, 840], ['Ais kopi', 1, 320], ['Maggi goreng', 1, 850], ['Sirap bandung', 1, 350]]
    .map(([n, qty, price]) => ({ name: n, qty, price }));
  let r = await call('POST', '/api/bills', { title: 'Test dinner', payerName: 'Aisha', items, service: 505, sst: 333, rounding: 2, qr: JPEG });
  assert.equal(r.status, 200); const { id, token: owner, memberId: payer } = r.body;

  r = await call('GET', '/api/bills/' + id);
  assert.equal(r.status, 200); assert.equal(r.body.bill.hasQr, true); assert.ok(!JSON.stringify(r.body).includes(owner), 'token must not leak');
  assert.equal((await call('GET', '/api/bills/' + id + '/img/qr')).body.length, 44);

  r = await call('POST', '/api/bills/' + id + '/join', { name: 'Wei Jie' }); const wj = r.body; assert.equal(r.status, 200);
  assert.equal((await call('POST', '/api/bills/' + id + '/members', { name: 'Priya' }, wj.token)).status, 403, 'only payer adds people');
  r = await call('POST', '/api/bills/' + id + '/members', { name: 'Priya' }, owner); const priya = r.body.memberId; assert.equal(r.status, 200);

  // two people tick dishes at the same moment: both must be saved
  const both = await Promise.all([
    call('PUT', '/api/bills/' + id + '/picks', { itemIds: ['i2', 'i3', 'i5'] }, wj.token),
    call('PUT', '/api/bills/' + id + '/picks', { memberId: priya, itemIds: ['i3', 'i6', 'i7'] }, owner),
    call('PUT', '/api/bills/' + id + '/picks', { itemIds: ['i1', 'i4'] }, owner),
  ]);
  both.forEach((x) => assert.equal(x.status, 200));
  r = await call('GET', '/api/bills/' + id, null, owner);
  const pk = Object.fromEntries(r.body.bill.members.map((m) => [m.name, m.picks.join(',')]));
  assert.deepEqual(pk, { Aisha: 'i1,i4', 'Wei Jie': 'i2,i3,i5', Priya: 'i3,i6,i7' }, 'concurrent picks must not be lost');
  assert.equal((await call('PUT', '/api/bills/' + id + '/picks', { memberId: priya, itemIds: ['i1'] }, wj.token)).status, 403);

  const c = Split.calc(r.body.bill);
  assert.equal(Object.values(c.per).reduce((a, p) => a + p.total, 0) + c.unclaimed.total, c.total); assert.equal(c.total, 5890);

  r = await call('POST', '/api/bills/' + id + '/slip', { image: JPEG }, wj.token); assert.equal(r.status, 200);
  const me = r.body.bill.members.find((m) => m.id === wj.memberId);
  assert.equal(me.pay.status, 'sent'); assert.equal(me.pay.amount, c.per[wj.memberId].total); assert.equal(me.hasSlip, true);
  assert.equal((await call('GET', `/api/bills/${id}/img/slip/${wj.memberId}`, null, owner)).status, 200);
  assert.equal((await call('GET', `/api/bills/${id}/img/slip/${wj.memberId}`)).status, 401, 'slips are private');
  assert.equal((await call('GET', `/api/bills/${id}/img/slip/${priya}`, null, wj.token)).status, 403);
  assert.equal((await call('POST', '/api/bills/' + id + '/slip', { image: 'bm90LWpwZWc=' }, wj.token)).status, 400);
  assert.equal((await call('POST', '/api/bills/' + id + '/pay', { memberId: wj.memberId, action: 'confirm' }, wj.token)).status, 403);
  r = await call('POST', '/api/bills/' + id + '/pay', { memberId: wj.memberId, action: 'confirm' }, owner);
  assert.equal(r.body.bill.members.find((m) => m.id === wj.memberId).pay.status, 'paid');
  r = await call('POST', '/api/bills/' + id + '/pay', { memberId: wj.memberId, action: 'unconfirm' }, owner);
  assert.equal(r.body.bill.members.find((m) => m.id === wj.memberId).pay.status, 'sent');
  r = await call('POST', '/api/bills/' + id + '/pay', { memberId: priya, action: 'markpaid' }, owner);
  assert.equal(r.body.bill.members.find((m) => m.id === priya).pay.status, 'paid');

  r = await call('POST', '/api/bills/' + id + '/remind', { memberIds: [priya] }, owner);
  assert.equal(r.body.bill.members.find((m) => m.id === priya).remind.count, 1);
  r = await call('POST', '/api/bills/' + id + '/members', { name: 'Hafiz' }, owner); const haf = r.body.memberId;
  assert.equal((await call('POST', '/api/bills/' + id + '/join', { memberId: haf })).status, 200);
  assert.equal((await call('POST', '/api/bills/' + id + '/join', { memberId: haf })).status, 409, 'cannot claim twice');
  assert.equal((await call('DELETE', `/api/bills/${id}/members/${payer}`, null, owner)).status, 400);
  assert.equal((await call('DELETE', `/api/bills/${id}/members/${priya}`, null, owner)).status, 200);

  assert.equal((await call('DELETE', '/api/bills/' + id, null, wj.token)).status, 403);
  assert.equal((await call('DELETE', '/api/bills/' + id, null, owner)).status, 200);
  assert.equal((await call('GET', '/api/bills/' + id)).status, 404);
  assert.equal((await call('GET', '/api/bills/' + id + '/img/qr')).status, 404);
  assert.equal((await call('GET', '/api/bills/' + 'x'.repeat(10))).status, 404);
  assert.equal((await call('POST', '/api/scan', { image: JPEG })).status, 501);
  console.log('passed:', name);
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = 'http://localhost:' + server.address().port;
  const viaHttp = async (method, url, body, token) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-token': token || '' }, body: body ? JSON.stringify(body) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  await suite('self-hosted server (SQLite)', viaHttp);

  const handle = createApi({ store: createBlobStore(fakeBlobs()) });
  const viaFunction = async (method, url, body, token) => {
    const r = await handle(new Request('https://example.test' + url, { method, headers: { 'content-type': 'application/json', 'x-token': token || '' }, body: body ? JSON.stringify(body) : undefined }));
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  await suite('Netlify function (Blobs stand-in)', viaFunction);

  // The real @netlify/blobs client against its own local server, if `npm install` has been run.
  let blobsPkg, blobsServerPkg;
  try { blobsPkg = await import('@netlify/blobs'); blobsServerPkg = await import('@netlify/blobs/server'); } catch { console.log('skipped: real @netlify/blobs (run npm install first)'); }
  if (blobsPkg) {
    const bs = new blobsServerPkg.BlobsServer({ directory: process.env.DATA_DIR + '/blobs', token: 'test', port: 0 });
    const { port } = await bs.start();
    const real = blobsPkg.getStore({ name: 'bei-cin-lah', siteID: 'test', token: 'test', apiURL: 'http://localhost:' + port, consistency: 'strong' });
    // A stale etag must be refused, not silently overwrite (this is what keeps concurrent picks safe).
    const a = await real.set('probe', '1'), b = await real.set('probe', '2', { onlyIfMatch: a.etag });
    assert.equal(b.modified, true);
    assert.equal((await real.set('probe', '3', { onlyIfMatch: a.etag })).modified, false, 'onlyIfMatch must reject a stale etag');
    assert.equal(await real.get('probe'), '2');
    // The local server sends no etag on reads (production Netlify is checked live). The adapter must then refuse, not overwrite.
    await real.set('bill/abcdefghij', JSON.stringify({ id: 'abcdefghij', n: 1 }));
    if (!(await real.getWithMetadata('bill/abcdefghij')).etag) {
      await assert.rejects(createBlobStore(real).update('abcdefghij', (b) => { b.n = 2; }), /no etag/);
      assert.equal(JSON.parse(await real.get('bill/abcdefghij')).n, 1);
    }
    await bs.stop();
    console.log('passed: real @netlify/blobs onlyIfMatch (local server)');
  }
  console.log('All checks passed');
  server.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
