// SOCO Live proxy — standard HTTPS fetch, no SSL bypass needed.
// CDN serves CORS headers so segment URLs can be returned as absolute
// and the browser fetches them directly (no per-segment proxy hop).

const { STREAM_UA } = require('./shared');

const SOCO_REFERER = 'https://soco.buzzscorelinez.com/';

// ─── Fetch m3u8 from SOCO CDN ─────────────────────────────────────────────────
const fetchM3u8 = async (cdnUrl) => {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(cdnUrl, {
      signal:  controller.signal,
      headers: { 'User-Agent': STREAM_UA, Referer: SOCO_REFERER },
    });
    if (!res.ok) throw Object.assign(new Error('CDN unavailable'), { status: res.status });
    return res.text();
  } finally {
    clearTimeout(timer);
  }
};

// ─── Rewrite SOCO m3u8 URLs ───────────────────────────────────────────────────
// SOCO CDN sends CORS:* — relative URLs are rewritten to absolute so the browser
// can fetch segments directly without a server proxy hop.
const rewriteM3u8 = (body, base, basePath) =>
  body.replace(/^([^#\r\n].+)$/gm, (line) => {
    if (line.startsWith('http')) return line;
    if (line.startsWith('/')) return `${base.origin}${line}`;
    return `${basePath}${line}`;
  });

module.exports = { fetchM3u8, rewriteM3u8, SOCO_REFERER };
