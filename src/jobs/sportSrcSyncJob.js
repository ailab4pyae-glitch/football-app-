const db           = require('../config/database');
const redis        = require('../config/redis');
const scraperState = require('../config/scraperState');
const { isWithinActiveHours } = require('../config/scraperSchedule');
const { getMatches, getDetail, todayStr, tomorrowStr } = require('../scrapers/sportsrc');

const SLUG     = 'sportsrc';
const TAB_SLUG = 'sport-src';

const SYNC_INTERVAL_MS   = parseInt(process.env.SPORTSRC_SYNC_MS, 10) || 30 * 60 * 1000; // 30 min
const EMBED_CACHE_TTL_SEC = 20 * 60; // 20 min

// ─── Source/tab active check ──────────────────────────────────────────────────

const getSourceConfig = async () => {
  try {
    const r = await db.query('SELECT config, is_active FROM sources WHERE slug = $1 LIMIT 1', [SLUG]);
    return r.rows[0] || {};
  } catch (_) { return {}; }
};

const shouldRun = async (src) => {
  try {
    const tabRes = await db.query('SELECT is_active FROM tabs WHERE slug = $1 LIMIT 1', [TAB_SLUG]);
    if (src.is_active === false || tabRes.rows[0]?.is_active === false) return false;
  } catch (_) {}
  if (!isWithinActiveHours(src.config)) return false;
  return true;
};

// ─── Upsert a single match ────────────────────────────────────────────────────

const STATUS_MAP = {
  notstarted: 'scheduled',
  inprogress: 'live',
  finished:   'finished',
  postponed:  'scheduled',
  canceled:   'finished',
};

const upsertMatch = async (tabId, match, leagueName) => {
  const home  = match.teams?.home || {};
  const away  = match.teams?.away || {};
  const title = match.title || `${home.name} vs ${away.name}`;
  const scheduledAt = match.timestamp ? new Date(match.timestamp).toISOString() : null;
  const status = STATUS_MAP[match.status] || (match.status === 'live' ? 'live' : 'scheduled');

  try {
    const res = await db.query(
      `INSERT INTO matches
         (tab_id, title, home_team, away_team, home_logo, away_logo, league,
          status, scheduled_at, source_match_id, source_name,
          score_home, score_away, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'sportsrc',$11,$12,now())
       ON CONFLICT (source_match_id, source_name) DO UPDATE
         SET status     = CASE
               WHEN matches.status = 'finished'                                 THEN 'finished'
               WHEN matches.status = 'live' AND EXCLUDED.status = 'scheduled'   THEN 'live'
               ELSE EXCLUDED.status
             END,
             title      = EXCLUDED.title,
             home_team  = EXCLUDED.home_team,
             away_team  = EXCLUDED.away_team,
             home_logo  = EXCLUDED.home_logo,
             away_logo  = EXCLUDED.away_logo,
             score_home = EXCLUDED.score_home,
             score_away = EXCLUDED.score_away
       RETURNING id`,
      [
        tabId, title,
        home.name || '?', away.name || '?',
        home.badge || null, away.badge || null,
        leagueName, status, scheduledAt, match.id,
        match.score?.current?.home ?? null,
        match.score?.current?.away ?? null,
      ]
    );
    return res.rows[0]?.id || null;
  } catch (err) {
    console.error(`[sportsrc] upsertMatch error (${match.id}):`, err.message);
    return null;
  }
};

// ─── Fetch + save embed stream URLs for a match ───────────────────────────────

const syncEmbeds = async (dbMatchId, srcMatchId) => {
  // Skip if Redis cache still warm (embed URLs haven't changed)
  try {
    const cached = await redis.get(`streams:${dbMatchId}`);
    if (cached) return;
  } catch (_) {}

  let detail;
  try {
    detail = await getDetail(srcMatchId);
  } catch (err) {
    console.warn(`[sportsrc] getDetail(${srcMatchId}) failed:`, err.message);
    return;
  }

  // API may nest streams under data or return at root
  const streamList = detail?.data?.streams || detail?.streams || [];
  if (!streamList.length) {
    console.log(`[sportsrc] No embeds yet for ${srcMatchId}`);
    return;
  }

  // Replace stale embed rows
  await db.query('DELETE FROM stream_urls WHERE match_id = $1 AND source_name = $2', [dbMatchId, 'sportsrc']).catch(() => {});

  let saved = 0;
  for (let i = 0; i < streamList.length; i++) {
    const s   = streamList[i];
    const url = s.url || s.embed || s.link || null;
    if (!url) continue;
    try {
      await db.query(
        `INSERT INTO stream_urls (match_id, url, quality, source_name, priority, is_healthy, created_at)
         VALUES ($1, $2, 'EMBED', 'sportsrc', $3, true, now())`,
        [dbMatchId, url, streamList.length - i]
      );
      saved++;
    } catch (err) {
      console.warn(`[sportsrc] stream insert error:`, err.message);
    }
  }

  if (!saved) return;
  console.log(`[sportsrc] Saved ${saved} embed(s) for ${srcMatchId}`);

  // Warm Redis so the first user request is a cache hit
  try {
    const rows = await db.query(
      `SELECT id, url, source_name, priority FROM stream_urls
       WHERE match_id = $1 AND is_healthy = true AND quality = 'EMBED'
       ORDER BY priority DESC`,
      [dbMatchId]
    );
    const grouped = {
      SD: [], HD: [],
      embed: rows.rows.map(r => ({ id: r.id, url: r.url, source_name: r.source_name, priority: r.priority })),
    };
    await redis.set(`streams:${dbMatchId}`, JSON.stringify(grouped), 'EX', EMBED_CACHE_TTL_SEC);
  } catch (_) {}
};

// ─── Main sync ────────────────────────────────────────────────────────────────

const syncSportsrc = async () => {
  const tabRes = await db.query('SELECT id FROM tabs WHERE slug = $1 LIMIT 1', [TAB_SLUG]);
  const tabId  = tabRes.rows[0]?.id;
  if (!tabId) {
    console.warn('[sportsrc] Tab "sport-src" not found — create it in DB first');
    return;
  }

  let total = 0;

  for (const date of [todayStr(), tomorrowStr()]) {
    let data;
    try {
      data = await getMatches(date);
    } catch (err) {
      console.error(`[sportsrc] getMatches(${date}) failed:`, err.message);
      continue;
    }

    for (const league of (data.data || [])) {
      const leagueName = league.league?.name || '';
      for (const match of (league.matches || [])) {
        if (match.status === 'finished') continue;

        const dbMatchId = await upsertMatch(tabId, match, leagueName);
        if (!dbMatchId) continue;
        total++;

        // Fetch embed streams for this match
        await syncEmbeds(dbMatchId, match.id);
      }
    }
  }

  // Bust match list cache for this tab
  try {
    await redis.del(`matches:${TAB_SLUG}`);
  } catch (_) {}

  console.log(`[sportsrc] Sync complete — ${total} matches`);
};

// ─── Tick loop ────────────────────────────────────────────────────────────────

const tick = async () => {
  const src      = await getSourceConfig();
  const interval = src.config?.sync_interval_ms ?? SYNC_INTERVAL_MS;

  if (!(await shouldRun(src))) {
    setTimeout(tick, interval);
    return;
  }

  if (scraperState.isRunning(SLUG)) {
    console.log('[sportsrc] Skipped — already running');
    setTimeout(tick, interval);
    return;
  }

  scraperState.start(SLUG);
  try {
    await syncSportsrc();
    scraperState.finish(SLUG, 'ok');
  } catch (err) {
    console.error('[sportsrc] Sync failed:', err.message);
    scraperState.finish(SLUG, 'error', err.message);
  }

  setTimeout(tick, interval);
};

tick();
