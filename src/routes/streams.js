const db = require('../config/database');
const redis = require('../config/redis');

module.exports = async function (fastify, opts) {
  fastify.get('/api/streams/:matchId', async (request, reply) => {
    const { matchId } = request.params;
    const cacheKey = `streams:${matchId}`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (err) {
      fastify.log.warn('Redis cache miss for streams', err);
    }

    const result = await db.query(
      `SELECT id, url, quality, source_name, priority
       FROM stream_urls
       WHERE match_id = $1 AND is_healthy = TRUE
       ORDER BY CASE WHEN quality = 'HD' THEN 1 WHEN quality = 'SD' THEN 0 ELSE -1 END DESC, priority ASC`,
      [matchId]
    );

    const streams = result.rows;

    try {
      await redis.set(cacheKey, JSON.stringify(streams), 'EX', 10);
    } catch (err) {
      fastify.log.warn('Failed to cache stream URLs', err);
    }

    return streams;
  });
};
