const IORedis = require('ioredis');

if (!process.env.REDIS_URL) {
  throw new Error('REDIS_URL is required in environment variables');
}

const options = {
  maxRetriesPerRequest: null
};
if (process.env.REDIS_URL.startsWith('rediss://') || process.env.REDIS_TLS === 'true') {
  options.tls = { rejectUnauthorized: false };
}

const redisClient = new IORedis(process.env.REDIS_URL, options);
redisClient.on('error', (err) => {
  console.error('Redis error', err);
});

module.exports = redisClient;
