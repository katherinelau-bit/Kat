'use strict';
/*
 * Phone notifications (Web Push) for the payer, e.g. "Victor sent RM 25.40 for Thai Blessing".
 * The signing keys are made on first use and kept in the bill store, so there is nothing to set up.
 * Returns null when the web-push package is not installed (self-hosting without `npm install`): notifications are then off.
 */
function createPush(store) {
  let wp;
  try { wp = require('web-push'); } catch (e) { return null; }
  let keys = null;
  async function vapid() {
    if (keys) return keys;
    let saved = await store.getImg('config/vapid');
    if (!saved) {
      const k = wp.generateVAPIDKeys();
      await store.putImg('config/vapid', JSON.stringify(k));
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
        await wp.sendNotification(sub, JSON.stringify(payload), {
          TTL: 6 * 3600, urgency: 'high', timeout: 5000,
          vapidDetails: { subject: origin || 'https://bei-cin-lah.netlify.app', publicKey: k.publicKey, privateKey: k.privateKey },
        });
        return { gone: false };
      } catch (e) {
        if (e.statusCode !== 404 && e.statusCode !== 410) console.error('Push failed', e.statusCode || '', e.body || e.message);
        return { gone: e.statusCode === 404 || e.statusCode === 410 };
      }
    },
  };
}
module.exports = { createPush };
