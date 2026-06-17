const db           = require('../config/database');
const redis        = require('../config/redis');
const scraperState = require('../config/scraperState');
const { isWithinActiveHours } = require('../config/scraperSchedule');
const { getMatchList, getMatchDetail, scrapeM3u8 } = require('../scrapers/hesgoal');

const SLUG             = 'hesgoal';
const TAB_SLUG         = 'hesgoal-live';
const SYNC_INTERVAL_MS = parseInt(process.env.HESGOAL_SYNC_MS, 10) || 15 * 60 * 1000; // 15 min

// Fixed English m3u8 streams — no expiry token, verified stable Rumble CDN channel slots.
// Checked with HTTP HEAD before use; if alive they become Mobile 1 without needing Playwright.
const FIXED_ENGLISH_M3U8 = [
  'https://hugh.cdn.rumble.cloud/live/k5e12sb4/slot-77/5i22-sqch_720p/chunklist_DVR.m3u8',
];

const checkFixedStream = async (url) => {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
    });
    return res.ok || res.status === 405; // 405 = method not allowed but server alive
  } catch (_) {
    return false;
  }
};

// ── Source config ─────────────────────────────────────────────────────────────

const getSourceConfig = async () => {
  try {
    const r = await db.query('SELECT config, is_active FROM sources WHERE slug = $1 LIMIT 1', [SLUG]);
    return r.rows[0] || {};
  } catch (_) { return {}; }
};

// ── Ensure tab row exists ─────────────────────────────────────────────────────

const getOrCreateTab = async () => {
  const { rows } = await db.query(
    `INSERT INTO tabs (name, slug, position, source_type, icon, color, description, config, is_active, created_at)
     VALUES ('HES Goal', $1, 10, 'scraper', '⚽', '#00e5ff', 'Live matches from hes-goal.one', '{"source":"hesgoal"}', true, now())
     ON CONFLICT (slug) DO UPDATE SET is_active = tabs.is_active
     RETURNING id`,
    [TAB_SLUG]
  );
  return rows[0].id;
};

// ── Date helpers ──────────────────────────────────────────────────────────────

const dateStr = (offsetDays = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

// ── Upsert a match in hesgoal-live tab ───────────────────────────────────────

const upsertMatch = async (tabId, m) => {
  const title = `${m.homeEn} vs ${m.awayEn}`;
  const { rows } = await db.query(
    `INSERT INTO matches
       (tab_id, title, home_team, away_team, home_logo, away_logo, league,
        status, scheduled_at, source_match_id, source_name, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'hesgoal',now())
     ON CONFLICT (source_match_id, source_name) DO UPDATE
       SET status       = CASE
             WHEN matches.status = 'finished' THEN 'finished'
             ELSE EXCLUDED.status
           END,
           title        = EXCLUDED.title,
           home_team    = EXCLUDED.home_team,
           away_team    = EXCLUDED.away_team,
           home_logo    = EXCLUDED.home_logo,
           away_logo    = EXCLUDED.away_logo,
           league       = EXCLUDED.league,
           scheduled_at = EXCLUDED.scheduled_at,
           tab_id       = EXCLUDED.tab_id
     RETURNING id`,
    [
      tabId, title, m.homeEn, m.awayEn,
      m.homeLogo, m.awayLogo, m.leagueName,
      m.status, m.scheduledAt, String(m.id),
    ]
  );
  return rows[0]?.id || null;
};

// ── Save channel embed URLs as streams and bust Redis cache ───────────────────
// Embed pages (mobile_link or link) play in an iframe in the user's browser.
// This avoids the CDN cookie/session issue that blocks server-side m3u8 proxying.

const saveChannelStreams = async (matchId, channels) => {
  if (!channels.length) return 0;

  // Build deduplicated { url, label } list: prefer English, prefer mobile_link over link
  const seen    = new Set();
  const entries = [];
  const add = (url, label) => {
    if (url && url.startsWith('http') && !seen.has(url)) {
      seen.add(url);
      entries.push({ url, label: label || 'Live' });
    }
  };

  // Pass 1: English channels, mobile_link first
  for (const ch of channels) {
    if (ch.language === 'En' && ch.mobile_link) add(ch.mobile_link, ch.server_name_en);
  }
  for (const ch of channels) {
    if (ch.language === 'En' && ch.link) add(ch.link, ch.server_name_en);
  }
  // Pass 2: any remaining channels
  for (const ch of channels) {
    if (ch.mobile_link) add(ch.mobile_link, ch.server_name_en);
    if (ch.link)        add(ch.link,        ch.server_name_en);
  }

  if (!entries.length) return 0;

  // source_name stores "hesgoal:Label" — only delete embed streams (hesgoal:*),
  // leave the m3u8 stream (source_name = 'hesgoal' exactly) intact.
  await db.query(
    `DELETE FROM stream_urls WHERE match_id = $1 AND source_name LIKE 'hesgoal:%'`,
    [matchId]
  ).catch(() => {});

  const top = entries.slice(0, 3);
  for (let i = 0; i < top.length; i++) {
    await db.query(
      `INSERT INTO stream_urls (match_id, url, quality, source_name, priority, is_healthy, created_at)
       VALUES ($1, $2, 'HD', $3, $4, true, now())`,
      [matchId, top[i].url, `hesgoal:${top[i].label}`, top.length - i]
    ).catch(() => {});
  }

  await redis.del(`streams:${matchId}`).catch(() => {});
  return top.length;
};

// ── Save m3u8 stream (with captured headers) as high-priority hesgoal stream ──
// source_name = 'hesgoal' (no label) marks it as a native m3u8 stream.
// Embeds use 'hesgoal:Label', so the two kinds don't clobber each other.

// Save up to 2 native m3u8 streams (Mobile 1, Mobile 2).
// Deletes all previous m3u8 records then re-inserts the fresh ones.
const saveM3u8Streams = async (matchId, results) => {
  await db.query(
    `DELETE FROM stream_urls WHERE match_id = $1 AND source_name = 'hesgoal'`,
    [matchId]
  ).catch(() => {});
  for (let i = 0; i < results.length; i++) {
    const { url, expiresAt, headers } = results[i];
    await db.query(
      `INSERT INTO stream_urls (match_id, url, quality, source_name, priority, is_healthy, expires_at, headers, created_at)
       VALUES ($1, $2, 'HD', 'hesgoal', $3, true, $4, $5::jsonb, now())`,
      [matchId, url, 10 - i, expiresAt || null, headers ? JSON.stringify(headers) : null]
    ).catch(() => {});
  }
  await redis.del(`streams:${matchId}`).catch(() => {});
};

// Tracks which DB match IDs currently have a Playwright m3u8 scrape in flight.
// Prevents launching a second Playwright session for the same match if the previous
// scrape is still running when the next sync tick fires.
const m3u8Scraping = new Set();

// poolExtras = English channels cross-pollinated from other concurrent matches.
// These are tried FIRST because they were already confirmed working/English
// (e.g. unoair1 from Portugal gives English commentary for any current match).
// Own English channels are tried after as fallback.
const startM3u8Scrape = (dbMatchId, m, channels, detail, poolExtras = []) => {
  if (m3u8Scraping.has(dbMatchId)) {
    console.log(`[hesgoal] m3u8 scrape already running for match ${dbMatchId} — skipping`);
    return;
  }
  m3u8Scraping.add(dbMatchId);
  setImmediate(async () => {
    try {
      // Pass 1 — Mobile 1 (English): pool extras first, then own non-AR English channels
      const poolCandidates = poolExtras.filter(
        (ch) => (ch.mobile_link || ch.link) && !/\(AR\)/i.test(ch.server_name_en || '')
      );
      const ownEngCandidates = channels.filter(
        (ch) => ch.language === 'En' && (ch.mobile_link || ch.link) &&
                !poolCandidates.some((p) => (p.mobile_link || p.link) === (ch.mobile_link || ch.link))
      );
      const engCandidates = [...poolCandidates, ...ownEngCandidates].slice(0, 5);

      // Pass 2 — Mobile 2 (Arabic): channels not labeled English, or server name has (AR)
      const arCandidates = channels.filter(
        (ch) => (ch.language !== 'En' || /\(AR\)/i.test(ch.server_name_en || '')) &&
                (ch.mobile_link || ch.link)
      ).slice(0, 3);

      if (!engCandidates.length && !arCandidates.length) {
        console.log(`[hesgoal] No channels to scrape for ${m.homeEn} vs ${m.awayEn}`);
        return;
      }

      console.log(`[hesgoal] Scraping m3u8 for ${m.homeEn} vs ${m.awayEn} — eng:${engCandidates.length} ar:${arCandidates.length}`);
      const results  = [];
      const usedUrls = new Set();

      // Mobile 1: try fixed English streams first (fast HTTP HEAD, no Playwright needed)
      for (const url of FIXED_ENGLISH_M3U8) {
        if (results.length >= 1) break;
        const alive = await checkFixedStream(url);
        if (alive && !usedUrls.has(url)) {
          usedUrls.add(url);
          results.push({ url, expiresAt: null, headers: null });
          console.log(`[hesgoal] Mobile 1 (fixed/English): ${url.slice(0, 80)}`);
        }
      }

      const tryScrape = async (ch, tag) => {
        try {
          const result = await scrapeM3u8(m.id, [], '', 20000, [ch]);
          if (result?.url && !usedUrls.has(result.url)) {
            usedUrls.add(result.url);
            results.push(result);
            console.log(`[hesgoal] Mobile ${results.length} (${tag}/${ch.server_name_en}): ${result.url.slice(0, 80)}`);
            return true;
          }
        } catch (err) {
          console.warn(`[hesgoal] Scrape failed (${ch.server_name_en}):`, err.message);
        }
        return false;
      };

      // Mobile 1 fallback: Playwright scrape if fixed streams all failed
      for (const ch of engCandidates) {
        if (results.length >= 1) break;
        await tryScrape(ch, poolCandidates.includes(ch) ? 'pool' : 'eng');
      }

      // Mobile 2: first Arabic channel that gives an m3u8
      for (const ch of arCandidates) {
        if (results.length >= 2) break;
        await tryScrape(ch, 'ar');
      }

      // Fallback: if still only 1 result, try any remaining own channel for Mobile 2
      if (results.length === 1) {
        const fallback = ownEngCandidates.filter(
          (ch) => !engCandidates.includes(ch) || !usedUrls.has(ch.mobile_link || ch.link)
        ).slice(0, 2);
        for (const ch of fallback) {
          if (results.length >= 2) break;
          await tryScrape(ch, 'fallback');
        }
      }

      if (results.length) {
        await saveM3u8Streams(dbMatchId, results);
        console.log(`[hesgoal] ${results.length} m3u8 stream(s) saved for ${m.homeEn} vs ${m.awayEn}`);
      } else {
        console.log(`[hesgoal] No m3u8 found for ${m.homeEn} vs ${m.awayEn} — embeds remain as fallback`);
      }
    } catch (err) {
      console.warn(`[hesgoal] m3u8 scrape failed for ${m.homeEn} vs ${m.awayEn}:`, err.message);
    } finally {
      m3u8Scraping.delete(dbMatchId);
    }
  });
};

// ── Main sync ─────────────────────────────────────────────────────────────────

const syncHesgoal = async () => {
  // Ensure tab exists
  let tabId;
  try {
    tabId = await getOrCreateTab();
  } catch (err) {
    console.error('[hesgoal] Failed to ensure tab:', err.message);
    return;
  }

  // Fetch today + tomorrow from the API (no Playwright)
  let allMatches = [];
  for (const offset of [0, 1]) {
    const date = dateStr(offset);
    try {
      const list = await getMatchList(date);
      allMatches = allMatches.concat(list);
      console.log(`[hesgoal] API: ${list.length} match(es) for ${date}`);
    } catch (err) {
      console.error(`[hesgoal] getMatchList(${date}) failed:`, err.message);
    }
  }

  if (!allMatches.length) {
    console.log('[hesgoal] No matches from API');
    return;
  }

  // Upsert all matches into DB
  let upserted = 0;
  for (const m of allMatches) {
    try {
      const dbId = await upsertMatch(tabId, m);
      if (dbId) upserted++;
    } catch (err) {
      console.warn(`[hesgoal] upsertMatch failed for ${m.homeEn} vs ${m.awayEn}:`, err.message);
    }
  }
  console.log(`[hesgoal] Upserted ${upserted} match(es)`);

  // Save embed channel URLs for live matches
  const liveMatches = allMatches.filter((m) => m.status === 'live');
  if (!liveMatches.length) {
    console.log('[hesgoal] No live matches right now');
    await redis.del(`matches:${TAB_SLUG}`).catch(() => {});
    return;
  }

  console.log(`[hesgoal] ${liveMatches.length} live match(es) — fetching channels`);

  // ── Pass 1: fetch all live match channel lists ────────────────────────────
  // We need all channels up front so we can build an English pool to share across matches.
  const liveMatchData = []; // [{ m, dbMatchId, channels, detail }]

  for (const m of liveMatches) {
    let dbMatchId = null;
    try {
      const { rows } = await db.query(
        `SELECT id FROM matches WHERE source_match_id = $1 AND source_name = 'hesgoal' LIMIT 1`,
        [String(m.id)]
      );
      dbMatchId = rows[0]?.id;
    } catch (_) {}
    if (!dbMatchId) continue;

    let channels = [];
    let detail   = null;
    try {
      detail   = await getMatchDetail(m.id);
      channels = detail.channels || [];
    } catch (err) {
      console.warn(`[hesgoal] getMatchDetail failed for ${m.id}:`, err.message);
    }

    if (channels.length) liveMatchData.push({ m, dbMatchId, channels, detail });
    else console.warn(`[hesgoal] No channels for ${m.homeEn} vs ${m.awayEn}`);
  }

  // Build a pool of all English channels seen across ALL live matches.
  // These are live TV channel embeds (soccerball.st, maslaz.com etc.) that broadcast
  // whatever is currently on air — not locked to a specific match. So an English
  // channel found for Portugal will also show England vs Croatia if that channel
  // is currently broadcasting it.
  const englishPool = [];
  const poolSeen    = new Set();
  for (const { channels } of liveMatchData) {
    for (const ch of channels) {
      if (ch.language !== 'En') continue;
      if (/\(AR\)/i.test(ch.server_name_en || '')) continue; // exclude Arabic-labelled even if language='En'
      const key = ch.mobile_link || ch.link;
      if (key && !poolSeen.has(key)) { poolSeen.add(key); englishPool.push(ch); }
    }
  }

  // Also pull any English embed URLs saved in DB recently (from other concurrent/recent matches).
  // This ensures that if Portugal vs DR Congo has an English channel (unoair1) that England
  // vs Croatia's API response doesn't list, we still offer it as an option.
  try {
    const { rows: recentEmbeds } = await db.query(
      `SELECT DISTINCT url, source_name FROM stream_urls
       WHERE source_name LIKE 'hesgoal:%' AND is_healthy = true
         AND created_at > NOW() - INTERVAL '4 hours'
       LIMIT 30`
    );
    for (const row of recentEmbeds) {
      if (!poolSeen.has(row.url)) {
        poolSeen.add(row.url);
        const label = row.source_name.slice(8); // strip 'hesgoal:' prefix
        englishPool.push({ language: 'En', mobile_link: row.url, link: null, server_name_en: label });
      }
    }
  } catch (_) {}

  console.log(`[hesgoal] English channel pool: ${englishPool.length} unique channel(s) across all live + recent matches`);

  // ── Pass 2: save streams for each match ───────────────────────────────────
  // Deduplicate by dbMatchId — the same match can appear in both today's and
  // tomorrow's list (e.g. started today, still live at midnight).
  const seenMatchIds  = new Set();
  const uniqueMatches = liveMatchData.filter(({ dbMatchId }) => {
    if (seenMatchIds.has(dbMatchId)) return false;
    seenMatchIds.add(dbMatchId);
    return true;
  });

  let saved = 0;

  for (const { m, dbMatchId, channels, detail } of uniqueMatches) {
    // Merge own channels with English pool from other matches so every match
    // always has the English options even if the API didn't list them for it.
    const poolExtras = englishPool.filter((pc) => {
      const key = pc.mobile_link || pc.link;
      return !channels.some((c) => (c.mobile_link || c.link) === key);
    });

    // Pool extras (English from other concurrent/recent matches) go FIRST so they
    // become PC 1, PC 2 in the embed selector. Own non-AR channels follow as PC 3+.
    const ownNonAr = channels.filter(
      (ch) => ch.language === 'En' && ch.mobile_link && !/\(AR\)/i.test(ch.server_name_en || '')
    );
    const combined = [
      ...poolExtras,
      ...ownNonAr.slice(0, 2),
      ...channels.filter((ch) => !ownNonAr.slice(0, 2).includes(ch) && !poolExtras.includes(ch)),
    ];

    console.log(`[hesgoal] Saving channels for ${m.homeEn} vs ${m.awayEn} (own:${channels.length} + pool:${poolExtras.length})`);
    const count = await saveChannelStreams(dbMatchId, combined).catch(() => 0);
    if (count) { saved++; console.log(`[hesgoal] ${count} embed stream(s) saved for match ${dbMatchId}`); }

    // Fire m3u8 scrape in background — tries English channels first
    if (detail) startM3u8Scrape(dbMatchId, m, combined, detail, poolExtras);
  }

  await redis.del(`matches:${TAB_SLUG}`).catch(() => {});
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

// ── Bootstrap ─────────────────────────────────────────────────────────────────

db.query(
  `INSERT INTO sources (name, slug, is_active, driver_type, base_domain, config, created_at)
   VALUES ('HES Goal', 'hesgoal', true, 'playwright', 'hes-goal.one', '{}', now())
   ON CONFLICT (slug) DO NOTHING`
).catch(() => {});

// Delay first tick by 10s so other server startup (DB pool, Redis) finishes first
setTimeout(tick, 10000);

module.exports = { syncHesgoal };
