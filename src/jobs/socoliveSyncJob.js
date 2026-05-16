const db           = require('../config/database');
const scraperState = require('../config/scraperState');
const { run }      = require('../scrapers/socolive');

const SLUG     = 'socolive';
const TAB_SLUG = 'soco-live';
const DEFAULT_INTERVAL_MS = parseInt(process.env.SOCO_SYNC_INTERVAL_MS, 10) || 2 * 60 * 1000;

const shouldRun = async () => {
  try {
    const [srcRes, tabRes] = await Promise.all([
      db.query('SELECT is_active FROM sources WHERE slug = $1 LIMIT 1', [SLUG]),
      db.query('SELECT is_active FROM tabs WHERE slug = $1 LIMIT 1', [TAB_SLUG]),
    ]);
    return srcRes.rows[0]?.is_active !== false && tabRes.rows[0]?.is_active !== false;
  } catch (_) { return true; }
};

const getIntervalMs = async () => {
  try {
    const r = await db.query('SELECT config FROM sources WHERE slug = $1 LIMIT 1', [SLUG]);
    const cfg = r.rows[0]?.config || {};
    const v = cfg.sync_interval_ms ?? cfg.sync_interval;
    if (v && Number.isFinite(v) && v >= 10000) return v;
  } catch (_) {}
  return DEFAULT_INTERVAL_MS;
};

const tick = async () => {
  if (await shouldRun()) {
    if (scraperState.isRunning(SLUG)) {
      console.log(`[socoliveSyncJob] Skipped — already running`);
    } else {
      scraperState.start(SLUG);
      try {
        await run();
        scraperState.finish(SLUG, 'ok');
      } catch (err) {
        console.error('[socoliveSyncJob] Failed:', err.message);
        scraperState.finish(SLUG, 'error', err.message);
      }
    }
  } else {
    console.log(`[socoliveSyncJob] Skipped — source or tab is inactive`);
    scraperState.finish(SLUG, 'skipped');
  }
  setTimeout(tick, await getIntervalMs());
};

tick();
