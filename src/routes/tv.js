const db    = require('../config/database');
const redis = require('../config/redis');

const CACHE_TTL = 120; // 2 minutes

module.exports = async function (fastify) {

  // ── Public: list all active channels ────────────────────────────────────────
  fastify.get('/api/tv', async (request) => {
    const { type } = request.query; // ?type=tv | ?type=radio
    const cacheKey = `tv:${type || 'all'}`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (_) {}

    const where = type ? 'WHERE is_active = true AND type = $1' : 'WHERE is_active = true';
    const params = type ? [type] : [];

    const { rows } = await db.query(
      `SELECT id, name, slug, type, category, emoji, color, logo_url, stream_url,
              position, country, language
       FROM tv_channels
       ${where}
       ORDER BY category, position, name`,
      params
    );

    const apiBase = `${request.protocol}://${request.headers.host}`;

    // Group by category; replace stream_url with backend proxy URL so the player
    // never hits the CDN directly (avoids CORS + adds correct Referer header)
    const grouped = {};
    for (const ch of rows) {
      if (!grouped[ch.category]) grouped[ch.category] = [];
      grouped[ch.category].push({
        ...ch,
        stream_url: ch.stream_url ? `${apiBase}/api/proxy/tv/${ch.id}` : null,
      });
    }
    const result = Object.entries(grouped).map(([category, channels]) => ({ category, channels }));

    try { await redis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL); } catch (_) {}
    return result;
  });

  // ── Public: single channel ───────────────────────────────────────────────────
  fastify.get('/api/tv/:id', async (request, reply) => {
    const { id } = request.params;
    const cacheKey = `tv:channel:${id}`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (_) {}

    const { rows } = await db.query(
      `SELECT id, name, slug, type, category, emoji, color, logo_url, stream_url
       FROM tv_channels WHERE id = $1 AND is_active = true`,
      [id]
    );

    if (!rows.length) { reply.code(404); return { error: 'Channel not found' }; }

    const ch = rows[0];
    const apiBase = `${request.protocol}://${request.headers.host}`;
    const result = {
      ...ch,
      stream_url: ch.stream_url ? `${apiBase}/api/proxy/tv/${ch.id}` : null,
    };

    try { await redis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL); } catch (_) {}
    return result;
  });

  // ── Admin: full CRUD ─────────────────────────────────────────────────────────

  const bustCache = async () => {
    try {
      const keys = await redis.keys('tv:*');
      if (keys.length) await redis.del(...keys);
    } catch (_) {}
  };

  fastify.get('/api/admin/tv', async () => {
    const { rows } = await db.query(
      `SELECT id, name, slug, type, category, emoji, color, logo_url, stream_url,
              is_active, position, country, language, created_at, updated_at
       FROM tv_channels
       ORDER BY type, category, position, name`
    );
    return rows;
  });

  fastify.post('/api/admin/tv', async (request, reply) => {
    const {
      name, slug, type = 'tv', category = 'General',
      emoji = '📺', color = '#00FF87', logo_url, stream_url,
      is_active = true, position = 0, country, language,
    } = request.body || {};

    if (!name) { reply.code(400); return { error: 'name is required' }; }

    const baseSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    // Find a unique slug by appending -2, -3, etc. if taken
    let uniqueSlug = baseSlug;
    let suffix = 2;
    while (true) {
      const exists = await db.query('SELECT 1 FROM tv_channels WHERE slug = $1 LIMIT 1', [uniqueSlug]);
      if (!exists.rows.length) break;
      uniqueSlug = `${baseSlug}-${suffix++}`;
    }

    try {
      const { rows } = await db.query(
        `INSERT INTO tv_channels
           (name, slug, type, category, emoji, color, logo_url, stream_url,
            is_active, position, country, language)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [name, uniqueSlug, type, category, emoji, color,
         logo_url || null, stream_url || null, is_active, position,
         country || 'Myanmar', language || 'Burmese']
      );
      await bustCache();
      reply.code(201);
      return rows[0];
    } catch (err) {
      reply.code(500);
      return { error: 'Failed to create channel' };
    }
  });

  fastify.put('/api/admin/tv/:id', async (request, reply) => {
    const { id } = request.params;
    const {
      name, category, emoji, color, logo_url, stream_url,
      is_active, position, country, language,
    } = request.body || {};

    const { rows } = await db.query(
      `UPDATE tv_channels
       SET name       = COALESCE($1, name),
           category   = COALESCE($2, category),
           emoji      = COALESCE($3, emoji),
           color      = COALESCE($4, color),
           logo_url   = $5,
           stream_url = $6,
           is_active  = COALESCE($7, is_active),
           position   = COALESCE($8, position),
           country    = COALESCE($9, country),
           language   = COALESCE($10, language),
           updated_at = NOW()
       WHERE id = $11
       RETURNING *`,
      [name, category, emoji, color,
       logo_url !== undefined ? (logo_url || null) : undefined,
       stream_url !== undefined ? (stream_url || null) : undefined,
       is_active, position, country, language, id]
    );

    if (!rows.length) { reply.code(404); return { error: 'Channel not found' }; }
    await bustCache();
    return rows[0];
  });

  fastify.delete('/api/admin/tv/:id', async (request, reply) => {
    const { id } = request.params;
    const { rowCount } = await db.query('DELETE FROM tv_channels WHERE id = $1', [id]);
    if (!rowCount) { reply.code(404); return { error: 'Channel not found' }; }
    await bustCache();
    reply.code(204);
    return null;
  });

  // ── Admin: fetch logo from Wikipedia for a channel ──────────────────────────
  fastify.post('/api/admin/tv/:id/fetch-logo', async (request, reply) => {
    const { id } = request.params;

    const { rows } = await db.query('SELECT name, slug FROM tv_channels WHERE id = $1', [id]);
    if (!rows.length) { reply.code(404); return { error: 'Channel not found' }; }

    const { name, slug } = rows[0];
    const logoUrl = await searchLogo(name, slug);
    if (!logoUrl) return { logo_url: null, message: 'No logo found' };

    await db.query('UPDATE tv_channels SET logo_url = $1, updated_at = NOW() WHERE id = $2', [logoUrl, id]);
    await bustCache();
    return { logo_url: logoUrl };
  });

  // ── Admin: bulk fetch logos for all channels missing one ─────────────────────
  fastify.post('/api/admin/tv/fetch-logos-bulk', async (_request, _reply) => {
    const { rows } = await db.query(
      `SELECT id, name, slug FROM tv_channels WHERE logo_url IS NULL OR logo_url = ''`
    );
    const results = [];
    for (const ch of rows) {
      const logoUrl = await searchLogo(ch.name, ch.slug);
      if (logoUrl) {
        await db.query('UPDATE tv_channels SET logo_url = $1, updated_at = NOW() WHERE id = $2', [logoUrl, ch.id]);
        results.push({ id: ch.id, name: ch.name, logo_url: logoUrl });
      }
      await new Promise(r => setTimeout(r, 250)); // gentle rate-limit
    }
    await bustCache();
    return { updated: results.length, channels: results };
  });
};

// ── Logo search + download to server ──────────────────────────────────────────
const fs   = require('fs');
const path = require('path');

const LOGOS_DIR  = path.join(__dirname, '../../public/logos');
const WIKI_UA    = 'FootballApp/1.0 (contact@example.com)';
const ALLOWED_CT = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/gif'];

// Verified logo URLs — all tested and confirmed working
const KNOWN_LOGOS = {
  // International — verified from Wikipedia API
  'cnn':          'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9d/CNN_Logo_%282014%29.svg/500px-CNN_Logo_%282014%29.svg.png',
  'bbc news':     'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a2/BBC_News_2022_%28Alt%29.svg/500px-BBC_News_2022_%28Alt%29.svg.png',
  'bbc':          'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a2/BBC_News_2022_%28Alt%29.svg/500px-BBC_News_2022_%28Alt%29.svg.png',
  'al jazeera':   'https://www.aljazeera.com/images/logo_aje_social.png',
  'espn':         'https://a1.espncdn.com/combiner/i?img=%2Fi%2Fespn%2Fespn_logos%2Fespn_red.png',
  'fox sports':   'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0c/Fox_Sports_1_logo.svg/500px-Fox_Sports_1_logo.svg.png',
  'sky sports':   'https://upload.wikimedia.org/wikipedia/en/thumb/d/d1/Sky_Sports_logo_2017.svg/500px-Sky_Sports_logo_2017.svg.png',
  'sky news':     'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4a/Sky_News_International_logo.svg/500px-Sky_News_International_logo.svg.png',
  'eurosport':    'https://upload.wikimedia.org/wikipedia/commons/thumb/8/88/Eurosport_logo_2015.svg/500px-Eurosport_logo_2015.svg.png',
  'beinsport':    'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e4/BeIN_Sports_logo.svg/500px-BeIN_Sports_logo.svg.png',
  'bein sport':   'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e4/BeIN_Sports_logo.svg/500px-BeIN_Sports_logo.svg.png',
  'dazn':         'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a2/DAZN_Logo.svg/500px-DAZN_Logo.svg.png',
  'bt sport':     'https://upload.wikimedia.org/wikipedia/en/thumb/0/0f/BT_Sport_logo.svg/500px-BT_Sport_logo.svg.png',
  'discovery':    'https://upload.wikimedia.org/wikipedia/commons/thumb/2/24/Discovery_Channel_logo_2019.svg/500px-Discovery_Channel_logo_2019.svg.png',
  'national geographic': 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5a/National_Geographic_Channel_new_logo.svg/500px-National_Geographic_Channel_new_logo.svg.png',
  'cartoon network':     'https://upload.wikimedia.org/wikipedia/commons/thumb/8/80/Cartoon_Network_2010_logo.svg/500px-Cartoon_Network_2010_logo.svg.png',
  // Myanmar — verified from Wikimedia Commons
  'mrtv':         'https://upload.wikimedia.org/wikipedia/commons/b/bb/Mrtvchannellogo.png',
  'mrtv-4':       'https://upload.wikimedia.org/wikipedia/commons/b/bb/Mrtvchannellogo.png',
};

const makeSlug = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function downloadAndSave(externalUrl, slug) {
  try {
    fs.mkdirSync(LOGOS_DIR, { recursive: true });
    const isWiki = externalUrl.includes('wikimedia.org') || externalUrl.includes('wikipedia.org');
    const res = await fetch(externalUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(isWiki ? { 'Referer': 'https://en.wikipedia.org/' } : {}),
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ALLOWED_CT.some(t => ct.startsWith(t))) return null;

    const ext = ct.includes('svg') ? 'svg' : ct.includes('png') ? 'png'
              : ct.includes('webp') ? 'webp' : 'jpg';
    const filename = `${slug}.${ext}`;
    const filepath = path.join(LOGOS_DIR, filename);

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 2 * 1024 * 1024) return null;
    fs.writeFileSync(filepath, buf);

    const backendUrl = (process.env.BACKEND_URL || 'http://localhost:3050').replace(/\/$/, '');
    return `${backendUrl}/public/logos/${filename}`;
  } catch (_) { return null; }
}

async function wikiGet(url, attempt = 0) {
  await sleep(1000 + attempt * 2000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': WIKI_UA },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 429 && attempt < 2) {
      console.log('[logo] Wikipedia rate limited, retrying...');
      return wikiGet(url, attempt + 1);
    }
    if (!res.ok) return null;
    const text = await res.text();
    if (text.startsWith('You are making')) return null; // still rate limited
    return JSON.parse(text);
  } catch (_) { return null; }
}

// Only accept Wikipedia images that are clearly logos — filename must contain "logo" or be SVG
const isLogoImage = (url = '') => {
  const lower = url.toLowerCase();
  const filename = lower.split('/').pop().split('?')[0];
  return filename.includes('logo') || filename.endsWith('.svg');
};

async function wikiThumb(title) {
  const data = await wikiGet(
    `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=pageimages&format=json&pithumbsize=400&redirects=1`
  );
  if (!data) return null;
  const pages = Object.values(data?.query?.pages || {});
  const thumb = pages[0]?.thumbnail?.source;
  if (!thumb || !isLogoImage(thumb)) return null;
  return thumb;
}

async function wikiSearch(query) {
  const data = await wikiGet(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=1`
  );
  return data?.query?.search?.[0]?.title || null;
}

async function searchLogo(name, slug) {
  const key = name.toLowerCase();
  console.log(`[logo] searching: ${name}`);

  // 1. Known logo map (Myanmar + popular channels)
  for (const [k, url] of Object.entries(KNOWN_LOGOS)) {
    if (key.includes(k)) {
      console.log(`[logo] known map hit: ${k} → ${url.slice(0, 70)}`);
      const saved = await downloadAndSave(url, slug || makeSlug(name));
      if (saved) { console.log(`[logo] saved to server → ${saved}`); return saved; }
      // Download blocked (CDN rate limit) — store external URL, proxy serves it
      console.log(`[logo] download blocked, storing external URL`);
      return url;
    }
  }

  // 2. Wikipedia direct title
  let thumb = await wikiThumb(name);
  if (!thumb) {
    // 3. Wikipedia search
    const found = await wikiSearch(name + ' television channel');
    if (found) thumb = await wikiThumb(found);
  }
  if (!thumb) {
    // 4. Broader Wikipedia search
    const found = await wikiSearch(name);
    if (found) thumb = await wikiThumb(found);
  }

  if (thumb) {
    console.log(`[logo] Wikipedia found: ${thumb.slice(0, 80)}`);
    const saved = await downloadAndSave(thumb, slug || makeSlug(name));
    if (saved) { console.log(`[logo] saved → ${saved}`); return saved; }
    // Fallback: return external URL if download fails
    return thumb;
  }

  console.log(`[logo] not found: ${name}`);
  return null;
}
