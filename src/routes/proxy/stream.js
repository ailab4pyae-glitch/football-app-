// Generic stream proxy dispatcher — /api/proxy/stream/:id and /api/proxy/flv/:id
//
// Reads source_name from the stream record and delegates to the correct handler:
//   chinalive → china.js  (SSL bypass, Referer/Origin, CDN token rotation)
//   socolive  → soco.js   (standard fetch, SOCO Referer)
//   others    → inline    (standard fetch, optional Referer)

const https = require('https');
const http  = require('http');
const db    = require('../../config/database');
const { STREAM_UA, getStreamRecord, invalidateStream, invalidateMatchCache, invalidateMatchStreams, getM3u8Cached } = require('./shared');
const china = require('./china');
const soco  = require('./soco');

// Debounced re-scrape: when any China stream fails, immediately fire a background
// re-scrape for that match so fresh tokens are ready before the player exhausts
// all servers. One scrape per match at a time — Set prevents concurrent duplicates.
const pendingScrapes = new Set();
const triggerRescrape = (matchId) => {
  if (!matchId || pendingScrapes.has(matchId)) return;
  pendingScrapes.add(matchId);
  setImmediate(async () => {
    try {
      const { runForMatch } = require('../../scrapers/chinalive');
      const redis = require('../../config/redis');
      console.log(`[CHINA-RESCRAPE] Triggering background re-scrape for match=${matchId}`);
      const ok = await runForMatch(matchId, { fast: true });
      if (ok) {
        await redis.del(`streams:${matchId}`).catch(() => {});
        invalidateMatchStreams(matchId);
        console.log(`[CHINA-RESCRAPE] Done match=${matchId} — Redis cleared, fresh tokens in DB`);
      } else {
        console.warn(`[CHINA-RESCRAPE] No live rooms found for match=${matchId}`);
      }
    } catch (err) {
      console.error(`[CHINA-RESCRAPE] Error match=${matchId}:`, err.message);
    } finally {
      pendingScrapes.delete(matchId);
    }
  });
};

const REFERER_BY_SOURCE = {
  chinalive: 'https://yyzbw8.live/',
  socolive:  soco.SOCO_REFERER,
};

// Standard m3u8 fetch for any source not handled by a dedicated module
const fetchOtherM3u8 = async (cdnUrl, referer) => {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(cdnUrl, {
      signal:  controller.signal,
      headers: { 'User-Agent': STREAM_UA, ...(referer ? { Referer: referer } : {}) },
    });
    if (!res.ok) throw Object.assign(new Error('CDN unavailable'), { status: res.status });
    return res.text();
  } finally {
    clearTimeout(timer);
  }
};

const rewriteOtherM3u8 = (body, base, basePath) =>
  body.replace(/^([^#\r\n].+)$/gm, (line) => {
    if (line.startsWith('http')) return line;
    if (line.startsWith('/')) return `${base.origin}${line}`;
    return `${basePath}${line}`;
  });

// ─── Fastify plugin ───────────────────────────────────────────────────────────
module.exports = async (fastify) => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // ── /api/proxy/stream/:id — m3u8 playlist proxy ────────────────────────────
  fastify.get('/api/proxy/stream/:id', async (request, reply) => {
    const { id } = request.params;
    if (!UUID_RE.test(id)) { reply.code(400); return { error: 'Invalid stream id' }; }

    const record = await getStreamRecord(id);
    if (!record) { reply.code(404); return { error: 'Stream not found' }; }

    const { url: cdnUrl, source_name } = record;
    const referer = REFERER_BY_SOURCE[source_name] || null;
    const apiBase = (process.env.BACKEND_URL || `${request.protocol}://${request.headers.host}`).replace(/\/$/, '');
    const base     = new URL(cdnUrl);
    const basePath = base.href.substring(0, base.href.lastIndexOf('/') + 1);

    const markUnhealthy = () => {
      if (source_name === 'chinalive') {
        console.warn(`[CHINA-FAIL] CDN error on stream ${id} match=${record.match_id} url=${cdnUrl.slice(0, 90)}`);
        db.query(
          'UPDATE stream_urls SET is_healthy = false, expires_at = NOW() WHERE id = $1',
          [id]
        ).catch(() => {});
        invalidateMatchCache(id, record.match_id);
        console.warn(`[CHINA-FAIL] Redis + in-memory cache busted for match=${record.match_id}`);
        // Fire background re-scrape immediately — by the time the player exhausts
        // all servers (30s), fresh tokens will already be in DB and Redis.
        triggerRescrape(record.match_id);
        return;
      }
      invalidateStream(id);
      return db.query('UPDATE stream_urls SET is_healthy = false, expires_at = NOW() WHERE id = $1', [id]).catch(() => {});
    };

    let m3u8;
    try {
      if (source_name === 'chinalive') {
        const raw = await getM3u8Cached(cdnUrl, () => china.fetchM3u8(cdnUrl));
        m3u8 = china.rewriteM3u8(raw, base, basePath, apiBase);
      } else if (source_name === 'socolive') {
        const raw = await getM3u8Cached(cdnUrl, () => soco.fetchM3u8(cdnUrl));
        m3u8 = soco.rewriteM3u8(raw, base, basePath);
      } else if (source_name === 'hesgoal' || source_name?.startsWith('hesgoal:')) {
        const stored = record.headers || {};
        const fetchHesgoal = async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8000);
          try {
            const res = await fetch(cdnUrl, {
              signal: controller.signal,
              headers: {
                'User-Agent': stored['User-Agent'] || STREAM_UA,
                ...(stored['Referer'] ? { Referer: stored['Referer'] } : {}),
                ...(stored['Origin']  ? { Origin:  stored['Origin']  } : {}),
                ...(stored['Cookie']  ? { Cookie:  stored['Cookie']  } : {}),
              },
            });
            if (!res.ok) throw Object.assign(new Error('CDN unavailable'), { status: res.status });
            return res.text();
          } finally {
            clearTimeout(timer);
          }
        };
        const raw = await getM3u8Cached(cdnUrl, fetchHesgoal);
        m3u8 = rewriteOtherM3u8(raw, base, basePath);
      } else {
        const raw = await getM3u8Cached(cdnUrl, () => fetchOtherM3u8(cdnUrl, referer));
        m3u8 = rewriteOtherM3u8(raw, base, basePath);
      }
    } catch (err) {
      await markUnhealthy();
      if (err.name === 'AbortError' || err.message === 'timeout') { reply.code(504); return { error: 'Timeout' }; }
      reply.code(502);
      return { error: 'CDN unavailable' };
    }

    return reply
      .header('Content-Type', 'application/vnd.apple.mpegurl')
      .header('Cache-Control', 'no-store, no-cache')
      .header('Access-Control-Allow-Origin', '*')
      .send(m3u8);
  });

  // ── /api/proxy/flv/:id — FLV binary pipe ───────────────────────────────────
  // FLV is a continuous binary stream — cannot buffer. Pipes directly to the client.
  // SSL bypass applied for all sources (China CDNs need it; harmless for others).
  fastify.get('/api/proxy/flv/:id', async (request, reply) => {
    const { id } = request.params;
    if (!UUID_RE.test(id)) { reply.code(400); return { error: 'Invalid id' }; }

    const record = await getStreamRecord(id);
    if (!record) { reply.code(404); return { error: 'Stream not found' }; }

    const { url: streamUrl, source_name } = record;
    const referer  = REFERER_BY_SOURCE[source_name] || null;
    const sslAgent = new https.Agent({ rejectUnauthorized: false });

    // Some scrapers save an m3u8 URL as the "FLV" entry — handle transparently
    if (/\.m3u8(\?|$)/i.test(streamUrl)) {
      const m3u8Body = await new Promise((resolve, reject) => {
        const proto = streamUrl.startsWith('https') ? https : http;
        const req   = proto.get(streamUrl, {
          agent:   sslAgent,
          headers: { 'User-Agent': STREAM_UA, ...(referer ? { Referer: referer } : {}) },
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
      });

      const base     = new URL(streamUrl);
      const basePath = base.href.substring(0, base.href.lastIndexOf('/') + 1);
      const apiBase  = (process.env.BACKEND_URL || `${request.protocol}://${request.headers.host}`).replace(/\/$/, '');
      const m3u8 = m3u8Body.replace(/^([^#\r\n].+)$/gm, (line) => {
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

    const proto = streamUrl.startsWith('https') ? https : http;
    return new Promise((resolve) => {
      const req = proto.get(streamUrl, {
        agent:   sslAgent,
        headers: {
          'User-Agent': STREAM_UA,
          ...(referer ? { Referer: referer, Origin: new URL(referer).origin } : {}),
          Accept: '*/*',
        },
      }, (upstream) => {
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
      });
      req.on('error', () => { if (!reply.raw.headersSent) reply.code(502).send({ error: 'CDN unreachable' }); resolve(); });
      request.raw.on('close', () => req.destroy());
    });
  });
};
