// Myanmar TV / Radio proxy
//
// Two routes:
//   /api/proxy/tv/:id          — fetches m3u8 for a TV channel by DB id, rewrites child
//                                playlist URLs through tv-passthrough
//   /api/proxy/tv-passthrough  — proxies any myanmartvchannels.com CDN request
//                                (both m3u8 playlists and .ts segments) with the
//                                required Referer/Origin headers

const db = require('../../config/database');
const { STREAM_UA } = require('./shared');

const TV_REFERER = 'https://www.myanmartvchannels.com/';
const TV_ORIGIN  = 'https://www.myanmartvchannels.com';

module.exports = async (fastify) => {
  // ── /api/proxy/tv-passthrough ───────────────────────────────────────────────
  // Proxies ALL myanmartvchannels.com CDN requests so the browser never needs
  // to set Referer (restricted header). m3u8 inner URLs are rewritten back
  // through this same endpoint. .ts segments are buffered and returned as binary.
  fastify.get('/api/proxy/tv-passthrough', async (request, reply) => {
    const { url } = request.query;
    if (!url) { reply.code(400); return { error: 'Missing url' }; }

    let decoded;
    try { decoded = decodeURIComponent(url); } catch { reply.code(400); return { error: 'Bad url' }; }

    const isTsSegment = /\.ts(\?|$)/i.test(decoded);
    const isM3u8      = /\.m3u8(\?|$)/i.test(decoded);
    const controller  = new AbortController();
    const timer       = setTimeout(() => controller.abort(), isTsSegment ? 20000 : 10000);

    try {
      const res = await fetch(decoded, {
        signal:  controller.signal,
        headers: { 'User-Agent': STREAM_UA, Referer: TV_REFERER, Origin: TV_ORIGIN, Accept: '*/*' },
      });

      if (!res.ok) {
        reply.code(res.status === 403 ? 403 : 502);
        return { error: res.status === 403 ? 'Token expired' : 'CDN error' };
      }

      reply.header('Access-Control-Allow-Origin', '*');

      if (isTsSegment) {
        reply.header('Content-Type', 'video/MP2T').header('Cache-Control', 'no-store');
        return reply.send(Buffer.from(await res.arrayBuffer()));
      }

      if (isM3u8) {
        const apiBase  = `${request.protocol}://${request.headers.host}`;
        const base     = new URL(decoded);
        const basePath = base.href.substring(0, base.href.lastIndexOf('/') + 1);
        let body = await res.text();
        body = body.replace(/^([^#\r\n].+)$/gm, (line) => {
          const abs = line.startsWith('http') ? line
                    : line.startsWith('/')    ? `${base.origin}${line}`
                    : `${basePath}${line}`;
          return `${apiBase}/api/proxy/tv-passthrough?url=${encodeURIComponent(abs)}`;
        });
        return reply
          .header('Content-Type', 'application/vnd.apple.mpegurl')
          .header('Cache-Control', 'no-store, no-cache')
          .send(body);
      }

      // Unknown content type — pass through as-is
      const buf = Buffer.from(await res.arrayBuffer());
      reply.header('Content-Type', res.headers.get('content-type') || 'application/octet-stream');
      return reply.send(buf);

    } catch (err) {
      if (err.name === 'AbortError') { reply.code(504); return { error: 'Timeout' }; }
      reply.code(502);
      return { error: 'Proxy error' };
    } finally {
      clearTimeout(timer);
    }
  });

  // ── /api/proxy/tv/:id ───────────────────────────────────────────────────────
  // Fetches the m3u8 for a TV channel by its DB UUID, rewrites child m3u8 URLs
  // through tv-passthrough (so Referer is always sent). Segment URLs are kept
  // as absolute CDN URLs (no auth required for .ts segments on this CDN).
  fastify.get('/api/proxy/tv/:id', async (request, reply) => {
    const { id } = request.params;
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(id)) { reply.code(400); return { error: 'Invalid id' }; }

    const { rows } = await db.query(
      'SELECT stream_url FROM tv_channels WHERE id = $1 AND is_active = true LIMIT 1',
      [id]
    );
    if (!rows.length || !rows[0].stream_url) { reply.code(404); return { error: 'Channel or stream URL not found' }; }

    const cdnUrl     = rows[0].stream_url;
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), 10000);

    try {
      const res = await fetch(cdnUrl, {
        signal:  controller.signal,
        headers: { 'User-Agent': STREAM_UA, Referer: TV_REFERER, Origin: TV_ORIGIN, Accept: '*/*' },
      });

      if (!res.ok) {
        reply.code(res.status === 403 ? 403 : 502);
        return { error: res.status === 403 ? 'Auth token expired — update URL in Admin → TV & Radio' : 'CDN unavailable' };
      }

      let m3u8 = await res.text();
      const base     = new URL(cdnUrl);
      const basePath = base.href.substring(0, base.href.lastIndexOf('/') + 1);
      const apiBase  = (process.env.BACKEND_URL || `${request.protocol}://${request.headers.host}`).replace(/\/$/, '');

      m3u8 = m3u8.replace(/^([^#\r\n].+)$/gm, (line) => {
        const abs = line.startsWith('http') ? line
                  : line.startsWith('/')    ? `${base.origin}${line}`
                  : `${basePath}${line}`;
        return abs.includes('.m3u8')
          ? `${apiBase}/api/proxy/tv-passthrough?url=${encodeURIComponent(abs)}`
          : abs;
      });

      return reply
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
};
