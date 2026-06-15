const db    = require('../config/database');
const redis = require('../config/redis');
const { getDetail } = require('../scrapers/sportsrc');

const DETAIL_CACHE_SEC = 2 * 60; // 2 min — live matches update often

module.exports = async function (fastify) {
  fastify.get('/api/sportsrc/detail/:matchId', async (request, reply) => {
    const { matchId } = request.params;
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(matchId)) {
      reply.code(404); return { error: 'Not found' };
    }

    const cacheKey = `sportsrc:detail:${matchId}`;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (_) {}

    let srcMatchId = null;
    try {
      const r = await db.query(
        "SELECT source_match_id FROM matches WHERE id = $1 AND source_name = 'sportsrc' LIMIT 1",
        [matchId]
      );
      srcMatchId = r.rows[0]?.source_match_id || null;
    } catch (_) {}

    if (!srcMatchId) {
      reply.code(404); return { error: 'Not a SportSRC match' };
    }

    let data = null;
    try {
      const res = await getDetail(srcMatchId);
      // API may nest under .data or return at root
      data = res?.data || res || null;
    } catch (err) {
      fastify.log.warn('[sportsrc detail]', err.message);
      reply.code(502); return { error: 'API unavailable' };
    }

    if (!data) {
      reply.code(404); return { error: 'No detail available' };
    }

    try { await redis.set(cacheKey, JSON.stringify(data), 'EX', DETAIL_CACHE_SEC); } catch (_) {}
    return data;
  });
};
