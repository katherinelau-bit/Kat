'use strict';
/*
 * Bei Cin Lah, self-hosted server. No npm packages needed: Node 22.13+ only.
 * Storage: one SQLite file. (On Netlify the same API runs as a function, see netlify/functions/api.mjs.)
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createApi, HttpError } = require('./lib/core.js');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUB = path.join(__dirname, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'bei-cin-lah.db'));
db.exec('PRAGMA journal_mode=WAL');
db.exec('CREATE TABLE IF NOT EXISTS bills(id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL)');
db.exec('CREATE TABLE IF NOT EXISTS images(key TEXT PRIMARY KEY, data TEXT NOT NULL)');
db.exec('CREATE TABLE IF NOT EXISTS trips(id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL)');
const q = {
  getBill: db.prepare('SELECT data FROM bills WHERE id=?'),
  putBill: db.prepare('INSERT INTO bills(id,data,created_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data'),
  delBill: db.prepare('DELETE FROM bills WHERE id=?'),
  getImg: db.prepare('SELECT data FROM images WHERE key=?'),
  putImg: db.prepare('INSERT OR REPLACE INTO images(key,data) VALUES(?,?)'),
  delImg: db.prepare('DELETE FROM images WHERE key=?'),
  getTrip: db.prepare('SELECT data FROM trips WHERE id=?'),
  putTrip: db.prepare('INSERT INTO trips(id,data,created_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data'),
  delTrip: db.prepare('DELETE FROM trips WHERE id=?'),
};
const store = {
  async getBill(id) { const r = q.getBill.get(id); return r ? JSON.parse(r.data) : null; },
  async putBill(b) { q.putBill.run(b.id, JSON.stringify(b), b.createdAt); },
  async delBill(id) { q.delBill.run(id); },
  // No await inside, so nothing else can run between the read and the write.
  async update(id, fn) {
    const r = q.getBill.get(id);
    if (!r) throw new HttpError(404, 'Bill not found');
    const b = JSON.parse(r.data), result = fn(b);
    q.putBill.run(b.id, JSON.stringify(b), b.createdAt);
    return { bill: b, result };
  },
  async getImg(key) { const r = q.getImg.get(key); return r ? r.data : null; },
  async putImg(key, data) { q.putImg.run(key, data); },
  async delImg(key) { q.delImg.run(key); },
};
// Trips use the same interface as bills (getBill/putBill/update...), stored in their own table.
const trips = {
  async getBill(id) { const r = q.getTrip.get(id); return r ? JSON.parse(r.data) : null; },
  async putBill(t) { q.putTrip.run(t.id, JSON.stringify(t), t.createdAt); },
  async delBill(id) { q.delTrip.run(id); },
  async update(id, fn) {
    const r = q.getTrip.get(id);
    if (!r) throw new HttpError(404, 'Trip not found');
    const t = JSON.parse(r.data), result = fn(t);
    q.putTrip.run(t.id, JSON.stringify(t), t.createdAt);
    return { bill: t, result };
  },
};
const handleApi = createApi({ store, trips, apiKey: process.env.ANTHROPIC_API_KEY || '', model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5' });

async function toRequest(req, url) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 3e6) throw new HttpError(413, 'Too large'); chunks.push(c); }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const hasBody = chunks.length && req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url.href, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.gz': 'application/gzip' };
function serveStatic(res, pathname) {
  const spa = pathname === '/' || pathname === '/new' || pathname === '/t/new' || /^\/b\/[a-z0-9]+(\/edit)?$/.test(pathname) || /^\/t\/[a-z0-9]+(\/add|\/[ex]\/[a-z0-9]+)?$/.test(pathname);
  const file = path.normalize(path.join(PUB, spa ? '/index.html' : pathname));
  if (!file.startsWith(PUB + path.sep)) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': spa ? 'no-cache' : 'public, max-age=300' });
    res.end(data);
  });
}

const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const server = http.createServer(async (req, res) => {
  res.setHeader('content-security-policy', CSP);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('x-frame-options', 'DENY');
  try {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    if (url.pathname.startsWith('/api/')) {
      const r = await handleApi(await toRequest(req, url));
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, Object.fromEntries(r.headers));
      return res.end(buf);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    return serveStatic(res, decodeURIComponent(url.pathname));
  } catch (e) {
    if (res.headersSent) return res.end();
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: status === 500 ? 'Something went wrong' : e.message }));
  }
});
if (require.main === module) server.listen(PORT, () => console.log('Bei Cin Lah is running on http://localhost:' + PORT));
module.exports = { server, handleApi };
