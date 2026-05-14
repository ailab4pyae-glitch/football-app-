const db = require('../config/database');
const redis = require('../config/redis');
const { run } = require('../scrapers/socolive');

const SLUG     = 'socolive';
const TAB_SLUG = 'soco-live';
const DEFAULT_INTERVAL_MS = parseInt(process.env.SOCO_SYNC_INTERVAL_MS, 10) || 5 * 60 * 1000;

let timer = null;

const shouldRun = async () => {
  try {
    const [srcRes, tabRes] = await Promise.all([
      db.query('SELECT is_active FROM sources WHERE slug = $1 LIMIT 1', [SLUG]),
      db.query('SELECT is_active FROM tabs WHERE slug = $1 LIMIT 1', [TAB_SLUG]),
    ]);
    const srcActive = srcRes.rows[0]?.is_active !== false;
    const tabActive = tabRes.rows[0]?.is_active !== false;
    return srcActive && tabActive;
  } catch (_) { return true; } // fail open on DB error
};

const getIntervalMs = async () => {
  try {
    const r = await db.query('SELECT config FROM sources WHERE slug = $1 LIMIT 1', [SLUG]);
    const interval = r.rows[0]?.config?.sync_interval;
    if (interval && Number.isFinite(interval) && interval >= 10000) return interval;
  } catch (_) {}
  return DEFAULT_INTERVAL_MS;
};

const tick = async () => {
  const ok = await shouldRun();
  if (ok) {
    await redis.set(`scraper:last_run:${SLUG}`, Date.now().toString()).catch(() => {});
    await run().catch((err) => console.error('[socoliveSyncJob] Failed:', err.message));
  } else {
    console.log(`[socoliveSyncJob] Skipped — source or tab is inactive`);
  }
  const interval = await getIntervalMs();
  timer = setTimeout(tick, interval);
};

tick();
