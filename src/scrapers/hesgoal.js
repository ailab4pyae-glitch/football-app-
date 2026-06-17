const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

chromium.use(StealthPlugin());

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];
const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const MATCHES_API = 'https://ws.kora-api.space/api/matches';
const MATCH_API   = 'https://kora-api.space/api/matche';
const TEAM_IMG    = 'https://cdn.kora-api.space/uploads/team/';
const LEAGUE_IMG  = 'https://cdn.kora-api.space/uploads/league/';

const TS = () => Date.now();

// ── Match list from API (no Playwright) ───────────────────────────────────────

/**
 * Fetch today's (and optionally tomorrow's) match list from hes-goal's API.
 * Returns normalized match objects ready for DB upsert.
 */
async function getMatchList(dateStr) {
  let res;
  try {
    res = await fetch(`${MATCHES_API}/${dateStr}/1?t=${TS()}`, {
      headers: {
        Referer:    'https://hes-goal.one/',
        Origin:     'https://hes-goal.one',
        'User-Agent': randomUA(),
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    const detail = err.cause ? `${err.cause.code || ''} ${err.cause.message || ''}`.trim() : '';
    throw new Error(`fetch error: ${err.message}${detail ? ` (${detail})` : ''}`);
  }
  if (!res.ok) throw new Error(`kora-api HTTP ${res.status} for ${dateStr}`);
  const data = await res.json();

  const liveIds = new Set(data.live_matche_ids || []);

  return (data.matches || []).map((m) => ({
    id:          m.id,                                        // hes-goal match ID
    homeEn:      m.home_en || '',
    awayEn:      m.away_en || '',
    homeLogo:    m.home_logo  ? `${TEAM_IMG}${m.home_logo}`   : null,
    awayLogo:    m.away_logo  ? `${TEAM_IMG}${m.away_logo}`   : null,
    leagueName:  m.league_en  || '',
    leagueLogo:  m.league_logo ? `${LEAGUE_IMG}${m.league_logo}` : null,
    scheduledAt: m.date && m.time ? new Date(`${m.date}T${m.time}:00Z`) : null,
    status:      liveIds.has(String(m.id)) ? 'live' : (m.status === 1 ? 'live' : 'scheduled'),
    edges:       Array.isArray(m.edges) ? m.edges : [],
    edgeDomain:  m.edge_domain || '',
    hasChannels: m.has_channels === 1 || m.has_channels === '1',
  }));
}

// ── Per-match stream detail from API ─────────────────────────────────────────

/**
 * Fetch individual match detail — includes channels and stream window.
 * Returns { channels, edges, edgeDomain, startStream, endStream }
 */
async function getMatchDetail(matchId) {
  const res = await fetch(`${MATCH_API}/${matchId}/en?t=${TS()}`, {
    headers: {
      Referer:    'https://strm01.app/',
      Origin:     'https://strm01.app',
      'User-Agent': randomUA(),
    },
  });
  if (!res.ok) throw new Error(`matche API HTTP ${res.status} for ${matchId}`);
  const data = await res.json();
  return {
    channels:    data.channels   || [],
    edges:       Array.isArray(data.edges) ? data.edges : [],
    edgeDomain:  data.edge_domain || '',
    startStream: data.start_stream || null,
    endStream:   data.end_stream   || null,
  };
}

// ── m3u8 scraper via Playwright ───────────────────────────────────────────────

const PLAY_SELECTORS = [
  '.vjs-big-play-button', '[class*="play-btn"]', '[class*="btnPlay"]',
  'button[aria-label*="play" i]', '.jw-icon-display', '[class*="play"]',
  'video', 'button',
];

/**
 * Build prioritised candidate URLs from channels + edge fallback.
 * mobile_link is the most direct (real embed page, no redirect hop).
 * channel link (reddit-soccer-streams / score808) is next.
 * Edge frame.php is last resort.
 */
function buildCandidateUrls(matchId, edges, edgeDomain, channels) {
  const seen = new Set();
  const add  = (url) => { if (url && url.startsWith('http') && !seen.has(url)) { seen.add(url); return true; } return false; };
  const urls = [];

  // 1. mobile_links — direct embed pages (e.g. soccerball.st, maslaz.com)
  for (const ch of channels) {
    if (add(ch.mobile_link)) urls.push(ch.mobile_link);
  }
  // 2. channel link pages (reddit-soccer-streams, score808 etc.)
  for (const ch of channels) {
    if (add(ch.link)) urls.push(ch.link);
  }
  // 3. edge frame.php fallback
  for (const edge of (edges || [])) {
    const u = `https://${edge}.${edgeDomain}/frame.php?m=${matchId}&lang=en`;
    if (add(u)) urls.push(u);
  }
  return urls;
}

/**
 * Scrape the m3u8 stream URL for a live match.
 * Tries channel mobile_links and link pages first (from the API channels array),
 * then falls back to the generic edge frame.php URL.
 *
 * @param {string}   matchId    - hes-goal match ID
 * @param {string[]} edges      - e.g. ["a5","a6","a7","a8"]
 * @param {string}   edgeDomain - e.g. "kora-plus.app"
 * @param {number}   timeoutMs
 * @param {object[]} channels   - channels array from getMatchDetail()
 * @returns {{ url: string, expiresAt: Date|null }|null}
 */
async function scrapeM3u8(matchId, edges, edgeDomain, timeoutMs = 30000, channels = []) {
  const candidates = buildCandidateUrls(matchId, edges, edgeDomain, channels);
  if (!candidates.length) return null;

  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const ctx = await browser.newContext({
      userAgent: randomUA(),
      viewport: { width: 1280, height: 720 },
    });

    let foundUrl     = null;
    let foundHeaders = null;
    const pendingReqHeaders = new Map();

    ctx.on('request', (req) => {
      const url = req.url();
      if (url.includes('.m3u8')) pendingReqHeaders.set(url, req.headers());
    });

    ctx.on('response', async (res) => {
      try {
        const url = res.url();
        if (!foundUrl && url.includes('.m3u8') && res.status() === 200) {
          foundUrl = url;
          const reqH = pendingReqHeaders.get(url) || {};
          let cookieStr = '';
          try {
            const cookies = await ctx.cookies();
            cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
          } catch (_) {}
          foundHeaders = {
            'User-Agent': reqH['user-agent'] || reqH['User-Agent'] || randomUA(),
            ...(reqH['referer']  || reqH['Referer']  ? { Referer: reqH['referer']  || reqH['Referer']  } : {}),
            ...(reqH['origin']   || reqH['Origin']   ? { Origin:  reqH['origin']   || reqH['Origin']   } : {}),
            ...(cookieStr ? { Cookie: cookieStr } : {}),
          };
          console.log('[hesgoal-scraper] m3u8 (200):', url.slice(0, 120));
        }
      } catch (_) {}
    });

    const page = await ctx.newPage();

    for (const candidateUrl of candidates) {
      if (foundUrl) break;
      console.log('[hesgoal-scraper] Trying:', candidateUrl.slice(0, 100));
      try {
        await page.goto(candidateUrl, { waitUntil: 'domcontentloaded', timeout: 18000 });
        await page.waitForTimeout(2000);

        // Click play button if visible
        for (const sel of PLAY_SELECTORS) {
          try { const el = await page.$(sel); if (el) { await el.click({ timeout: 1500 }); break; } } catch (_) {}
        }

        // Wait up to 10s for m3u8
        const deadline = Date.now() + 10000;
        while (!foundUrl && Date.now() < deadline) {
          await page.waitForTimeout(400);
        }

        // Also check nested iframes (e.g. reddit-soccer-streams embeds another player)
        if (!foundUrl) {
          const iframes = await page.$$eval('iframe[src]',
            (els) => els.map((e) => e.src).filter((s) => s?.startsWith('http'))
          ).catch(() => []);
          for (const src of iframes.slice(0, 3)) {
            if (foundUrl) break;
            try {
              const ip = await ctx.newPage();
              await ip.goto(src, { waitUntil: 'domcontentloaded', timeout: 12000 });
              await ip.waitForTimeout(2000);
              for (const sel of PLAY_SELECTORS) {
                try { const el = await ip.$(sel); if (el) { await el.click({ timeout: 1500 }); break; } } catch (_) {}
              }
              const dl2 = Date.now() + 8000;
              while (!foundUrl && Date.now() < dl2) await ip.waitForTimeout(400);
              await ip.close().catch(() => {});
            } catch (_) {}
          }
        }
      } catch (err) {
        console.warn('[hesgoal-scraper] Candidate failed:', candidateUrl.slice(0, 80), '-', err.message.slice(0, 60));
      }
    }

    if (!foundUrl) return null;

    let expiresAt = null;
    try {
      const u   = new URL(foundUrl);
      const exp = u.searchParams.get('exp') || u.searchParams.get('expires') || u.searchParams.get('expiry');
      if (exp && /^\d+$/.test(exp)) expiresAt = new Date(parseInt(exp, 10) * 1000);
    } catch (_) {}

    return { url: foundUrl, expiresAt, headers: foundHeaders };
  } catch (err) {
    console.error('[hesgoal-scraper] scrapeM3u8 error:', err.message);
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { getMatchList, getMatchDetail, scrapeM3u8 };
