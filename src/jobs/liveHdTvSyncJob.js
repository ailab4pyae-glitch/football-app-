/**
 * liveHdTvSyncJob — syncs TV channels from livehdtv.com every 7 days.
 *
 * What it does:
 *   - Scrapes all channels from livehdtv.com (name, logo, category, stream_url)
 *   - Upserts into tv_channels table (matches on slug)
 *   - Only updates logo_url/stream_url if the scraped value is non-null
 *     (preserves manually-set values when scraper can't find a stream)
 *   - Busts Redis tv: cache after update
 */

const db           = require('../config/database');
const redis        = require('../config/redis');
const scraperState = require('../config/scraperState');
const { scrape }   = require('../scrapers/livehdtv');

const SLUG             = 'livehdtv';
const INTERVAL_MS      = 7 * 24 * 60 * 60 * 1000; // 7 days

const bustCache = async () => {
  try {
    const keys = await redis.keys('tv:*');
    if (keys.length) await redis.del(...keys);
  } catch (_) {}
};

const upsertChannels = async (channels) => {
  let inserted = 0;
  let updated  = 0;

  for (const ch of channels) {
    // Try exact slug match first
    const existing = await db.query(
      'SELECT id, logo_url, stream_url FROM tv_channels WHERE slug = $1 LIMIT 1',
      [ch.slug]
    );

    if (existing.rows.length) {
      // Update: only overwrite logo/stream if scraper found something
      const row = existing.rows[0];
      const newLogo   = ch.logo_url   || row.logo_url;
      const newStream = ch.stream_url || row.stream_url;
      await db.query(
        `UPDATE tv_channels
         SET logo_url   = $1,
             stream_url = $2,
             category   = COALESCE($3, category),
             updated_at = NOW()
         WHERE id = $4`,
        [newLogo, newStream, ch.category, row.id]
      );
      updated++;
    } else {
      // Insert new channel (inactive by default — admin must review before going live)
      const { rows } = await db.query(
        `INSERT INTO tv_channels
           (name, slug, type, category, emoji, color, logo_url, stream_url,
            is_active, position, country, language)
         VALUES ($1,$2,'tv',$3,'📺','#00FF87',$4,$5,false,999,'International','English')
         ON CONFLICT (slug) DO NOTHING
         RETURNING id`,
        [ch.name, ch.slug, ch.category, ch.logo_url, ch.stream_url]
      );
      if (rows.length) inserted++;
    }
  }

  return { inserted, updated };
};

const tick = async () => {
  if (scraperState.isRunning(SLUG)) {
    console.log('[liveHdTvSyncJob] already running, skipping');
    scheduleNext();
    return;
  }

  scraperState.start(SLUG);
  console.log('[liveHdTvSyncJob] starting sync...');

  try {
    const channels = await scrape();
    console.log(`[liveHdTvSyncJob] scraped ${channels.length} channels`);

    if (channels.length > 0) {
      const { inserted, updated } = await upsertChannels(channels);
      await bustCache();
      console.log(`[liveHdTvSyncJob] done — inserted=${inserted} updated=${updated}`);
    } else {
      console.log('[liveHdTvSyncJob] no channels scraped — skipping DB update');
    }
  } catch (err) {
    console.error('[liveHdTvSyncJob] error:', err.message);
  } finally {
    scraperState.finish(SLUG);
    scheduleNext();
  }
};

const scheduleNext = () => {
  const nextMs  = INTERVAL_MS;
  const nextDate = new Date(Date.now() + nextMs).toISOString();
  console.log(`[liveHdTvSyncJob] next run at ${nextDate}`);
  setTimeout(tick, nextMs);
};

// Delay first run by 2 minutes after boot to let DB/Redis connect
const INITIAL_DELAY_MS = 2 * 60 * 1000;
console.log('[liveHdTvSyncJob] scheduled — first run in 2 minutes');
setTimeout(tick, INITIAL_DELAY_MS);

module.exports = { tick };
