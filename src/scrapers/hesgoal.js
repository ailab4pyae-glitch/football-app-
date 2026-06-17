const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

chromium.use(StealthPlugin());

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];
const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

/**
 * Scrape a hes-goal.one (or similar) match page and intercept the m3u8 stream URL.
 * @param {string} pageUrl - the match page URL on hes-goal.one
 * @param {number} timeoutMs - max ms to wait for m3u8 to appear (default 30s)
 * @returns {{ url: string, expiresAt: Date|null }|null}
 */
async function scrapeM3u8(pageUrl, timeoutMs = 30000) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const ctx  = await browser.newContext({ userAgent: randomUA() });
    const page = await ctx.newPage();

    let foundUrl = null;

    page.on('request', (req) => {
      const url = req.url();
      if (url.includes('.m3u8') && !foundUrl) {
        foundUrl = url;
      }
    });

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    // Try clicking any visible play button
    try {
      await page.click('button.play, .play-btn, [class*="play"], video', { timeout: 4000 });
    } catch (_) {}

    // Wait up to timeoutMs for the m3u8 to be intercepted
    const deadline = Date.now() + timeoutMs;
    while (!foundUrl && Date.now() < deadline) {
      await page.waitForTimeout(500);
    }

    if (!foundUrl) return null;

    // Parse expiry from URL query param (e.g. ?exp=1234567890 or &expires=...)
    let expiresAt = null;
    try {
      const u = new URL(foundUrl);
      const exp = u.searchParams.get('exp') || u.searchParams.get('expires') || u.searchParams.get('expiry');
      if (exp && /^\d+$/.test(exp)) {
        expiresAt = new Date(parseInt(exp, 10) * 1000);
      }
    } catch (_) {}

    return { url: foundUrl, expiresAt };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { scrapeM3u8 };
