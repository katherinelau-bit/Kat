// Netlify Function that serves everything under /api/*.
import { getStore } from '@netlify/blobs';
import core from '../../lib/core.js';
import blobs from '../../lib/blobs-store.js';

const store = getStore({ name: 'bei-cin-lah', consistency: 'strong' });
const handle = core.createApi({
  store: blobs.createBlobStore(store),
  apiKey: process.env.ANTHROPIC_API_KEY || '',
  model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
});

export default async (req) => handle(req);
export const config = { path: '/api/*' };
