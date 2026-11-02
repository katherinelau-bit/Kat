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
    dump() { return [...m.entries()].map(([k, v]) => k + ' ' + v.data).join('\n'); },
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
  const claim1 = await call('POST', '/api/bills/' + id + '/join', { memberId: haf });
  assert.equal(claim1.status, 200);
  assert.equal((await call('POST', '/api/bills/' + id + '/join', { memberId: haf })).status, 409, 'cannot claim twice');
  // Someone claimed Hafiz by mistake: "Not you? Switch person" releases the name, and the old login stops working.
  assert.equal((await call('POST', '/api/bills/' + id + '/leave', null, claim1.body.token)).status, 200);
  assert.equal((await call('POST', '/api/bills/' + id + '/auth', null, claim1.body.token)).status, 401);
  assert.equal((await call('POST', '/api/bills/' + id + '/leave', null, owner)).status, 400, 'the payer cannot leave');
  // Claimed by the wrong person again: the payer resets the name; friends cannot.
  const claim2 = await call('POST', '/api/bills/' + id + '/join', { memberId: haf });
  assert.equal(claim2.status, 200);
  assert.equal((await call('POST', `/api/bills/${id}/members/${haf}/reset`, null, wj.token)).status, 403);
  assert.equal((await call('POST', `/api/bills/${id}/members/${payer}/reset`, null, owner)).status, 400);
  r = await call('POST', `/api/bills/${id}/members/${haf}/reset`, null, owner);
  assert.equal(r.body.bill.members.find((x) => x.id === haf).claimed, false);
  assert.equal((await call('POST', '/api/bills/' + id + '/auth', null, claim2.body.token)).status, 401);
  assert.equal((await call('POST', '/api/bills/' + id + '/join', { memberId: haf })).status, 200, 'the real Hafiz can claim again');
  assert.equal((await call('DELETE', `/api/bills/${id}/members/${payer}`, null, owner)).status, 400);
  assert.equal((await call('DELETE', `/api/bills/${id}/members/${priya}`, null, owner)).status, 200);

  // The payer edits the bill: rename and reprice a dish, drop one, add one. Ticks stay on kept dishes,
  // the dropped dish leaves Wei Jie's picks, and his unconfirmed slip follows his new share.
  r = await call('GET', '/api/bills/' + id, null, owner);
  const edit = r.body.bill.items.filter((i) => i.id !== 'i3').map((i) => (i.id === 'i2' ? { ...i, name: 'Mee goreng mamak', price: 1000 } : i));
  edit.push({ name: 'Keropok', qty: 1, price: 500 });
  const editBody = { title: 'Test dinner (fixed)', date: '2026-10-30', items: edit, service: 505, sst: 333, rounding: 2 };
  assert.equal((await call('PUT', '/api/bills/' + id, editBody, wj.token)).status, 403, 'only the payer edits');
  assert.equal((await call('PUT', '/api/bills/' + id, { ...editBody, items: [] }, owner)).status, 400);
  r = await call('PUT', '/api/bills/' + id, editBody, owner);
  assert.equal(r.status, 200);
  const eb = r.body.bill;
  assert.deepEqual(eb.items.map((i) => i.id + ':' + i.name + ':' + i.price), ['i1:Nasi lemak:1350', 'i2:Mee goreng mamak:1000', 'i4:Teh tarik:840', 'i5:Ais kopi:320', 'i6:Maggi goreng:850', 'i7:Sirap bandung:350', 'i8:Keropok:500']);
  assert.deepEqual([eb.title, eb.date, typeof eb.editedAt], ['Test dinner (fixed)', '2026-10-30', 'number']);
  const wjNow = eb.members.find((x) => x.id === wj.memberId);
  assert.deepEqual(wjNow.picks, ['i2', 'i5']);
  assert.equal(wjNow.pay.status, 'sent');
  assert.equal(wjNow.pay.amount, Split.calc(eb).per[wj.memberId].total);

  // The payer changes the DuitNow QR after creating the bill; friends cannot.
  const QR2 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.alloc(60, 2)]).toString('base64');
  assert.equal((await call('POST', '/api/bills/' + id + '/qr', { image: QR2 }, wj.token)).status, 403);
  assert.equal((await call('POST', '/api/bills/' + id + '/qr', { image: 'bm90LWpwZWc=' }, owner)).status, 400);
  r = await call('POST', '/api/bills/' + id + '/qr', { image: QR2 }, owner);
  assert.equal(r.status, 200); assert.equal(r.body.bill.hasQr, true); assert.equal(typeof r.body.bill.qrAt, 'number');
  assert.equal((await call('GET', '/api/bills/' + id + '/img/qr')).body.length, 64);

  assert.equal((await call('DELETE', '/api/bills/' + id, null, wj.token)).status, 403);
  assert.equal((await call('DELETE', '/api/bills/' + id, null, owner)).status, 200);
  assert.equal((await call('GET', '/api/bills/' + id)).status, 404);
  assert.equal((await call('GET', '/api/bills/' + id + '/img/qr')).status, 404);
  assert.equal((await call('GET', '/api/bills/' + 'x'.repeat(10))).status, 404);
  assert.equal((await call('POST', '/api/scan', { image: JPEG })).status, 501);
  console.log('passed:', name);
}

function receiptParsing() {
  const { parse } = require('./public/receipt-parse.js');
  const pick = (r) => r.items.map((i) => `${i.qty}|${i.name}|${i.line}`);

  // "qty x name  amount" lines, Malaysian charges, negative rounding
  let r = parse(`RESTORAN NASI KANDAR SELERA
Jalan SS2/24, Petaling Jaya
Date: 30/10/2026  Time: 20:14
----------------------------
2 x Roti Canai          4.40
1 x Nasi Lemak Ayam    13.50
1 x Mee Goreng Mamak    9.00
3 x Teh Tarik           8.40
1 x Milo Ais            4.20
1 x Maggi Goreng        8.50
----------------------------
Subtotal               48.00
Service Charge 10%      4.80
SST 6%                  3.17
Rounding               -0.02
TOTAL (RM)             55.95
Cash                   60.00
Change                  4.05`);
  assert.deepEqual(pick(r), ['2|Roti Canai|440', '1|Nasi Lemak Ayam|1350', '1|Mee Goreng Mamak|900', '3|Teh Tarik|840', '1|Milo Ais|420', '1|Maggi Goreng|850']);
  assert.equal(r.items[0].each, 220);
  assert.deepEqual([r.service, r.sst, r.rounding, r.total, r.date, r.merchant], [480, 317, -2, 5595, '2026-10-30', 'RESTORAN NASI KANDAR SELERA']);

  // column receipts: name, qty, unit price, amount; tax codes; Malay labels; "Service Tax" is SST
  r = parse(`Kopitiam Ah Seng Sdn Bhd
2026-07-12 13:05
Char Kuey Teow   2   9.50   19.00 SR
Kopi O Peng      1   2.80    2.80 SR
Wantan Mee       3 @ 8.00   24.00
Jumlah Kecil            45.80
Caj Perkhidmatan 10%     4.58
Service Tax 6%           3.02
Pembundaran              0.00
Jumlah                  53.40`);
  assert.deepEqual(pick(r), ['2|Char Kuey Teow|1900', '1|Kopi O Peng|280', '3|Wantan Mee|2400']);
  assert.deepEqual([r.service, r.sst, r.total, r.date], [458, 302, 5340, '2026-07-12']);

  // OCR noise: O for 0, item split over two lines, item codes, "Name x2", card payment lines ignored
  r = parse(`MAMAK CORNER
A102 Ayam Goreng Berempah
  2 x 7.5O      15.00
Nasi Putih x2   4.OO
Teh O Ais       2.20
Total          21.20
VISA ****1234  21.20`);
  assert.deepEqual(pick(r), ['2|Ayam Goreng Berempah|1500', '2|Nasi Putih|400', '1|Teh O Ais|220']);
  assert.equal(r.total, 2120);
  assert.deepEqual(parse('').items, []);
  assert.deepEqual(pick(parse('Kopi O Peng 3 280   8.40')), ['3|Kopi O Peng|840'], 'unit price that lost its decimal point');

  // A real photo (orange thermal paper, curled, a finger over the corner), exactly as Tesseract read it:
  // lost decimal points, clipped labels, menu codes, names over two lines, "(8.90/ea)" prices of one, add-on lines.
  // The first dish's price was unreadable: it gets what is left of the printed subtotal, so the bill tallies.
  const orange = String.raw`;          bh CSMRERESE TT         Price (MYR)
| EO1 Thal Halnanese Chicken Rice.    FE        90
(8.90/ea)
® + Thigh + 1.00
X04 CHARCOAL GRILLED CHARSIU                10.00
(100g (small) (10.00/ea)
|    1     E09 Shunde-Style Steamed Pork Ribs             1590
|      Rice (15.90/ea)
P72 E01 Thal Halnanese Chicken Rice             17 80
(8.90/ea)
2     F01 Fried Basll Minced Pork Rice (-)                33.80
(16.90/ea)
1     WO2 Ice Thal Green Milk Tea (7.90/                 7.90
ea)
2 WO1 Ice Classic Thal Milk Tea (7.90/             15.80
ea)
1 Z03Bralsed Tofu (4 90/ea)                            490
|    1 W04 Ice Honey Lemon Juice (7.90/                7 90
ea)
rE            W07 Ice Chrysanthemum Flower                        790
Ellice (7.90/ea)
pd M02 THAI HAINANESE CHICKEN               30.00
EE                 alf) (Takeaway) (30.00/ea)
4                TA
                 01 Fried Basll Minced Pork Rice (-)                16 90
i                       fakeaway) (16.90/ea)
TA
13 Thal Crispy Pork Rice (Takeaway)               10:90
0.90/ea)
TA                                               )
D06 Chicken Rice (Takeaway) (2.00/              2.00
)
TA
total                                 191 60
ST (6%)                                11.50
RVICE CHARGE (10%)                              1318
rounding                                             0.02
al (MYR)                            216.30
ve                                          216.30 |
nge                                         0.00
“NEE                                    en
imma YS            Base Amt.    Amount
a NR
fil bedi Bi Gis Sh a 131.80     13.18  |
AEE Er REL BR VT      ig`;
  const orangeItems = ['1|Thal Halnanese Chicken Rice|990', '1|CHARCOAL GRILLED CHARSIU|1000', '1|Shunde-Style Steamed Pork Ribs Rice|1590', '2|Thal Halnanese Chicken Rice|1780',
    '2|Fried Basll Minced Pork Rice|3380', '1|Ice Thal Green Milk Tea|790', '2|Ice Classic Thal Milk Tea|1580', '1|Bralsed Tofu|490',
    '1|Ice Honey Lemon Juice|790', '1|Ice Chrysanthemum Flower Ellice|790', '1|THAI HAINANESE CHICKEN|3000', '1|Fried Basll Minced Pork Rice|1690',
    '1|Thal Crispy Pork Rice (Takeaway)|1090', '1|Chicken Rice (Takeaway)|200'];
  const tally = (x) => x.items.reduce((a, i) => a + i.line, 0) + x.service + x.sst + x.rounding;
  r = parse(orange);
  assert.deepEqual(pick(r), orangeItems);
  assert.deepEqual([r.service, r.sst, r.rounding, r.total, r.merchant, r.filled, tally(r)], [1318, 1150, 2, 21630, '', 1, 21630]);

  // Rounding line unreadable too: it is worked out from subtotal + charges vs the total.
  r = parse(orange.replace(/rounding\s+0\.02\n/, ''));
  assert.deepEqual(pick(r), orangeItems);
  assert.deepEqual([r.rounding, tally(r)], [2, 21630]);

  // A gap that no unpriced dish explains becomes one "Item not read" line, so the bill still tallies.
  r = parse('Nasi Lemak  13.50\nTeh Tarik  2.80\nSubtotal  21.30\nSST 6%  1.28\nTotal  22.58');
  assert.deepEqual(pick(r), ['1|Nasi Lemak|1350', '1|Teh Tarik|280', '1|Item not read (check receipt)|500']);
  assert.equal(tally(r), 2258);

  // A total nothing confirms (no subtotal, no matching payment) is not trusted: nothing is invented.
  r = parse('Nasi Lemak  13.50\nTeh Tarik  2.80\nTotal  22.58');
  assert.deepEqual(pick(r), ['1|Nasi Lemak|1350', '1|Teh Tarik|280']);
  assert.equal(r.filled, 0);

  // A photo tilted 3 degrees where the reader split the price column into separate lines:
  // rebuilding rows from word positions puts each price back next to its item.
  const { rowsFromBlocks, best, balanced } = require('./public/receipt-parse.js');
  const k = Math.tan(3 * Math.PI / 180), word = (text, x, row) => ({ text, bbox: { x0: x, x1: x + 20 * text.length, y0: 100 + row * 50 + k * x, y1: 130 + row * 50 + k * x } });
  const rows = [['Roti', 'Canai'], ['Teh', 'Tarik'], ['SST', '6%'], ['TOTAL']];
  const prices = ['4.40', '8.40', '0.77', '13.57'];
  const blocks = [{ paragraphs: [
    { lines: rows.map((ws, i) => ({ baseline: { x0: 40, y0: 130 + i * 50 + k * 40, x1: 400, y1: 130 + i * 50 + k * 400 }, words: ws.map((t, j) => word(t, 40 + j * 120, i)) })) },
    { lines: prices.map((t, i) => ({ baseline: { x0: 900, y0: 0, x1: 980, y1: 0 }, words: [word(t, 900, i)] })) }] }];
  assert.equal(rowsFromBlocks(blocks), 'Roti Canai 4.40\nTeh Tarik 8.40\nSST 6% 0.77\nTOTAL 13.57');
  const split = parse('Roti Canai\nTeh Tarik\nSST 6%\nTOTAL\n4.40\n8.40\n0.77\n13.57'), joined = parse(rowsFromBlocks(blocks));
  assert.equal(best([null, split, joined]), joined);
  assert.ok(balanced(joined) && !balanced(split));
  console.log('passed: receipt text parsing');

  // Payment slips: the amount sent, not the balance, fee or limit next to it.
  const { slipAmounts, checkSlip } = require('./public/receipt-parse.js');
  const maybank = `Maybank2u\nTransfer Successful\nDuitNow Transfer\nRecipient's Name KATHERINE LAU\nAmount RM 25.40\nService Charge RM 0.00\nReference ID 2026103112345\nAvailable Balance RM 1,234.56`;
  assert.deepEqual(slipAmounts(maybank), [2540]);
  assert.deepEqual(checkSlip(maybank, 2540), { result: 'match', amount: 2540 });
  assert.deepEqual(checkSlip(maybank, 3000), { result: 'mismatch', amount: 2540 });
  assert.deepEqual(checkSlip('CIMB Clicks\nTransfer to KATHERINE\nAmount\nMYR 1,025.00\nStatus: Successful', 102500).result, 'match');
  assert.deepEqual(checkSlip('Touch n Go eWallet\nPayment successful\n-RM25.4O\nWallet balance RM 80.10', 2540).result, 'match', 'TNG with an O for a 0');
  assert.deepEqual(checkSlip('Thank you\nRef 123456', 2540), { result: 'unread', amount: 0 });
  console.log('passed: payment slip amounts');
}

// Real receipt photos that used to read badly, exactly as the phone reader saw them after the photo clean-up
// (test-receipts.json). Each must give every dish's price and add up to the printed total to the sen.
function realReceipts() {
  const { parse } = require('./public/receipt-parse.js');
  for (const c of require('./test-receipts.json')) {
    const r = parse(c.text);
    assert.deepEqual(r.items.map((i) => i.line), c.lines, c.receipt);
    assert.ok(r.items.every((i) => /[A-Za-z]{3}/.test(i.name)), c.receipt + ': dish names');
    if (c.sst !== undefined) assert.equal(r.sst, c.sst, c.receipt + ': SST from its printed rate');
    if (c.total) {
      assert.equal(r.total, c.total, c.receipt);
      assert.equal(r.items.reduce((a, i) => a + i.line, 0) + r.service + r.sst + r.rounding, c.total, c.receipt + ': adds up');
    }
  }
  console.log('passed: real receipts');
}

// Photo clean-up: tilt from the reader's baselines, and black and white that keeps print but drops a shadow.
function photoCleanup() {
  const { tilt, binarize } = require('./public/receipt-parse.js');
  const line = (y0, y1) => ({ baseline: { x0: 0, x1: 1000, y0, y1 } });
  assert.ok(Math.abs(tilt([{ paragraphs: [{ lines: [line(100, 260), line(300, 460), line(500, 650), line(0, 5)] }] }]) - Math.atan(0.16)) < 1e-9);
  assert.equal(tilt([]), 0);
  // White paper whose right half is in shadow (grey 110), with one black dot in the light half and one in the shadow.
  const W = 200, H = 100, data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = x < 100 ? 245 : 110;
    if (Math.hypot(x - 50, y - 50) < 3) v = 20;
    if (Math.hypot(x - 150, y - 50) < 3) v = 40;
    data.set([v, v, v, 255], (y * W + x) * 4);
  }
  const px = (x, y) => data[(y * W + x) * 4];
  binarize({ data, width: W, height: H });
  assert.deepEqual([px(50, 50), px(150, 50), px(20, 20), px(170, 80)], [0, 0, 255, 255]);
  console.log('passed: photo clean-up');
}

// Linking devices: how two copies of "my bills and trips" merge.
function syncMerge() {
  const { merge, sameList } = require('./public/sync.js');
  const e = (token, at, title = 'x') => ({ token, memberId: 'm1', title, at });
  // Both sides' bills and trips are kept; for the same bill the newer entry wins; the newer name wins.
  let m = merge({ bills: { aaaa: e('11', 10) }, name: 'Kat', nameAt: 5 }, { bills: { aaaa: e('22', 20), bbbb: e('33', 1) }, trips: { tttt: e('44', 1) }, name: 'Katherine', nameAt: 9 });
  assert.deepEqual(Object.keys(m.bills).sort(), ['aaaa', 'bbbb']);
  assert.equal(m.bills.aaaa.token, '22');
  assert.deepEqual([Object.keys(m.trips), m.name, m.nameAt], [['tttt'], 'Katherine', 9]);
  // Left or deleted on one device: gone from the merged list, even though the other device still has it...
  m = merge({ bills: {}, gone: { 'b:aaaa': 30 } }, { bills: { aaaa: e('22', 20) } });
  assert.deepEqual(m.bills, {});
  assert.equal(m.gone['b:aaaa'], 30);
  // ...unless it was joined again after that.
  m = merge(m, { bills: { aaaa: e('55', 40) } });
  assert.equal(m.bills.aaaa.token, '55');
  // A trip id never removes a bill with the same id.
  assert.ok(merge({ gone: { 't:aaaa': 99 } }, { bills: { aaaa: e('1', 1) } }).bills.aaaa);
  assert.ok(sameList({ bills: { aaaa: e('1', 1, 'A') } }, { bills: { aaaa: e('1', 7, 'B') } }), 'titles and times do not count');
  assert.ok(!sameList({ bills: { aaaa: e('1', 1) } }, { bills: {} }));
  console.log('passed: device sync merging');
}

// Linking devices through the API: devices sharing a key see each other's bills and trips; turning it off is final.
async function syncSuite(name, call, dump) {
  const key = 'k'.repeat(10) + require('node:crypto').randomBytes(24).toString('base64url');
  const tok = (c) => c.repeat(48);
  const entry = (t, at) => ({ token: tok(t), memberId: 'abcd1234', title: 'Dinner', at });
  assert.equal((await call('PUT', '/api/sync', {}, 'short')).status, 400);
  // Laptop sends its bill; the phone sends its trip and name, and gets both back.
  let r = await call('PUT', '/api/sync', { bills: { bill0001: entry('a', 1000) }, gone: {} }, key);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body.bills), ['bill0001']);
  r = await call('PUT', '/api/sync', { trips: { trip0001: entry('b', 1100) }, name: 'Katherine', nameAt: 1100 }, key);
  assert.deepEqual([Object.keys(r.body.bills), Object.keys(r.body.trips), r.body.name], [['bill0001'], ['trip0001'], 'Katherine']);
  assert.equal(r.body.bills.bill0001.token, tok('a'));
  // Malformed entries are dropped, not stored.
  r = await call('PUT', '/api/sync', { bills: { 'BAD ID': entry('c', 1), bill0002: { token: '<script>', at: 1 } } }, key);
  assert.deepEqual(Object.keys(r.body.bills), ['bill0001']);
  // The laptop leaves the bill; the phone, which still lists it, then loses it too.
  await call('PUT', '/api/sync', { gone: { 'b:bill0001': 2000 } }, key);
  r = await call('PUT', '/api/sync', { bills: { bill0001: entry('a', 1000) }, trips: { trip0001: entry('b', 1100) } }, key);
  assert.deepEqual([Object.keys(r.body.bills), Object.keys(r.body.trips)], [[], ['trip0001']]);
  // Two devices syncing at the same moment both end up in the list.
  const both = await Promise.all([call('PUT', '/api/sync', { bills: { bill0003: entry('d', 3000) } }, key), call('PUT', '/api/sync', { bills: { bill0004: entry('e', 3000) } }, key)]);
  assert.ok(both.every((x) => x.status === 200));
  r = await call('PUT', '/api/sync', {}, key);
  assert.deepEqual(Object.keys(r.body.bills).sort(), ['bill0003', 'bill0004']);
  // Another key sees nothing of this one, and the stored list never contains the key itself.
  r = await call('PUT', '/api/sync', {}, 'z'.repeat(43));
  assert.deepEqual([r.body.bills, r.body.trips], [{}, {}]);
  if (dump) assert.ok(!dump().includes(key), 'sync key stored in plain form');
  // Turned off everywhere: every device holding the key is told, and it cannot be filled again.
  assert.equal((await call('DELETE', '/api/sync', null, key)).status, 200);
  r = await call('PUT', '/api/sync', { bills: { bill0005: entry('f', 5000) } }, key);
  assert.equal(r.status, 410);
  console.log('passed: device sync, ' + name);
}

// Trip maths: shares, balances that always add up to zero, and settle-up transfers.
function tripMaths() {
  const Settle = require('./public/settle.js');
  assert.deepEqual(Settle.shares({ amount: 1000, mode: 'equal', among: ['c', 'a', 'b'] }), { a: 334, b: 333, c: 333 });
  assert.deepEqual(Settle.shares({ amount: 1000, mode: 'exact', among: ['a', 'b'], shares: { a: 700, b: 300 } }), { a: 700, b: 300 });
  // Penang weekend: Aisha pays the hotel for all four, Ben pays dinner for three, Chen pays Grab for two.
  const trip = { members: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], expenses: [
    { paidBy: 'a', amount: 40000, mode: 'equal', among: ['a', 'b', 'c', 'd'] },
    { paidBy: 'b', amount: 9000, mode: 'equal', among: ['a', 'b', 'c'] },
    { paidBy: 'c', amount: 2500, mode: 'exact', among: ['c', 'd'], shares: { c: 1000, d: 1500 } }], payments: [] };
  let bal = Settle.balances(trip);
  assert.deepEqual(Object.fromEntries(Object.entries(bal).map(([k, v]) => [k, v.net])), { a: 27000, b: -4000, c: -11500, d: -11500 });
  assert.equal(Object.values(bal).reduce((s, v) => s + v.net, 0), 0);
  let tr = Settle.transfers(bal);
  assert.deepEqual(tr, [{ from: 'c', to: 'a', amount: 11500 }, { from: 'd', to: 'a', amount: 11500 }, { from: 'b', to: 'a', amount: 4000 }]);
  assert.equal(Settle.total(trip), 51500);
  // Once Chen's payment (slip sent) is in, Chen no longer appears and the rest is unchanged.
  trip.payments = [{ from: 'c', to: 'a', amount: 11500 }];
  tr = Settle.transfers(Settle.balances(trip));
  assert.deepEqual(tr, [{ from: 'd', to: 'a', amount: 11500 }, { from: 'b', to: 'a', amount: 4000 }]);
  // Two creditors, uneven amounts: everything still clears exactly.
  const t2 = { members: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], expenses: [{ paidBy: 'a', amount: 1001, mode: 'equal', among: ['a', 'b', 'c'] }, { paidBy: 'b', amount: 500, mode: 'equal', among: ['a', 'b', 'c'] }], payments: [] };
  const b2 = Settle.balances(t2), tr2 = Settle.transfers(b2);
  const after = { ...Object.fromEntries(Object.entries(b2).map(([k, v]) => [k, v.net])) };
  tr2.forEach((x) => { after[x.from] += x.amount; after[x.to] -= x.amount; });
  assert.deepEqual(Object.values(after), [0, 0, 0]);
  assert.ok(tr2.length <= 2);
  // Split by items: each person's dishes plus their part of service charge and SST; unpicked dishes stay with the payer.
  const meal = { paidBy: 'a', amount: 5830, mode: 'items', service: 500, sst: 330, rounding: 0, items: [{ id: 'i1', name: 'Nasi lemak', qty: 1, price: 2000 }, { id: 'i2', name: 'Teh tarik', qty: 2, price: 1000 }, { id: 'i3', name: 'Satay', qty: 1, price: 2000 }],
    picks: { b: ['i1'], c: ['i2'], a: ['i2'] } };
  const ms = Settle.shares(meal);
  assert.equal(Object.values(ms).reduce((x, y) => x + y, 0), 5830, 'shares add up to the receipt');
  assert.deepEqual(ms, { b: 2332, c: 583, a: 583 + 2332 }, 'Satay was not picked, so it stays with Aisha who paid');
  assert.equal(Settle.itemsCalc(meal).unclaimed.items.map((i) => i.name).join(), 'Satay');
  console.log('passed: trip settle-up maths');
}

// "Notify me when someone pays": only the payer subscribes, a slip notifies their phones, unsubscribed phones are dropped.
async function pushNotifications() {
  const sent = [];
  const fake = { publicKey: async () => 'PUBKEY', send: async (sub, payload) => { sent.push({ to: sub.endpoint, payload }); return { gone: sub.endpoint.includes('/gone') }; } };
  const handle = createApi({ store: createBlobStore(fakeBlobs()), push: fake });
  const call = async (method, url, body, token) => {
    const r = await handle(new Request('https://example.test' + url, { method, headers: { 'content-type': 'application/json', 'x-token': token || '' }, body: body ? JSON.stringify(body) : undefined }));
    return { status: r.status, body: await r.json() };
  };
  const sub = (name) => ({ endpoint: 'https://push.example/' + name, keys: { p256dh: 'BKeyKeyKey', auth: 'authauth' } });
  assert.deepEqual((await call('GET', '/api/push/key')).body, { key: 'PUBKEY' });
  assert.equal((await call('GET', '/api/config')).body.push, true);
  const c = (await call('POST', '/api/bills', { title: 'Thai Blessing', payerName: 'Katherine', items: [{ name: 'Rice', qty: 1, price: 2540 }] })).body;
  const f = (await call('POST', `/api/bills/${c.id}/join`, { name: 'Victor' })).body;
  await call('PUT', `/api/bills/${c.id}/picks`, { itemIds: ['i1'] }, f.token);
  assert.equal((await call('POST', `/api/bills/${c.id}/push`, { subscription: sub('phone') }, f.token)).status, 403, 'only the payer');
  assert.equal((await call('POST', `/api/bills/${c.id}/push`, { subscription: { endpoint: 'http://x' } }, c.token)).status, 400);
  await call('POST', `/api/bills/${c.id}/push`, { subscription: sub('phone') }, c.token);
  let r = await call('POST', `/api/bills/${c.id}/push`, { subscription: sub('gone') }, c.token);
  assert.equal(r.body.bill.notify, true);
  assert.equal(JSON.stringify(r.body).includes('push.example'), false, 'subscriptions stay on the server');
  assert.equal((await call('GET', `/api/bills/${c.id}`, null, f.token)).body.bill.notify, false);
  const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]).toString('base64');
  await call('POST', `/api/bills/${c.id}/slip`, { image: JPG }, f.token);
  assert.deepEqual(sent.map((s) => s.to), ['https://push.example/phone', 'https://push.example/gone']);
  assert.deepEqual(sent[0].payload, { title: 'Victor sent RM 25.40', body: 'Thai Blessing: tap to check the slip and confirm', url: '/b/' + c.id, tag: 'slip-' + c.id + '-' + f.memberId });
  sent.length = 0;
  await call('POST', `/api/bills/${c.id}/slip`, { image: JPG }, f.token);
  assert.deepEqual(sent.map((s) => s.to), ['https://push.example/phone'], 'the unsubscribed phone was forgotten');
  r = await call('DELETE', `/api/bills/${c.id}/push`, { endpoint: 'https://push.example/phone' }, c.token);
  assert.equal(r.body.bill.notify, false);

  // Trips: whoever is being paid gets the notification.
  const fb2 = fakeBlobs(), th = createApi({ store: createBlobStore(fb2), trips: createBlobStore(fb2, 'trip/'), push: fake });
  const tcall = async (method, url, body, token) => (await th(new Request('https://example.test' + url, { method, headers: { 'content-type': 'application/json', 'x-token': token || '' }, body: body ? JSON.stringify(body) : undefined }))).json();
  const tr = await tcall('POST', '/api/trips', { title: 'Penang weekend', name: 'Aisha' });
  const chen = await tcall('POST', `/api/trips/${tr.id}/join`, { name: 'Chen' });
  assert.equal((await tcall('POST', `/api/trips/${tr.id}/push`, { subscription: sub('aisha') }, tr.token)).trip.notify, true);
  sent.length = 0;
  await tcall('POST', `/api/trips/${tr.id}/payments`, { to: tr.memberId, amount: 11500 }, chen.token);
  assert.deepEqual(sent.map((s) => [s.to, s.payload.title, s.payload.url]), [['https://push.example/aisha', 'Chen sent you RM 115.00', '/t/' + tr.id]]);

  // The real sender makes its keys once and keeps them in the store.
  const { createPush } = require('./lib/push.js');
  const kept = new Map(), st = { getImg: async (k) => kept.get(k) || null, putImg: async (k, v) => { kept.set(k, v); } };
  const key1 = await createPush(st).publicKey(), key2 = await createPush(st).publicKey();
  assert.ok(/^[A-Za-z0-9_-]{80,}$/.test(key1)); assert.equal(key1, key2);

  // Our own Web Push encryption and VAPID signature, checked against the reference implementation when it is installed.
  const { encrypt, vapidAuth, generateKeys } = require('./lib/push.js');
  const nodeCrypto = require('node:crypto');
  const phone = nodeCrypto.createECDH('prime256v1'); phone.generateKeys();
  const auth = nodeCrypto.randomBytes(16), msg = JSON.stringify({ title: 'Victor sent RM 25.40' });
  const box = encrypt({ keys: { p256dh: phone.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } }, msg);
  let ece = null; try { ece = require('http_ece'); } catch (e) {}
  if (ece) assert.equal(ece.decrypt(box, { version: 'aes128gcm', privateKey: phone, authSecret: auth.toString('base64url') }).toString(), msg);
  const vk = generateKeys(), hdr = vapidAuth('https://fcm.googleapis.com/fcm/send/abc', vk, 'https://bei-cin-lah.netlify.app');
  const [, jwt, k] = hdr.match(/^vapid t=([^,]+), k=(.+)$/), [h64, b64, s64] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(b64, 'base64url'));
  assert.deepEqual([k, claims.aud, claims.sub], [vk.publicKey, 'https://fcm.googleapis.com', 'https://bei-cin-lah.netlify.app']);
  const pub = Buffer.from(vk.publicKey, 'base64url');
  const pubKey = nodeCrypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
  assert.ok(nodeCrypto.verify('sha256', Buffer.from(h64 + '.' + b64), { key: pubKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s64, 'base64url')));
  console.log('passed: payment notifications' + (ece ? ' (encryption checked against http_ece)' : ''));
}

// A trip from start to finish: join, add expenses, who may change what, then settle up until nobody owes anything.
async function tripSuite(name, call) {
  const Settle = require('./public/settle.js');
  const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]).toString('base64');
  const nets = (t) => { const b = Settle.balances(t); return t.members.map((x) => b[x.id].net); };
  let r = await call('POST', '/api/trips', { title: 'Penang weekend', name: 'Aisha' });
  assert.equal(r.status, 200);
  const { id, token: aT, memberId: a } = r.body;
  const B = (await call('POST', `/api/trips/${id}/join`, { name: 'Ben' })).body;
  const C = (await call('POST', `/api/trips/${id}/join`, { name: 'Chen' })).body;
  assert.equal((await call('POST', `/api/trips/${id}/members`, { name: 'Dina' })).status, 401, 'strangers cannot add people');
  const d = (await call('POST', `/api/trips/${id}/members`, { name: 'Dina' }, B.token)).body.memberId;
  const D = (await call('POST', `/api/trips/${id}/join`, { memberId: d })).body;
  assert.equal(D.memberId, d);
  const all = [a, B.memberId, C.memberId, d];

  // Expenses: hotel for all four (with receipt), dinner for three, Grab split by exact amounts.
  r = await call('POST', `/api/trips/${id}/expenses`, { title: 'Hotel', date: '2026-11-01', paidBy: a, amount: 40000, mode: 'equal', among: all, receipt: JPG }, aT);
  assert.equal(r.status, 200); assert.equal(r.body.expenseId, 'e1');
  r = await call('POST', `/api/trips/${id}/expenses`, { title: 'Dinner', paidBy: B.memberId, amount: 9000, among: [a, B.memberId, C.memberId] }, B.token);
  assert.equal(r.body.expenseId, 'e2');
  assert.equal((await call('POST', `/api/trips/${id}/expenses`, { title: 'Grab', paidBy: C.memberId, amount: 2500, mode: 'exact', among: [C.memberId, d], shares: { [C.memberId]: 1000, [d]: 1000 } }, C.token)).status, 400, 'exact shares must add up');
  assert.equal((await call('POST', `/api/trips/${id}/expenses`, { title: 'Grab', paidBy: 'nobody123', amount: 2500, among: all }, C.token)).status, 400);
  assert.equal((await call('POST', `/api/trips/${id}/expenses`, { title: 'Grab', paidBy: C.memberId, amount: 2500, among: all })).status, 401);
  r = await call('POST', `/api/trips/${id}/expenses`, { title: 'Grab', paidBy: C.memberId, amount: 2500, mode: 'exact', among: [C.memberId, d], shares: { [C.memberId]: 1000, [d]: 1500 } }, C.token);
  assert.equal(r.status, 200);
  assert.equal((await call('GET', `/api/trips/${id}/img/receipt/e1`)).body.length, 44);

  // Only whoever added an expense, or the trip's maker, can change it.
  assert.equal((await call('PUT', `/api/trips/${id}/expenses/e1`, { title: 'Hotel', paidBy: a, amount: 1, among: all }, B.token)).status, 403);
  assert.equal((await call('PUT', `/api/trips/${id}/expenses/e3`, { title: 'Grab to Batu Ferringhi', paidBy: C.memberId, amount: 2500, mode: 'exact', among: [C.memberId, d], shares: { [C.memberId]: 1000, [d]: 1500 } }, aT)).status, 200);

  let t = (await call('GET', `/api/trips/${id}`)).body.trip;
  assert.equal(JSON.stringify(t).includes(aT), false, 'tokens never leave the server');
  assert.equal(t.expenses[2].title, 'Grab to Batu Ferringhi');
  assert.deepEqual(nets(t), [27000, -4000, -11500, -11500]);
  // Chen and Dina owe the same, so their order follows their (random) ids; compare without order.
  assert.deepEqual(Settle.transfers(Settle.balances(t)).map((x) => [x.from, x.to, x.amount].join()).sort(), [[C.memberId, a, 11500], [d, a, 11500], [B.memberId, a, 4000]].map((x) => x.join()).sort());

  // QR: each person adds their own.
  assert.equal((await call('POST', `/api/trips/${id}/qr`, { image: JPG }, aT)).body.trip.members[0].hasQr, true);
  assert.equal((await call('GET', `/api/trips/${id}/img/qr/${a}`)).status, 200);

  // Chen pays Aisha with a slip; only the two of them see it; only Aisha confirms.
  r = await call('POST', `/api/trips/${id}/payments`, { to: a, amount: 11500, image: JPG }, C.token);
  const p1 = r.body.paymentId; t = r.body.trip;
  assert.deepEqual(t.payments.map((x) => [x.from, x.to, x.amount, x.status, x.hasSlip]), [[C.memberId, a, 11500, 'sent', true]]);
  assert.equal(Settle.transfers(Settle.balances(t)).some((x) => x.from === C.memberId), false, 'not asked to pay twice');
  assert.equal((await call('GET', `/api/trips/${id}/img/slip/${p1}`, null, aT)).status, 200);
  assert.equal((await call('GET', `/api/trips/${id}/img/slip/${p1}`, null, B.token)).status, 403);
  assert.equal((await call('GET', `/api/trips/${id}/img/slip/${p1}`)).status, 401);
  assert.equal((await call('POST', `/api/trips/${id}/payments/${p1}`, { action: 'confirm' }, B.token)).status, 403);
  assert.equal((await call('POST', `/api/trips/${id}/payments/${p1}`, { action: 'confirm' }, aT)).body.trip.payments[0].status, 'paid');

  // Dina pays cash: Aisha records it as received. Ben's first payment is rejected, then paid properly.
  r = await call('POST', `/api/trips/${id}/payments/received`, { from: d, amount: 11500 }, aT);
  assert.equal(r.body.trip.payments[1].status, 'paid');
  const p3 = (await call('POST', `/api/trips/${id}/payments`, { to: a, amount: 4000 }, B.token)).body.paymentId;
  r = await call('POST', `/api/trips/${id}/payments/${p3}`, { action: 'reject' }, aT);
  assert.equal(r.body.trip.payments.length, 2);
  assert.deepEqual(Settle.transfers(Settle.balances(r.body.trip)), [{ from: B.memberId, to: a, amount: 4000 }]);
  const p4 = (await call('POST', `/api/trips/${id}/payments`, { to: a, amount: 4000 }, B.token)).body.paymentId;
  t = (await call('POST', `/api/trips/${id}/payments/${p4}`, { action: 'confirm' }, aT)).body.trip;
  assert.deepEqual(nets(t), [0, 0, 0, 0]);
  assert.deepEqual(Settle.transfers(Settle.balances(t)), []);

  // People: someone in an expense cannot be removed; a new, unused person can.
  assert.equal((await call('DELETE', `/api/trips/${id}/members/${d}`, null, aT)).status, 400);
  const e = (await call('POST', `/api/trips/${id}/members`, { name: 'Eve' }, aT)).body.memberId;
  assert.equal((await call('DELETE', `/api/trips/${id}/members/${e}`, null, B.token)).status, 403);
  assert.equal((await call('DELETE', `/api/trips/${id}/members/${e}`, null, aT)).status, 200);
  assert.equal((await call('POST', `/api/trips/${id}/leave`, null, C.token)).status, 200);
  assert.equal((await call('POST', `/api/trips/${id}/auth`, null, C.token)).status, 401);

  // Deleting: an expense by whoever added it; the trip only by its maker.
  assert.equal((await call('DELETE', `/api/trips/${id}/expenses/e2`, null, D.token)).status, 403);
  assert.equal((await call('DELETE', `/api/trips/${id}/expenses/e2`, null, B.token)).body.trip.expenses.length, 2);
  assert.equal((await call('DELETE', `/api/trips/${id}`, null, B.token)).status, 403);
  assert.equal((await call('DELETE', `/api/trips/${id}`, null, aT)).status, 200);
  assert.equal((await call('GET', `/api/trips/${id}`)).status, 404);
  assert.equal((await call('GET', `/api/trips/${id}/img/qr/${a}`)).status, 404);
  console.log('passed: trips, ' + name);
}

// A trip meal split by items: everyone picks their own dishes; whoever added or paid can pick for others.
async function tripItemsSuite(name, call) {
  const Settle = require('./public/settle.js');
  const a = (await call('POST', '/api/trips', { title: 'Ipoh day trip', name: 'Aisha' })).body;
  const B = (await call('POST', `/api/trips/${a.id}/join`, { name: 'Ben' })).body;
  const C = (await call('POST', `/api/trips/${a.id}/join`, { name: 'Chen' })).body;
  const items = [{ name: 'Nasi lemak', qty: 1, price: 2000 }, { name: 'Teh tarik', qty: 2, price: 1000 }, { name: 'Satay', qty: 1, price: 2000 }];
  let r = await call('POST', `/api/trips/${a.id}/expenses`, { title: 'Lunch', paidBy: B.memberId, mode: 'items', items, service: 500, sst: 330, amount: 1 }, B.token);
  assert.equal(r.status, 200);
  let e = r.body.trip.expenses[0];
  assert.deepEqual([e.mode, e.amount, e.items.map((i) => i.id + ':' + i.price).join()], ['items', 5830, 'i1:2000,i2:1000,i3:2000'], 'the dishes and charges make the amount');
  const pick = (who, ids, memberId) => call('PUT', `/api/trips/${a.id}/expenses/${e.id}/picks`, { itemIds: ids, memberId }, who);
  await pick(C.token, ['i2']);
  assert.equal((await pick(C.token, ['i1'], a.memberId)).status, 403, 'Chen cannot pick for Aisha');
  await pick(B.token, ['i1'], a.memberId);
  r = await pick(B.token, ['i2', 'zz']);
  e = r.body.trip.expenses[0];
  assert.deepEqual(e.picks, { [C.memberId]: ['i2'], [a.memberId]: ['i1'], [B.memberId]: ['i2'] });
  let sh = Settle.shares(e);
  assert.equal(Object.values(sh).reduce((x, y) => x + y, 0), 5830);
  assert.deepEqual([sh[a.memberId], sh[B.memberId], sh[C.memberId]], [2332, 583 + 2332, 583], 'the unpicked satay stays with Ben, who paid');
  assert.equal((await call('PUT', `/api/trips/${a.id}/expenses/${e.id}/picks`, { itemIds: ['i1'] })).status, 401);

  // Editing the dishes keeps picks on dishes that stay; a removed dish comes off everyone.
  r = await call('PUT', `/api/trips/${a.id}/expenses/${e.id}`, { title: 'Lunch', paidBy: B.memberId, mode: 'items', items: [{ id: 'i1', name: 'Nasi lemak ayam', qty: 1, price: 2200 }, { id: 'i3', name: 'Satay', qty: 1, price: 2000 }], service: 420, sst: 0 }, B.token);
  e = r.body.trip.expenses[0];
  assert.deepEqual([e.amount, e.items.map((i) => i.id + ':' + i.name).join(), JSON.stringify(e.picks)], [4620, 'i1:Nasi lemak ayam,i3:Satay', JSON.stringify({ [a.memberId]: ['i1'] })]);
  // Switching to an equal split drops the dishes.
  r = await call('PUT', `/api/trips/${a.id}/expenses/${e.id}`, { title: 'Lunch', paidBy: B.memberId, mode: 'equal', amount: 4620, among: [a.memberId, B.memberId] }, B.token);
  e = r.body.trip.expenses[0];
  assert.deepEqual([e.mode, e.items, e.picks], ['equal', undefined, undefined]);
  assert.equal((await pick(B.token, ['i1'])).status, 400);
  await call('DELETE', `/api/trips/${a.id}`, null, a.token);
  console.log('passed: trip items, ' + name);
}

(async () => {
  receiptParsing();
  realReceipts();
  photoCleanup();
  tripMaths();
  syncMerge();
  await pushNotifications();
  await new Promise((r) => server.listen(0, r));
  const base = 'http://localhost:' + server.address().port;
  const viaHttp = async (method, url, body, token) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-token': token || '' }, body: body ? JSON.stringify(body) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  await suite('self-hosted server (SQLite)', viaHttp);
  await tripSuite('self-hosted server (SQLite)', viaHttp);
  await tripItemsSuite('self-hosted server (SQLite)', viaHttp);
  await syncSuite('self-hosted server (SQLite)', viaHttp, () => { const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(require('node:path').join(process.env.DATA_DIR, 'bei-cin-lah.db')); const t = d.prepare('SELECT id, data FROM syncs').all().map((x) => x.id + ' ' + x.data).join('\n'); d.close(); return t; });

  const fb = fakeBlobs();
  const handle = createApi({ store: createBlobStore(fb), trips: createBlobStore(fb, 'trip/'), syncs: createBlobStore(fb, 'sync/') });
  const viaFunction = async (method, url, body, token) => {
    const r = await handle(new Request('https://example.test' + url, { method, headers: { 'content-type': 'application/json', 'x-token': token || '' }, body: body ? JSON.stringify(body) : undefined }));
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  await suite('Netlify function (Blobs stand-in)', viaFunction);
  await tripSuite('Netlify function (Blobs stand-in)', viaFunction);
  await tripItemsSuite('Netlify function (Blobs stand-in)', viaFunction);
  await syncSuite('Netlify function (Blobs stand-in)', viaFunction, () => fb.dump());

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
