const db = require('../config/database');
const redis = require('../config/redis');

module.exports = async function (fastify, opts) {
  fastify.get('/api/matches', async (request, reply) => {
    const { tab } = request.query;
    const cacheKey = tab ? `matches:${tab}` : 'matches:all';

    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (err) {
      fastify.log.warn('Redis cache miss for matches', err);
    }

    const query = tab
      ? `SELECT m.id, m.title, m.home_team, m.away_team, m.home_logo, m.away_logo, m.status, m.scheduled_at
         FROM matches m
         JOIN tabs t ON m.tab_id = t.id
         WHERE t.slug = $1
         ORDER BY m.scheduled_at ASC`
      : `SELECT id, title, home_team, away_team, home_logo, away_logo, status, scheduled_at
         FROM matches
         ORDER BY scheduled_at ASC`;

    const params = tab ? [tab] : [];
    const result = await db.query(query, params);
    const matches = result.rows;

    try {
      await redis.set(cacheKey, JSON.stringify(matches), 'EX', 30);
    } catch (err) {
      fastify.log.warn('Failed to cache matches', err);
    }

    return matches;
  });

  fastify.get('/api/matches/:id', async (request, reply) => {
    const { id } = request.params;
    const result = await db.query(
      'SELECT id, tab_id, title, home_team, away_team, home_logo, away_logo, status, scheduled_at, source_match_id, source_name, created_at FROM matches WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      reply.code(404);
      return { error: 'Match not found' };
    }

    return result.rows[0];
  });
};
