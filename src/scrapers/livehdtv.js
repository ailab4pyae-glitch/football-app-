const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const BASE = 'https://www.livehdtv.com';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Map livehdtv category labels → our admin category names
const CAT_MAP = {
  'sports':        'Sports TV',
  'sport':         'Sports TV',
  'news':          'News TV',
  'entertainment': 'Entertainment TV',
  'kids':          'Entertainment TV',
  'music':         'Entertainment TV',
  'general':       'General TV',
  'documentary':   'General TV',
  'lifestyle':     'General TV',
  'business':      'News TV',
};

const mapCategory = (raw = '') => {
  const key = raw.toLowerCase().trim();
  for (const [k, v] of Object.entries(CAT_MAP)) {
    if (key.includes(k)) return v;
  }
  return 'General TV';
};

const makeSlug = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/**
 * Scrape all channels from livehdtv.com.
 * Returns array of { name, slug, category, logo_url, stream_url, source_url }
 */
async function scrape() {
  console.log('[livehdtv] launching browser...');
  const browser = await chromium.launch({
    headless: process.env.LIVEHDTV_HEADLESS !== 'false',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  const results = [];

  try {
    const page = await ctx.newPage();

    // Track intercepted m3u8 per page URL
    const m3u8Cache = {};
    page.on('request', req => {
      const url = req.url();
      if (url.includes('.m3u8')) m3u8Cache[page.url()] = url;
    });
    page.on('response', async res => {
      const url = res.url();
      if (url.includes('.m3u8') || url.includes('m3u8')) m3u8Cache[page.url()] = url;
    });

    // ── Step 1: load homepage, wait past Cloudflare ──────────────────────────
    console.log('[livehdtv] loading homepage...');
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 45000 });

    // Give CF managed challenge up to 20s
    try {
      await page.waitForSelector('a[href*="/channel/"], .channel-card, .channel-item, .card', {
        timeout: 20000,
      });
    } catch {
      console.log('[livehdtv] waiting extra 10s for CF...');
      await page.waitForTimeout(10000);
    }

    // ── Step 2: collect all channel links ────────────────────────────────────
    const channelLinks = await page.evaluate((base) => {
      const seen = new Set();
      const out  = [];
      const anchors = document.querySelectorAll(
        'a[href*="/channel/"], a[href*="/watch/"], a[href*="/live/"], a[href*="/tv/"]'
      );
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        const full = href.startsWith('http') ? href : base + (href.startsWith('/') ? '' : '/') + href;
        if (seen.has(full)) continue;
        seen.add(full);

        const nameEl = a.querySelector('h1,h2,h3,h4,.name,.title,span,p') || a;
        const name   = nameEl.textContent?.trim() || '';
        const img    = a.querySelector('img');
        const logo   = img?.src || img?.dataset?.src || img?.getAttribute('data-lazy-src') || '';
        const catEl  = a.querySelector('.category,.genre,[class*="cat"],[class*="genre"]');
        const cat    = catEl?.textContent?.trim() || '';

        if (name && full.includes(base)) out.push({ href: full, name, logo, cat });
      }
      return out;
    }, BASE);

    console.log(`[livehdtv] found ${channelLinks.length} channel links`);
    if (channelLinks.length === 0) {
      console.log('[livehdtv] page snippet:', (await page.content()).slice(0, 500));
      return [];
    }

    // ── Step 3: visit each channel page, extract stream URL ──────────────────
    for (const ch of channelLinks) {
      console.log(`[livehdtv] → ${ch.name} (${ch.href})`);
      try {
        await page.goto(ch.href, { waitUntil: 'networkidle', timeout: 25000 });
        await page.waitForTimeout(3500); // let player boot + network requests fire

        // Check intercepted m3u8
        let streamUrl = m3u8Cache[ch.href] || m3u8Cache[page.url()] || null;

        // Fallback: parse from JS in page source
        if (!streamUrl) {
          streamUrl = await page.evaluate(() => {
            const body = document.documentElement.innerHTML;
            // Common patterns
            const patterns = [
              /(https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*)/,
              /source:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/,
              /file:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/,
              /src:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/,
              /hls\.loadSource\(['"]([^'"]+)['"]\)/,
              /new Hls[^)]*\(['"]([^'"]+)['"]\)/,
            ];
            for (const p of patterns) {
              const m = body.match(p);
              if (m) return m[1];
            }
            return null;
          });
        }

        // If m3u8 not found, try grabbing iframe embed src
        let embedUrl = null;
        if (!streamUrl) {
          embedUrl = await page.evaluate(() => {
            const iframe = document.querySelector('iframe[src*="stream"], iframe[src*="embed"], iframe[src*="live"], iframe[src*="player"]');
            return iframe?.src || null;
          });
          if (embedUrl) {
            console.log(`  ↳ iframe embed: ${embedUrl}`);
            // Try loading iframe page to find m3u8 inside
            try {
              await page.goto(embedUrl, { waitUntil: 'networkidle', timeout: 15000 });
              await page.waitForTimeout(3000);
              streamUrl = m3u8Cache[embedUrl] || m3u8Cache[page.url()] || null;
              if (!streamUrl) {
                streamUrl = await page.evaluate(() => {
                  const m = document.documentElement.innerHTML.match(/(https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*)/);
                  return m ? m[1] : null;
                });
              }
            } catch { /* iframe load failed */ }
          }
        }

        // Extract logo + category from channel page if not found on list
        let logo = ch.logo;
        let cat  = ch.cat;
        if (!logo || !cat) {
          const meta = await page.evaluate(() => {
            const og    = document.querySelector('meta[property="og:image"]')?.content;
            const img   = document.querySelector('.channel-logo img, .logo img, .thumbnail img, header img')?.src;
            const catEl = document.querySelector('.category,.genre,[class*="cat"],[class*="genre"],.breadcrumb a:last-child');
            return { logo: og || img || '', cat: catEl?.textContent?.trim() || '' };
          });
          if (!logo) logo = meta.logo;
          if (!cat)  cat  = meta.cat;
        }

        const entry = {
          name:        ch.name,
          slug:        makeSlug(ch.name),
          category:    mapCategory(cat),
          logo_url:    logo || null,
          stream_url:  streamUrl || null,
          source_url:  ch.href,
        };
        results.push(entry);
        console.log(`  ✓ stream=${streamUrl ? streamUrl.slice(0, 70) : 'not found'}`);
      } catch (err) {
        console.log(`  ✗ ${ch.name}: ${err.message}`);
        results.push({
          name:       ch.name,
          slug:       makeSlug(ch.name),
          category:   mapCategory(ch.cat),
          logo_url:   ch.logo || null,
          stream_url: null,
          source_url: ch.href,
        });
      }
    }
  } finally {
    await browser.close();
  }

  return results;
}

module.exports = { scrape };
