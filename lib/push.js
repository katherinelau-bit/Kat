'use strict';
/*
 * Phone notifications (Web Push) for the payer, e.g. "Victor sent RM 25.40 for Thai Blessing".
 * Built on node:crypto only (no npm package, so it bundles cleanly on Netlify and self-hosting needs no install):
 *   - VAPID (RFC 8292): a short ES256-signed token telling the phone's push service the message is from this site;
 *   - message encryption (RFC 8291, aes128gcm from RFC 8188): only the subscribed phone can read the message.
 * The signing keys are made on first use and kept in the bill store, so there is nothing to set up.
 */
const crypto = require('node:crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');
const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

function generateKeys() {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

// "Authorization: vapid t=<JWT>, k=<public key>" for one push service.
function vapidAuth(endpoint, keys, subject) {
  const pub = fromB64u(keys.publicKey);
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const key = crypto.createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) } });
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key, dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + head + '.' + body + '.' + b64u(sig) + ', k=' + keys.publicKey;
}

// Encrypts the message for the phone's keys as a single aes128gcm record.
// `salt` and `server` (an ECDH key pair) are only passed in by the tests; normally they are fresh each time.
function encrypt(sub, payload, salt, server) {
  salt = salt || crypto.randomBytes(16);
  if (!server) { server = crypto.createECDH('prime256v1'); server.generateKeys(); }
  const uaPublic = fromB64u(sub.keys.p256dh), auth = fromB64u(sub.keys.auth), asPublic = server.getPublicKey();
  const ikm = hkdf(auth, server.computeSecret(uaPublic), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21); salt.copy(header, 0); header.writeUInt32BE(4096, 16); header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, sealed]);
}

function createPush(store) {
  let keys = null;
  async function vapid() {
    if (keys) return keys;
    let saved = await store.getImg('config/vapid');
    if (!saved) {
      await store.putImg('config/vapid', JSON.stringify(generateKeys()));
      // Two servers starting at once could each make keys; both then use whichever was saved last.
      saved = await store.getImg('config/vapid');
    }
    keys = JSON.parse(saved);
    return keys;
  }
  return {
    async publicKey() { return (await vapid()).publicKey; },
    // Sends one notification. `gone` means the phone unsubscribed, so the subscription should be forgotten.
    async send(sub, payload, origin) {
      const k = await vapid();
      try {
        const r = await fetch(sub.endpoint, {
          method: 'POST', body: encrypt(sub, JSON.stringify(payload)), signal: AbortSignal.timeout(5000),
          headers: { TTL: String(6 * 3600), Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
            Authorization: vapidAuth(sub.endpoint, k, origin || 'https://bei-cin-lah.netlify.app') },
        });
        if (r.status === 404 || r.status === 410) return { gone: true };
        if (!r.ok) console.error('Push failed', r.status, (await r.text().catch(() => '')).slice(0, 200));
        return { gone: false };
      } catch (e) { console.error('Push failed', e.message); return { gone: false }; }
    },
  };
}
module.exports = { createPush, encrypt, vapidAuth, generateKeys };
