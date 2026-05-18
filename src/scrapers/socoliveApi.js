/**
 * SOCO Live API scraper — HTTP-only, no Playwright, no iframes.
 * Pulls match list + stream URLs directly via HTTP/JSON.
 * Only stores direct m3u8/flv stream URLs (filters out embed/iframe URLs).
 * Reuses fetchMatchList and fetchStreamUrls from socolive.js (they are already HTTP-first).
 */

const db = require('../config/database');
const { fetchMatchList, fetchStreamUrls, discoverMirror } = require('./socolive');
const { resolveLogos } = require('../services/teamLogos');

const SLUG = 'socolive-api';
const CONCURRENCY = 3;

// ─── DB helpers ───────────────────────────────────────────────────────────────

const getBaseUrls = async () => {
  try {
    // Reuse the same socolive source config — same mirrors, same API endpoints
    const r = await db.query("SELECT config FROM sources WHERE slug = 'socolive' AND is_active = true LIMIT 1");
    const raw = r.rows[0]?.config?.base_urls || [];
    return raw
      .map((u) => (typeof u === 'string' ? { url: u, enabled: true } : u))
      .filter((u) => u.enabled !== false)
      .map((u) => u.url);
  } catch (_) {}
  return [];
};

let cachedTabId = null;
const getTabId = async () => {
  if (cachedTabId) return cachedTabId;
  const r = await db.query("SELECT id FROM tabs WHERE slug = 'soco-api' LIMIT 1");
  cachedTabId = r.rows[0]?.id || null;
  return cachedTabId;
};

const parseTokenExpiry = (url) => {
  const m = url.match(/auth_key=(\d{10})/);
  if (m) return new Date(parseInt(m[1], 10) * 1000).toISOString();
  return null;
};

const classifyQuality = (url) => {
  if (/hd|720|1080|high/i.test(url)) return 'HD';
  return 'SD';
};

// Only accept direct HLS or FLV streams — reject iframe/embed URLs
const isDirectStream = (url) => {
  if (!url) return false;
  return /\.(m3u8|flv)(\?|$)/i.test(url);
};

const hasFreshStreams = async (matchId) => {
  const r = await db.query(
    `SELECT 1 FROM stream_urls WHERE match_id = $1 AND is_healthy = true
     AND (expires_at IS NULL OR expires_at > NOW() + INTERVAL '15 minutes') LIMIT 1`,
    [matchId]
  );
  return r.rows.length > 0;
};

const saveMatchToDB = async (match, tabId) => {
  const { home_logo, away_logo } = await resolveLogos(
    match.home_team, match.away_team, match.home_logo, match.away_logo
  );

  const existing = await db.query(
    'SELECT id FROM matches WHERE source_match_id = $1 AND source_name = $2 LIMIT 1',
    [match.sourceId, SLUG]
  );

  let matchId;
  if (existing.rows.length) {
    matchId = existing.rows[0].id;
    await db.query(
      `UPDATE matches SET
         status          = CASE WHEN status = 'finished' THEN 'finished' ELSE $1 END,
         score_home      = $2,
         score_away      = $3,
         elapsed_minutes = $4,
         home_logo       = $5,
         away_logo       = $6,
         league          = COALESCE($7::text, league)
       WHERE id = $8`,
      [match.status, match.score_home, match.score_away, match.elapsed ?? null,
       home_logo, away_logo, match.league || null, matchId]
    );
  } else {
    const ins = await db.query(
      `INSERT INTO matches
         (tab_id, title, home_team, away_team, home_logo, away_logo,
          league, status, scheduled_at, source_match_id, source_name,
          score_home, score_away, elapsed_minutes, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
       RETURNING id`,
      [tabId, match.title, match.home_team, match.away_team, home_logo, away_logo,
       match.league, match.status, match.scheduled_at, match.sourceId, SLUG,
       match.score_home, match.score_away, match.elapsed ?? null]
    );
    matchId = ins.rows[0].id;
  }

  // Only store direct m3u8/flv — drop any iframe/embed URLs
  const directStreams = (match.streams || []).filter((s) => isDirectStream(s.url));
  if (!directStreams.length) return;

  for (const stream of directStreams) {
    const quality   = classifyQuality(stream.url);
    const expiresAt = parseTokenExpiry(stream.url) || new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const dup = await db.query(
      "SELECT id FROM stream_urls WHERE match_id=$1 AND split_part(url,'?',1)=split_part($2,'?',1) LIMIT 1",
      [matchId, stream.url]
    );
    if (dup.rows.length) {
      await db.query(
        'UPDATE stream_urls SET url=$1, expires_at=$2, is_healthy=true WHERE id=$3',
        [stream.url, expiresAt, dup.rows[0].id]
      );
    } else {
      await db.query(
        `INSERT INTO stream_urls
           (match_id, url, quality, source_name, priority, is_healthy, expires_at, created_at)
         VALUES ($1,$2,$3,$4,$5,true,$6,now())`,
        [matchId, stream.url, quality, SLUG, quality === 'HD' ? 2 : 1, expiresAt]
      );
    }
  }

  console.log(`[socolive-api] Saved "${match.title}" — ${directStreams.length} direct stream(s)`);
};

const deleteFinished = async (activeSourceIds, tabId) => {
  if (!tabId) return;
  if (activeSourceIds.length) {
    const placeholders = activeSourceIds.map((_, i) => `$${i + 2}`).join(',');
    await db.query(
      `DELETE FROM matches WHERE tab_id = $1 AND source_name = $2
       AND status = 'live' AND source_match_id NOT IN (${placeholders})
       AND (scheduled_at IS NULL OR scheduled_at < NOW() - INTERVAL '90 minutes')`,
      [tabId, SLUG, ...activeSourceIds]
    );
  }
  await db.query(
    `DELETE FROM matches WHERE tab_id = $1 AND source_name = $2
     AND status = 'live' AND (scheduled_at IS NULL OR scheduled_at < NOW() - INTERVAL '3 hours')`,
    [tabId, SLUG]
  );
};

// ─── Concurrency limiter ──────────────────────────────────────────────────────

const pLimit = (n) => {
  let active = 0;
  const queue = [];
  const next = () => {
    while (active < n && queue.length) {
      active++;
      const { task, resolve, reject } = queue.shift();
      task().then(resolve, reject).finally(() => { active--; next(); });
    }
  };
  return (task) => new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); next(); });
};

// ─── Main run ─────────────────────────────────────────────────────────────────

const run = async () => {
  console.log('[socolive-api] Starting API pull…');
  const tabId = await getTabId();
  if (!tabId) { console.warn('[socolive-api] soco-api tab not found in DB — skipping'); return; }

  const baseUrls = await getBaseUrls();
  let matches = null;
  let workingBase = null;

  for (const url of baseUrls) {
    try {
      const result = await fetchMatchList(url);
      if (result.length > 0) { matches = result; workingBase = url; break; }
    } catch (err) {
      console.warn(`[socolive-api] ${url} failed:`, err.message);
    }
  }

  if (!matches?.length) {
    console.warn('[socolive-api] All mirrors failed — running auto-discovery…');
    const discovered = await discoverMirror();
    if (discovered) {
      try {
        const result = await fetchMatchList(discovered);
        if (result.length > 0) { matches = result; workingBase = discovered; }
      } catch (err) {
        console.warn('[socolive-api] Discovered URL also failed:', err.message);
      }
    }
  }

  if (!matches?.length) {
    console.error('[socolive-api] No live matches found — aborting');
    return;
  }

  console.log(`[socolive-api] ${matches.length} live matches from ${workingBase}`);

  // All socolive matches have matchPaths — fetchStreamUrls skips Playwright automatically
  // when matchPaths are provided (see socolive.js:fetchStreamUrls logic).
  const limit = pLimit(CONCURRENCY);

  await Promise.all(
    matches.map((match) =>
      limit(async () => {
        try {
          const existing = await db.query(
            'SELECT id FROM matches WHERE source_match_id=$1 AND source_name=$2 LIMIT 1',
            [match.sourceId, SLUG]
          );
          const matchId = existing.rows[0]?.id;
          if (matchId && await hasFreshStreams(matchId)) {
            match.streams = [];
          } else {
            // Pass null as browser — guarantees no Playwright is launched
            match.streams = await fetchStreamUrls(match.matchPath, null, match.matchPaths);
          }
        } catch (err) {
          console.error(`[socolive-api] Stream fetch failed "${match.title}":`, err.message);
          match.streams = [];
        }
      })
    )
  );

  const activeIds = [];
  for (const match of matches) {
    try {
      await saveMatchToDB(match, tabId);
      if (match.sourceId) activeIds.push(match.sourceId);
    } catch (err) {
      console.error(`[socolive-api] Save failed "${match.title}":`, err.message);
    }
  }

  await deleteFinished(activeIds, tabId).catch((err) =>
    console.error('[socolive-api] deleteFinished error:', err.message)
  );

  console.log('[socolive-api] Pull complete');
};

module.exports = { run };
