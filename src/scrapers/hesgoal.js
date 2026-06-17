const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

chromium.use(StealthPlugin());

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];
const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const BASE_URL = 'https://hes-goal.one';

// ── Match list scraper ────────────────────────────────────────────────────────

/**
 * Scrape the live/upcoming match list from hes-goal.one.
 * Returns: [{ title, home, away, href }]
 */
async function scrapeMatchList(timeoutMs = 30000) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const ctx  = await browser.newContext({ userAgent: randomUA() });
    const page = await ctx.newPage();

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    // Let JS render match list
    await page.waitForTimeout(3000);

    const matches = await page.evaluate((base) => {
      const results = [];
      const seen    = new Set();

      // Collect all anchor tags that look like match pages
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      for (const a of anchors) {
        const href = a.href || '';
        if (!href.startsWith(base)) continue;
        // Match page pattern: contains "-vs-" or "live-stream" in the path
        if (!/-vs-/i.test(href) && !/live.stream/i.test(href) && !/\/match\//i.test(href)) continue;
        if (seen.has(href)) continue;
        seen.add(href);

        // Try to extract team names from the visible text first
        const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
        let home = null, away = null;

        const vsInText = text.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\s+live|\s+stream|\s+\d|$)/i);
        if (vsInText) {
          home = vsInText[1].trim();
          away = vsInText[2].trim();
        }

        // Fall back: parse team names from the URL path segment
        if (!home) {
          try {
            const pathname = new URL(href).pathname;
            const seg = pathname.split('/').filter(Boolean).pop() || '';
            const vsInUrl = seg.match(/^(.+?)-vs-(.+?)(?:-live|-stream|-\d|$)/i);
            if (vsInUrl) {
              const toName = (s) => s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
              home = toName(vsInUrl[1]);
              away = toName(vsInUrl[2]);
            }
          } catch (_) {}
        }

        results.push({ title: text || `${home} vs ${away}`, home, away, href });
      }
      return results;
    }, BASE_URL);

    console.log(`[hesgoal-scraper] List scrape found ${matches.length} match(es)`);
    return matches;
  } catch (err) {
    console.error('[hesgoal-scraper] scrapeMatchList error:', err.message);
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ── m3u8 scraper ──────────────────────────────────────────────────────────────

/**
 * Scrape an m3u8 stream URL from a hes-goal.one match page.
 * Uses context-level request + response interception to catch iframe requests too.
 * @returns {{ url: string, expiresAt: Date|null }|null}
 */
async function scrapeM3u8(pageUrl, timeoutMs = 30000) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const ctx  = await browser.newContext({ userAgent: randomUA() });
    const page = await ctx.newPage();

    let foundUrl = null;

    // Context-level listeners catch requests/responses from ALL frames (iframes, popups)
    ctx.on('request', (req) => {
      const url = req.url();
      if (url.includes('.m3u8') && !foundUrl) {
        foundUrl = url;
        console.log('[hesgoal-scraper] m3u8 via request:', url.slice(0, 80));
      }
    });
    ctx.on('response', (res) => {
      const url = res.url();
      if (url.includes('.m3u8') && !foundUrl) {
        foundUrl = url;
        console.log('[hesgoal-scraper] m3u8 via response:', url.slice(0, 80));
      }
    });

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    // Small pause for JS to boot
    await page.waitForTimeout(2000);

    // Attempt to click a play button (try multiple selectors, stop on first hit)
    const playSelectors = [
      '.vjs-big-play-button',
      'button[class*="play"]',
      '.play-btn',
      '[class*="play-button"]',
      '[id*="play"]',
      'video',
    ];
    for (const sel of playSelectors) {
      try {
        await page.click(sel, { timeout: 2000 });
        break;
      } catch (_) {}
    }

    // Poll until we find an m3u8 or time out
    const deadline = Date.now() + timeoutMs;
    while (!foundUrl && Date.now() < deadline) {
      await page.waitForTimeout(500);
    }

    if (!foundUrl) return null;

    // Parse CDN token expiry from URL query params
    let expiresAt = null;
    try {
      const u   = new URL(foundUrl);
      const exp = u.searchParams.get('exp') || u.searchParams.get('expires') || u.searchParams.get('expiry');
      if (exp && /^\d+$/.test(exp)) {
        expiresAt = new Date(parseInt(exp, 10) * 1000);
      }
    } catch (_) {}

    return { url: foundUrl, expiresAt };
  } catch (err) {
    console.error('[hesgoal-scraper] scrapeM3u8 error:', err.message);
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { scrapeMatchList, scrapeM3u8 };
