const db    = require('../config/database');
const redis = require('../config/redis');
const { runForMatch }              = require('../scrapers/chinalive');
const { STREAM_CACHE_TTL_SEC }     = require('../jobs/chinaliveSyncJob');
// How long to wait for another process holding the scrape lock (ms)
const LOCK_WAIT_MS    = 15000;
const LOCK_POLL_MS    = 500;
const LOCK_TTL_SEC    = 30;

const buildGrouped = (rows, apiBase) => {
  const grouped = { SD: [], HD: [], embed: [], hesgoal: [] };
  // Counters for per-type hesgoal button labels: Mobile N (m3u8) and PC N (iframe embed)
  let hesgoalMobile = 0, hesgoalPc = 0;
  for (const row of rows) {
    // Embed streams (SportSRC iframes) — return URL as-is, no proxy
    if (row.quality === 'EMBED') {
      grouped.embed.push({ id: row.id, url: row.url, source_name: row.source_name, priority: row.priority });
      continue;
    }
    // Hesgoal streams:
    //   source_name = 'hesgoal'        → native m3u8 → "Mobile N" button
    //   source_name = 'hesgoal:Label'  → iframe embed → "PC N" button
    if (row.source_name === 'hesgoal' || row.source_name?.startsWith('hesgoal:')) {
      const isMobile = row.source_name === 'hesgoal'; // m3u8 native stream
      const isM3u8   = row.url.includes('.m3u8');
      const direct   = process.env.DIRECT_STREAMS === 'true';
      const proxyUrl = (isM3u8 && !direct) ? `${apiBase}/api/proxy/stream/${row.id}` : row.url;
      const label    = isMobile ? `Mobile ${++hesgoalMobile}` : `PC ${++hesgoalPc}`;
      grouped.hesgoal.push({
        id:         row.id,
        url:        proxyUrl,
        label,
        expires_at: row.expires_at,
      });
      continue;
    }
    const q       = row.quality === 'HD' ? 'HD' : 'SD';
    const isM3u8  = row.url.includes('.m3u8');
    const isFlv   = /\.flv(\?|$)/i.test(row.url);
    const direct  = process.env.DIRECT_STREAMS === 'true';
    const proxyUrl = (isM3u8 && !direct) ? `${apiBase}/api/proxy/stream/${row.id}`
                   : (isFlv  && !direct) ? `${apiBase}/api/proxy/flv/${row.id}`
                   : row.url;
    grouped[q].push({
      id:           row.id,
      url:          proxyUrl,
      source_name:  row.source_name,
      priority:     row.priority,
      latency_ms:   row.latency_ms,
      last_checked: row.last_checked,
      expires_at:   row.expires_at,
    });
  }
  return grouped;
};

const queryStreams = async (matchId) => {
  try {
    const { rows } = await db.query(
      `SELECT id, url, quality, source_name, priority, is_healthy, last_checked, expires_at, latency_ms
       FROM stream_urls
       WHERE match_id = $1
         AND is_healthy = true
         AND (expires_at IS NULL OR expires_at > NOW() - INTERVAL '3 minutes')
       ORDER BY
         CASE quality WHEN 'HD' THEN 1 WHEN 'SD' THEN 2 ELSE 3 END ASC,
         priority DESC,
         latency_ms ASC NULLS LAST`,
      [matchId]
    );
    return rows;
  } catch (_) {
    return [];
  }
};

module.exports = async function (fastify, opts) {
  fastify.get('/api/streams/:matchId', async (request, reply) => {
    const { matchId } = request.params;

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(matchId)) {
      reply.code(404);
      return { error: 'Match not found' };
    }

    const cacheKey = `streams:${matchId}`;
    const lockKey  = `lock:china:${matchId}`;
    const apiBase  = (process.env.BACKEND_URL || `${request.protocol}://${request.headers.host}`).replace(/\/$/, '');

    // ── 1. Check match source ─────────────────────────────────────────────────
    let isChina    = false;
    let isSportsrc = false;
    let srcMatchId = null;
    try {
      const matchRow = await db.query(
        "SELECT source_name, source_match_id FROM matches WHERE id = $1 LIMIT 1",
        [matchId]
      );
      const src  = matchRow.rows[0]?.source_name;
      isChina    = src === 'chinalive';
      isSportsrc = src === 'sportsrc';
      srcMatchId = matchRow.rows[0]?.source_match_id;
    } catch (_) {}

    // ── 2. Cache hit → return immediately (skip if sportsrc with empty embeds) ─
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (isChina) {
          const sdCount = parsed.SD?.length || 0;
          const hdCount = parsed.HD?.length || 0;
          if (sdCount === 0 && hdCount === 0) {
            console.warn(`[CHINA-CACHE] Redis HIT but empty for match=${matchId} — falling through to DB`);
          } else {
            console.log(`[CHINA-CACHE] Redis HIT match=${matchId} SD=${sdCount} HD=${hdCount}`);
          }
        }
        // For sportsrc: don't return an empty embed cache — fall through to re-fetch
        if (!isSportsrc || parsed.embed?.length > 0) return parsed;
      } else if (isChina) {
        console.log(`[CHINA-CACHE] Redis MISS match=${matchId} — querying DB`);
      }
    } catch (_) {}

    if (isChina) {
      // ── 3a. Check DB first — pre-warm may have already saved fresh URLs ──────
      const dbRows = await queryStreams(matchId);
      if (dbRows.length > 0) {
        // Fresh URLs in DB (from pre-warm/re-warm) — cache and return immediately
        const grouped = buildGrouped(dbRows, apiBase);
        try { await redis.set(cacheKey, JSON.stringify(grouped), 'EX', STREAM_CACHE_TTL_SEC); } catch (_) {}
        return grouped;
      }

      // ── 3b. DB empty → on-demand scrape with lock ───────────────────────────
      let gotLock = false;
      try {
        const res = await redis.set(lockKey, '1', 'NX', 'EX', LOCK_TTL_SEC);
        gotLock = res === 'OK';
      } catch (_) {}

      if (gotLock) {
        try {
          await runForMatch(matchId, { fast: true });
        } catch (err) {
          fastify.log.warn('[streams] on-demand scrape failed:', err.message);
        } finally {
          try { await redis.del(lockKey); } catch (_) {}
        }
      } else {
        // Another request is scraping — wait for cache to populate
        const deadline = Date.now() + LOCK_WAIT_MS;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
          try {
            const cached = await redis.get(cacheKey);
            if (cached) return JSON.parse(cached);
          } catch (_) {}
        }
      }
    }

    // ── 3b. SportSRC on-demand embed fetch (no Playwright — pure API call) ──────
    if (isSportsrc && srcMatchId) {
      const dbRows = await queryStreams(matchId);
      if (!dbRows.length) {
        try {
          const { getDetail } = require('../scrapers/sportsrc');
          const detail     = await getDetail(srcMatchId);
          const streamList = detail?.data?.sources || detail?.data?.streams || detail?.streams || [];
          if (streamList.length) {
            await db.query('DELETE FROM stream_urls WHERE match_id = $1 AND quality = $2', [matchId, 'EMBED']).catch(() => {});
            for (let i = 0; i < streamList.length; i++) {
              const s   = streamList[i];
              const url = s.embedUrl || s.url || s.embed || s.link || null;
              if (!url) continue;
              const name = s.language || s.name || s.title || s.label || s.channel || 'sportsrc';
              await db.query(
                `INSERT INTO stream_urls (match_id, url, quality, source_name, priority, is_healthy, created_at)
                 VALUES ($1, $2, 'EMBED', $3, $4, true, now())`,
                [matchId, url, name, streamList.length - i]
              ).catch(() => {});
            }
          }
        } catch (err) {
          fastify.log.warn('[streams] sportsrc on-demand fetch failed:', err.message);
        }
      }
    }

    // ── 4. Query DB → build proxy URLs → cache ────────────────────────────────
    const rows    = await queryStreams(matchId);
    const grouped = buildGrouped(rows, apiBase);

    try {
      const hasContent = grouped.SD.length || grouped.HD.length || grouped.embed.length || grouped.hesgoal.length;
      // Never cache an empty sportsrc result — pre-match on-demand calls return nothing,
      // and caching empty for 20 min causes the sync job to skip re-fetch when streams arrive.
      if (hasContent || !isSportsrc) {
        const ttl = isChina
          ? (hasContent ? STREAM_CACHE_TTL_SEC : 30)
          : isSportsrc ? 20 * 60 : 15;
        await redis.set(cacheKey, JSON.stringify(grouped), 'EX', ttl);
      }
    } catch (_) {}

    return grouped;
  });
};
