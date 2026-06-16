const rawUrl = (process.env.REDIS_URL || '').replace(/^["']+|["']+$/g, '');

if (!rawUrl) {
  console.warn('[redis] REDIS_URL not set — using in-memory cache');
  module.exports = require('./memcache');
} else {
  const IORedis = require('ioredis');
  const options = { maxRetriesPerRequest: null };
  if (rawUrl.startsWith('rediss://') || process.env.REDIS_TLS === 'true') {
    options.tls = { rejectUnauthorized: false };
  }
  const client = new IORedis(rawUrl, options);
  client.on('error', (err) => console.error('[redis] error:', err.message));
  module.exports = client;
}
