const scraperState = require('../config/scraperState');
const { run }      = require('../scrapers/myanmarTv');

const SLUG        = 'myanmar-tv';
const INTERVAL_MS = 8 * 60 * 1000;

const tick = async () => {
  if (scraperState.isRunning(SLUG)) {
    console.log('[myanmarTvSyncJob] Skipped — already running');
  } else {
    scraperState.start(SLUG);
    try {
      await run();
      scraperState.finish(SLUG, 'ok');
    } catch (err) {
      console.error('[myanmarTvSyncJob] Failed:', err.message);
      scraperState.finish(SLUG, 'error', err.message);
    }
  }
  setTimeout(tick, INTERVAL_MS);
};

tick();
