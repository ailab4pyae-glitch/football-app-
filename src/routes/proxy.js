const db = require('../config/database');

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'];
const MAX_SIZE = 2 * 1024 * 1024; // 2 MB

const STREAM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

const REFERER_BY_SOURCE = {
  chinalive: 'https://yyzbw8.live/',
  socolive:  'https://www.socolive.tv/',
};

module.exports = async function (fastify) {
  // ─── Stream m3u8 proxy ────────────────────────────────────────────────────────
  // Fetches the latest CDN URL from DB and proxies the m3u8 playlist content.
  // Segment URLs inside the playlist are rewritten to absolute CDN URLs so the
  // player fetches them directly — only the tiny playlist goes through this proxy.
  // The proxy URL (/api/proxy/stream/:id) never changes, so the player never
  // remounts and auth_key expiry is handled transparently on each playlist refresh.
  fastify.get('/api/proxy/stream/:id', async (request, reply) => {
    const { id } = request.params;
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(id)) {
      reply.code(400);
      return { error: 'Invalid stream id' };
    }

    const { rows } = await db.query(
      'SELECT url, source_name FROM stream_urls WHERE id = $1 LIMIT 1',
      [id]
    );
    if (!rows.length) {
      reply.code(404);
      return { error: 'Stream not found' };
    }

    const { url: cdnUrl, source_name } = rows[0];
    const referer = REFERER_BY_SOURCE[source_name] || null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetch(cdnUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': STREAM_UA,
          ...(referer ? { 'Referer': referer } : {}),
        },
      });

      if (!res.ok) {
        // Mark unhealthy so health job and next scrape refresh the URL
        await db.query('UPDATE stream_urls SET is_healthy = false WHERE id = $1', [id]).catch(() => {});
        reply.code(502);
        return { error: 'CDN unavailable' };
      }

      let m3u8 = await res.text();

      // Rewrite relative segment/playlist URLs to absolute so player hits CDN directly
      const base = new URL(cdnUrl);
      const basePath = base.href.substring(0, base.href.lastIndexOf('/') + 1);
      m3u8 = m3u8.replace(/^([^#\r\n].+)$/gm, (line) => {
        if (line.startsWith('http')) return line;
        if (line.startsWith('/')) return `${base.origin}${line}`;
        return `${basePath}${line}`;
      });

      reply
        .header('Content-Type', 'application/vnd.apple.mpegurl')
        .header('Cache-Control', 'no-store, no-cache')
        .header('Access-Control-Allow-Origin', '*')
        .send(m3u8);
    } catch (err) {
      if (err.name === 'AbortError') { reply.code(504); return { error: 'Timeout' }; }
      reply.code(502);
      return { error: 'Proxy error' };
    } finally {
      clearTimeout(timer);
    }
  });

  fastify.get('/api/proxy/logo', async (request, reply) => {
    const { url } = request.query;
    if (!url) {
      reply.code(400);
      return { error: 'Missing url parameter' };
    }

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reply.code(400);
      return { error: 'Invalid URL' };
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      reply.code(400);
      return { error: 'Only http/https allowed' };
    }

    const host = parsed.hostname;
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
      reply.code(403);
      return { error: 'Forbidden' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    try {
      const REFERER_MAP = {
        'sta.yyzb456.top': 'https://yyzbw8.live/',
      };
      const referer = REFERER_MAP[parsed.hostname] || null;

      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept':     'image/*,*/*;q=0.8',
          ...(referer ? { 'Referer': referer } : {}),
        },
      });

      const ct = res.headers.get('content-type') || '';
      if (!ALLOWED_TYPES.some((t) => ct.startsWith(t))) {
        reply.code(415);
        return { error: 'Not an image' };
      }

      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_SIZE) {
        reply.code(413);
        return { error: 'Image too large' };
      }

      reply
        .code(200)
        .header('Content-Type', ct.split(';')[0].trim())
        .header('Cache-Control', 'public, max-age=86400')
        .send(buf);
    } catch (err) {
      if (err.name === 'AbortError') {
        reply.code(504);
        return { error: 'Timeout' };
      }
      fastify.log.warn(`[proxy/logo] fetch failed for ${url}: ${err.message}`);
      reply.code(502);
      return { error: 'Request failed' };
    } finally {
      clearTimeout(timer);
    }
  });
};
