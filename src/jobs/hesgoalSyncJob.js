const db           = require('../config/database');
const redis        = require('../config/redis');
const scraperState = require('../config/scraperState');
const { isWithinActiveHours } = require('../config/scraperSchedule');
const { scrapeMatchList, scrapeM3u8 } = require('../scrapers/hesgoal');

const SLUG             = 'hesgoal';
const SYNC_INTERVAL_MS = parseInt(process.env.HESGOAL_SYNC_MS, 10) || 15 * 60 * 1000; // 15 min
// Re-scrape a hesgoal stream if its CDN token expires within this window
const REWARM_BEFORE_MS = 10 * 60 * 1000; // 10 min

// ── Source config ─────────────────────────────────────────────────────────────

const getSourceConfig = async () => {
  try {
    const r = await db.query('SELECT config, is_active FROM sources WHERE slug = $1 LIMIT 1', [SLUG]);
    return r.rows[0] || {};
  } catch (_) { return {}; }
};

// ── Team name fuzzy match ─────────────────────────────────────────────────────

const normName = (s) => (s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip diacritics
  .replace(/[^a-z0-9 ]/g, ' ')
  // strip common club suffixes
  .replace(/\b(fc|cf|sc|bv|sv|ac|as|rc|cd|ud|rcd|afc|fk|sk|if|il|ik|bk|gk|city|united|utd|town|rovers|wanderers|athletic|atletico)\b/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const namesMatch = (a, b) => {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  // Significant-word overlap: at least 1 non-trivial word in common covering ≥50% of the shorter name
  const wa = new Set(na.split(' ').filter((w) => w.length > 2));
  const wb = nb.split(' ').filter((w) => w.length > 2);
  if (!wa.size || !wb.length) return false;
  const common = wb.filter((w) => wa.has(w));
  return common.length >= 1 && common.length / Math.min(wa.size, wb.length) >= 0.5;
};

// Returns the first DB match whose home+away pair matches the hesgoal entry (either side)
const findDbMatch = (hesMatch, dbMatches) => {
  if (!hesMatch.home || !hesMatch.away) return null;
  for (const m of dbMatches) {
    if (namesMatch(hesMatch.home, m.home_team) && namesMatch(hesMatch.away, m.away_team)) return m;
    if (namesMatch(hesMatch.home, m.away_team) && namesMatch(hesMatch.away, m.home_team)) return m;
  }
  return null;
};

// ── Save a fresh hesgoal stream URL to DB and warm Redis ─────────────────────

const saveStream = async (matchId, m3u8Url, expiresAt) => {
  await db.query(
    `DELETE FROM stream_urls WHERE match_id = $1 AND source_name = 'hesgoal'`,
    [matchId]
  ).catch(() => {});
  await db.query(
    `INSERT INTO stream_urls (match_id, url, quality, source_name, priority, is_healthy, expires_at, created_at)
     VALUES ($1, $2, 'HD', 'hesgoal', 10, true, $3, now())`,
    [matchId, m3u8Url, expiresAt || null]
  );
  await redis.del(`streams:${matchId}`).catch(() => {});
};

// ── Re-warm: refresh expiring / unhealthy hesgoal streams ────────────────────

const rewarmExpiring = async (hesList) => {
  const rewarmCutoff = new Date(Date.now() + REWARM_BEFORE_MS).toISOString();

  // Find live matches that have a hesgoal stream expiring soon or marked unhealthy
  let stale = [];
  try {
    const { rows } = await db.query(
      `SELECT su.id AS stream_id, su.match_id,
              m.home_team, m.away_team
       FROM stream_urls su
       JOIN matches m ON m.id = su.match_id
       WHERE su.source_name = 'hesgoal'
         AND m.status = 'live'
         AND (su.is_healthy = false OR (su.expires_at IS NOT NULL AND su.expires_at < $1))`,
      [rewarmCutoff]
    );
    stale = rows;
  } catch (err) {
    console.error('[hesgoal] rewarm query failed:', err.message);
    return;
  }

  if (!stale.length) return;
  console.log(`[hesgoal] ${stale.length} stream(s) need re-warm`);

  for (const row of stale) {
    // Re-discover the hesgoal match page by comparing team names to the live list
    const hesMatch = hesList.find(
      (h) => (namesMatch(h.home, row.home_team) && namesMatch(h.away, row.away_team)) ||
             (namesMatch(h.home, row.away_team) && namesMatch(h.away, row.home_team))
    );

    if (!hesMatch?.href) {
      console.warn(`[hesgoal] No hesgoal page found for re-warm: ${row.home_team} vs ${row.away_team}`);
      continue;
    }

    console.log(`[hesgoal] Re-warming match ${row.match_id}: ${hesMatch.href}`);
    try {
      const result = await scrapeM3u8(hesMatch.href, 30000);
      if (!result?.url) {
        console.warn(`[hesgoal] Re-warm: no m3u8 found for ${hesMatch.title}`);
        continue;
      }
      await saveStream(row.match_id, result.url, result.expiresAt);
      console.log(`[hesgoal] Re-warmed match ${row.match_id}`);
    } catch (err) {
      console.warn(`[hesgoal] Re-warm scrape failed for ${hesMatch.href}:`, err.message);
    }
  }
};

// ── New match discovery ───────────────────────────────────────────────────────

const discoverNew = async (hesList, dbMatches) => {
  let saved = 0;

  for (const hesMatch of hesList) {
    if (!hesMatch.href || (!hesMatch.home && !hesMatch.away)) continue;

    const dbm = findDbMatch(hesMatch, dbMatches);
    if (!dbm) continue;

    // Only auto-scrape live matches — scheduled ones don't have active streams yet
    if (dbm.status !== 'live') continue;

    // Skip if a valid hesgoal stream already exists (will be handled by rewarm if expiring)
    try {
      const { rows } = await db.query(
        `SELECT id FROM stream_urls
         WHERE match_id = $1 AND source_name = 'hesgoal' AND is_healthy = true
           AND (expires_at IS NULL OR expires_at > NOW() + INTERVAL '10 minutes')
         LIMIT 1`,
        [dbm.id]
      );
      if (rows.length) continue;
    } catch (_) {}

    console.log(`[hesgoal] Auto-scraping: ${hesMatch.title} → db match ${dbm.id}`);
    try {
      const result = await scrapeM3u8(hesMatch.href, 30000);
      if (!result?.url) {
        console.warn(`[hesgoal] No m3u8 for: ${hesMatch.title}`);
        continue;
      }
      await saveStream(dbm.id, result.url, result.expiresAt);
      saved++;
      console.log(`[hesgoal] Saved stream for match ${dbm.id}`);
    } catch (err) {
      console.warn(`[hesgoal] Scrape failed for ${hesMatch.href}:`, err.message);
    }
  }

  return saved;
};

// ── Main sync ─────────────────────────────────────────────────────────────────

const syncHesgoal = async () => {
  // Pull active live/upcoming matches from a ±3 hour window across all tabs
  let dbMatches = [];
  try {
    const { rows } = await db.query(
      `SELECT id, home_team, away_team, status FROM matches
       WHERE status IN ('live', 'scheduled')
         AND scheduled_at > NOW() - INTERVAL '1 hour'
         AND scheduled_at < NOW() + INTERVAL '3 hours'
       ORDER BY scheduled_at`
    );
    dbMatches = rows;
  } catch (err) {
    console.error('[hesgoal] DB query failed:', err.message);
    return;
  }

  if (!dbMatches.length) {
    console.log('[hesgoal] No active matches in window — skipping');
    return;
  }

  // One Playwright launch to scrape the full match list
  let hesList = [];
  try {
    hesList = await scrapeMatchList(30000);
  } catch (err) {
    console.error('[hesgoal] List scrape failed:', err.message);
    return;
  }

  if (!hesList.length) {
    console.log('[hesgoal] No matches found on hes-goal.one');
    return;
  }

  // Re-warm expiring / unhealthy streams (uses the live list to find page URLs)
  await rewarmExpiring(hesList);

  // Discover and scrape new live matches
  const saved = await discoverNew(hesList, dbMatches);
  console.log(`[hesgoal] Sync complete — ${saved} new stream(s) saved`);
};

// ── Tick loop ─────────────────────────────────────────────────────────────────

const tick = async () => {
  const src      = await getSourceConfig();
  const interval = src.config?.sync_interval_ms ?? SYNC_INTERVAL_MS;

  if (src.is_active === false) {
    console.log('[hesgoal] Source disabled — skipping');
    setTimeout(tick, interval);
    return;
  }

  if (!isWithinActiveHours(src.config)) {
    setTimeout(tick, interval);
    return;
  }

  if (scraperState.isRunning(SLUG)) {
    console.log('[hesgoal] Skipped — already running');
    setTimeout(tick, interval);
    return;
  }

  scraperState.start(SLUG);
  try {
    await syncHesgoal();
    scraperState.finish(SLUG, 'ok');
  } catch (err) {
    console.error('[hesgoal] Sync failed:', err.message);
    scraperState.finish(SLUG, 'error', err.message);
  }

  setTimeout(tick, interval);
};

tick();
