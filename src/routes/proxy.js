const db = require('../config/database');

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'];
const MAX_SIZE = 2 * 1024 * 1024; // 2 MB

const STREAM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

const REFERER_BY_SOURCE = {
  chinalive: 'https://yyzbw8.live/',
  socolive:  'https://socolivexx.tv/',
  xoilac:    'https://xl365.livepingscorex.com/',
};

// ─── In-memory stream URL cache ───────────────────────────────────────────────
// Avoids a DB round-trip on every HLS playlist refresh (every 2–5 s per viewer).
// Entry is valid until 5 min before the CDN URL's own expires_at, max 10 min.
const streamCache = new Map(); // id → { url, source_name, match_id, validUntil }

const getStreamRecord = async (id) => {
  const now    = Date.now();
  const cached = streamCache.get(id);
  if (cached && cached.validUntil > now) return cached;

  const { rows } = await db.query(
    'SELECT url, source_name, match_id, expires_at FROM stream_urls WHERE id = $1 LIMIT 1',
    [id]
  );
  if (!rows.length) return null;

  const row        = rows[0];
  const expiresMs  = row.expires_at ? new Date(row.expires_at).getTime() : now + 10 * 60 * 1000;
  const validUntil = Math.min(expiresMs - 5 * 60 * 1000, now + 10 * 60 * 1000);
  const entry      = { url: row.url, source_name: row.source_name, match_id: row.match_id, validUntil };
  streamCache.set(id, entry);
  return entry;
};

const invalidateStream = (id) => streamCache.delete(id);

// ─── China Live m3u8 fetcher ─────────────────────────────────────────────────
// China CDNs frequently use self-signed / mismatched SSL certs AND require both
// Referer + Origin.  Native fetch() cannot disable cert verification, so we use
// the https module directly with rejectUnauthorized: false.
const fetchChinaM3u8 = (url) => {
  const { Agent, get: httpsGet } = require('https');
  const { get: httpGet }         = require('http');
  const isHttps = url.startsWith('https');

  return new Promise((resolve, reject) => {
    const proto   = isHttps ? { get: httpsGet } : { get: httpGet };
    const options = {
      timeout: 8000,
      headers: {
        'User-Agent': STREAM_UA,
        Referer:      'https://yyzbw8.live/',
        Origin:       'https://yyzbw8.live',
        Accept:       '*/*',
      },
      ...(isHttps ? { agent: new Agent({ rejectUnauthorized: false }) } : {}),
    };

    const req = proto.get(url, options, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(Object.assign(new Error('CDN error'), { status: res.statusCode }));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end',  () => resolve(body));
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(Object.assign(new Error('timeout'), { name: 'AbortError' })); });
  });
};

module.exports = async function (fastify) {
  // ─── TV passthrough proxy ─────────────────────────────────────────────────────
  // Proxies ALL myanmartvchannels.com CDN requests (m3u8 playlists + .ts segments).
  // Adds Referer/Origin headers so the Nimble server accepts them.
  // m3u8 responses have their inner URLs rewritten back through this proxy.
  // .ts segments are streamed as binary so CORS never reaches the browser.
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
        signal: controller.signal,
        headers: {
          'User-Agent': STREAM_UA,
          'Referer':    'https://www.myanmartvchannels.com/',
          'Origin':     'https://www.myanmartvchannels.com',
          'Accept':     '*/*',
        },
      });

      if (!res.ok) {
        reply.code(res.status === 403 ? 403 : 502);
        return { error: res.status === 403 ? 'Token expired' : 'CDN error' };
      }

      reply.header('Access-Control-Allow-Origin', '*');

      if (isTsSegment) {
        // Binary video segment — stream directly back to the player
        reply
          .header('Content-Type', 'video/MP2T')
          .header('Cache-Control', 'no-store');
        const buf = Buffer.from(await res.arrayBuffer());
        return reply.send(buf);
      }

      if (isM3u8) {
        const apiBase = `${request.protocol}://${request.headers.host}`;
        const base    = new URL(decoded);
        const basePath = base.href.substring(0, base.href.lastIndexOf('/') + 1);
        let body = await res.text();

        // Rewrite ALL URL lines (both .m3u8 child playlists and .ts segments)
        // through this proxy so Referer is always added server-side
        body = body.replace(/^([^#\r\n].+)$/gm, (line) => {
          let abs = line;
          if (!line.startsWith('http')) {
            abs = line.startsWith('/') ? `${base.origin}${line}` : `${basePath}${line}`;
          }
          return `${apiBase}/api/proxy/tv-passthrough?url=${encodeURIComponent(abs)}`;
        });

        return reply
          .header('Content-Type', 'application/vnd.apple.mpegurl')
          .header('Cache-Control', 'no-store, no-cache')
          .send(body);
      }

      // Unknown type — pass through as-is
      const buf = Buffer.from(await res.arrayBuffer());
      reply.header('Content-Type', res.headers.get('content-type') || 'application/octet-stream');
      return reply.send(buf);

    } catch (err) {
      if (err.name === 'AbortError') { reply.code(504); return { error: 'Timeout' }; }
      reply.code(502); return { error: 'Proxy error' };
    } finally {
      clearTimeout(timer);
    }
  });

  // ─── TV / Radio channel proxy ─────────────────────────────────────────────────
  // Proxies m3u8 playlists for TV channels, adding the required Referer header
  // so Nimble Streamer / Wowza CDNs accept requests from our server.
  fastify.get('/api/proxy/tv/:id', async (request, reply) => {
    const { id } = request.params;
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(id)) { reply.code(400); return { error: 'Invalid id' }; }

    const { rows } = await db.query(
      'SELECT stream_url FROM tv_channels WHERE id = $1 AND is_active = true LIMIT 1',
      [id]
    );
    if (!rows.length || !rows[0].stream_url) {
      reply.code(404);
      return { error: 'Channel or stream URL not found' };
    }

    const cdnUrl = rows[0].stream_url;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    try {
      const res = await fetch(cdnUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': STREAM_UA,
          'Referer':    'https://www.myanmartvchannels.com/',
          'Origin':     'https://www.myanmartvchannels.com',
          'Accept':     '*/*',
        },
      });

      if (!res.ok) {
        reply.code(res.status === 403 ? 403 : 502);
        return { error: res.status === 403 ? 'Auth token expired — update URL in Admin → TV & Radio' : 'CDN unavailable' };
      }

      let m3u8 = await res.text();

      const base    = new URL(cdnUrl);
      const basePath = base.href.substring(0, base.href.lastIndexOf('/') + 1);
      const apiBase  = `${request.protocol}://${request.headers.host}`;

      // Rewrite every URL in the playlist:
      // - Relative → absolute
      // - Child m3u8 playlists → route through passthrough proxy (adds Referer, avoids CORS)
      // - .ts segments → keep as direct CDN URLs (no auth needed for segments)
      m3u8 = m3u8.replace(/^([^#\r\n].+)$/gm, (line) => {
        let abs = line;
        if (!line.startsWith('http')) {
          abs = line.startsWith('/') ? `${base.origin}${line}` : `${basePath}${line}`;
        }
        if (abs.includes('.m3u8')) {
          return `${apiBase}/api/proxy/tv-passthrough?url=${encodeURIComponent(abs)}`;
        }
        return abs;
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

  // ─── Stream m3u8 proxy ────────────────────────────────────────────────────────
  // Fetches the latest CDN URL from in-memory cache (fallback: DB) and proxies
  // the m3u8 playlist.  The stable proxy URL means the player never remounts and
  // auth_key rotation is transparent.
  //
  // chinalive: ALL lines (including .ts segments) routed through /api/proxy/china-ts
  //            which adds Referer + bypasses SSL cert issues on Chinese CDNs.
  // others:    segment URLs rewritten to absolute CDN URLs, fetched directly.
  fastify.get('/api/proxy/stream/:id', async (request, reply) => {
    const { id } = request.params;
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(id)) {
      reply.code(400);
      return { error: 'Invalid stream id' };
    }

    const record = await getStreamRecord(id);
    if (!record) {
      reply.code(404);
      return { error: 'Stream not found' };
    }

    const { url: cdnUrl, source_name } = record;
    const isChina = source_name === 'chinalive';
    const referer  = REFERER_BY_SOURCE[source_name] || null;
    const apiBase  = `${request.protocol}://${request.headers.host}`;

    const markUnhealthy = () => {
      invalidateStream(id);
      return db.query(
        'UPDATE stream_urls SET is_healthy = false, expires_at = NOW() WHERE id = $1',
        [id]
      ).catch(() => {});
    };

    let m3u8;
    try {
      if (isChina) {
        m3u8 = await fetchChinaM3u8(cdnUrl);
      } else {
        const controller = new AbortController();
        const timer      = setTimeout(() => controller.abort(), 8000);
        try {
          const res = await fetch(cdnUrl, {
            signal:  controller.signal,
            headers: { 'User-Agent': STREAM_UA, ...(referer ? { Referer: referer } : {}) },
          });
          if (!res.ok) {
            await markUnhealthy();
            reply.code(502);
            return { error: 'CDN unavailable' };
          }
          m3u8 = await res.text();
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (err) {
      await markUnhealthy();
      if (err.name === 'AbortError' || err.message === 'timeout') { reply.code(504); return { error: 'Timeout' }; }
      reply.code(502);
      return { error: 'CDN unavailable' };
    }

    const base     = new URL(cdnUrl);
    const basePath = base.href.substring(0, base.href.lastIndexOf('/') + 1);

    if (isChina) {
      // Route ALL content lines through china-ts so the CDN always sees our Referer
      m3u8 = m3u8.replace(/^([^#\r\n].+)$/gm, (line) => {
        const abs = line.startsWith('http') ? line
                  : line.startsWith('/')    ? `${base.origin}${line}`
                  : `${basePath}${line}`;
        if (abs.includes('.m3u8')) return `${apiBase}/api/proxy/stream/${id}`;
        return `${apiBase}/api/proxy/china-ts?url=${encodeURIComponent(abs)}`;
      });
    } else {
      m3u8 = m3u8.replace(/^([^#\r\n].+)$/gm, (line) => {
        if (line.startsWith('http')) return line;
        if (line.startsWith('/')) return `${base.origin}${line}`;
        return `${basePath}${line}`;
      });
    }

    return reply
      .header('Content-Type', 'application/vnd.apple.mpegurl')
      .header('Cache-Control', 'no-store, no-cache')
      .header('Access-Control-Allow-Origin', '*')
      .send(m3u8);
  });

  // ─── FLV stream proxy ─────────────────────────────────────────────────────────
  // Pipes the live FLV binary through the server so the correct Referer is sent
  // and the browser receives CORS headers. Cannot buffer (stream is infinite).
  fastify.get('/api/proxy/flv/:id', async (request, reply) => {
    const { id } = request.params;
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(id)) { reply.code(400); return { error: 'Invalid id' }; }

    const record = await getStreamRecord(id);
    if (!record) { reply.code(404); return { error: 'Stream not found' }; }

    const { url: streamUrl, source_name } = record;
    const referer = REFERER_BY_SOURCE[source_name] || 'https://xoilacct.tv/';

    // All scrapers now save the actual CDN URL directly (no channel proxy re-fetch needed).
    // SSL certs on some CDNs are self-signed — rejectUnauthorized:false required.
    const https = require('https');
    const http  = require('http');
    const sslAgent = new https.Agent({ rejectUnauthorized: false });

    if (/\.m3u8(\?|$)/i.test(streamUrl)) {
      // ── m3u8 path: fetch playlist, rewrite segment URLs, serve with CORS ───────
      const m3u8Body = await new Promise((resolve, reject) => {
        const proto = streamUrl.startsWith('https') ? https : http;
        const req   = proto.get(streamUrl, {
          agent: sslAgent,
          headers: { 'User-Agent': STREAM_UA, 'Referer': referer },
          timeout: 10000,
        }, (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return reject(Object.assign(new Error('CDN error'), { status: res.statusCode }));
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { body += c; });
          res.on('end',  () => resolve(body));
        });
        req.on('error',   reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      }).catch((err) => { throw err; });

      const base     = new URL(streamUrl);
      const basePath = base.href.substring(0, base.href.lastIndexOf('/') + 1);
      const apiBase  = `${request.protocol}://${request.headers.host}`;
      let m3u8 = m3u8Body.replace(/^([^#\r\n].+)$/gm, (line) => {
        const abs = line.startsWith('http') ? line
                  : line.startsWith('/')    ? `${base.origin}${line}`
                  : `${basePath}${line}`;
        return abs.includes('.m3u8') ? `${apiBase}/api/proxy/flv/${id}` : abs;
      });
      return reply
        .header('Content-Type', 'application/vnd.apple.mpegurl')
        .header('Cache-Control', 'no-store, no-cache')
        .header('Access-Control-Allow-Origin', '*')
        .send(m3u8);
    }

    // ── FLV path: pipe binary stream with rejectUnauthorized:false ───────────────
    const proto = streamUrl.startsWith('https') ? https : http;

    return new Promise((resolve) => {
      const req = proto.get(
        streamUrl,
        {
          agent: sslAgent,
          headers: {
            'User-Agent': STREAM_UA,
            'Referer':    referer,
            'Origin':     new URL(referer).origin,
            'Accept':     '*/*',
          },
        },
        (upstream) => {
          if (upstream.statusCode !== 200) {
            invalidateStream(id);
            db.query('UPDATE stream_urls SET is_healthy=false WHERE id=$1', [id]).catch(() => {});
            reply.code(502).send({ error: `CDN ${upstream.statusCode}` });
            upstream.resume();
            return resolve();
          }

          reply.raw.writeHead(200, {
            'Content-Type':                'video/x-flv',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control':               'no-cache, no-store',
            'Transfer-Encoding':           'chunked',
          });

          upstream.pipe(reply.raw);
          reply.raw.on('finish', resolve);
          reply.raw.on('close',  resolve);
          reply.raw.on('error',  resolve);
        }
      );

      req.on('error', () => {
        if (!reply.raw.headersSent) reply.code(502).send({ error: 'CDN unreachable' });
        resolve();
      });

      request.raw.on('close', () => req.destroy());
    });
  });

  // ─── China Live segment proxy ─────────────────────────────────────────────────
  // Pipes .ts segments (and any other China CDN binary) with:
  //   • Referer / Origin set to yyzbw8.live (required by Chinese CDNs)
  //   • rejectUnauthorized: false  (China CDNs often use self-signed / expired certs)
  //   • Streamed directly — no buffering, no size limit
  fastify.get('/api/proxy/china-ts', async (request, reply) => {
    const { url } = request.query;
    if (!url) { reply.code(400); return { error: 'Missing url' }; }

    let decoded;
    try { decoded = decodeURIComponent(url); } catch { reply.code(400); return { error: 'Bad url' }; }

    let parsedUrl;
    try { parsedUrl = new URL(decoded); } catch { reply.code(400); return { error: 'Invalid URL' }; }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) { reply.code(400); return { error: 'Bad protocol' }; }

    // SSRF: block private / loopback addresses
    const { hostname } = parsedUrl;
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname)) {
      reply.code(403); return { error: 'Forbidden' };
    }

    const https    = require('https');
    const http     = require('http');
    const isHttps  = decoded.startsWith('https');
    const sslAgent = new https.Agent({ rejectUnauthorized: false });
    const proto    = isHttps ? https : http;

    return new Promise((resolve) => {
      const req = proto.get(decoded, {
        agent:   isHttps ? sslAgent : undefined,
        timeout: 20000,
        headers: {
          'User-Agent': STREAM_UA,
          Referer:      'https://yyzbw8.live/',
          Origin:       'https://yyzbw8.live',
          Accept:       '*/*',
        },
      }, (upstream) => {
        if (upstream.statusCode !== 200) {
          reply.code(upstream.statusCode === 403 ? 403 : 502).send({ error: `CDN ${upstream.statusCode}` });
          upstream.resume();
          return resolve();
        }
        const ct = upstream.headers['content-type'] || 'video/MP2T';
        reply.raw.writeHead(200, {
          'Content-Type':                ct,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control':               'no-cache, no-store',
        });
        upstream.pipe(reply.raw);
        reply.raw.on('finish', resolve);
        reply.raw.on('close',  resolve);
        reply.raw.on('error',  resolve);
      });

      req.on('error',   () => { if (!reply.raw.headersSent) reply.code(502).send({ error: 'CDN unreachable' }); resolve(); });
      req.on('timeout', () => { req.destroy(); if (!reply.raw.headersSent) reply.code(504).send({ error: 'Timeout' }); resolve(); });
      request.raw.on('close', () => req.destroy());
    });
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
