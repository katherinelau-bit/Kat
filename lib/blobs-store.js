'use strict';
/* Storage on Netlify Blobs. `store` is what getStore() from @netlify/blobs returns.
 * `prefix` picks the kind of document: 'bill/' for bills (the default) or 'trip/' for trips. Images are shared. */
function createBlobStore(store, prefix = 'bill/') {
  const HttpError = require('./core.js').HttpError;
  const billKey = (id) => prefix + id;
  const missing = prefix === 'trip/' ? 'Trip not found' : 'Bill not found';
  return {
    async getBill(id) { return (await store.get(billKey(id), { type: 'json' })) || null; },
    async putBill(b) { await store.set(billKey(b.id), JSON.stringify(b)); },
    async delBill(id) { await store.delete(billKey(id)); },
    // Read, change, write back. If someone else wrote in between, read again and redo the change.
    async update(id, fn) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const cur = await store.getWithMetadata(billKey(id), { type: 'json' });
        if (!cur || !cur.data) throw new HttpError(404, missing);
        // Without an etag, set() would silently overwrite whatever someone else just saved.
        if (!cur.etag) throw new Error('Blobs returned no etag for ' + billKey(id) + '; refusing an unchecked write');
        const b = cur.data, result = fn(b);
        const res = await store.set(billKey(id), JSON.stringify(b), { onlyIfMatch: cur.etag });
        if (!res || res.modified !== false) return { bill: b, result };
        await new Promise((r) => setTimeout(r, 40 + Math.random() * 120));
      }
      throw new HttpError(503, 'Busy, please try again');
    },
    async getImg(key) { return (await store.get('img/' + key, { type: 'text' })) || null; },
    async putImg(key, data) { await store.set('img/' + key, data); },
    async delImg(key) { await store.delete('img/' + key); },
  };
}
module.exports = { createBlobStore };
