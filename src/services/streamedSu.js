const db = require('../config/database');

const STREAMED_SU_API_BASE_URL = process.env.STREAMED_SU_API_BASE_URL || 'https://streamed.su/api';
const STREAMED_SU_FETCH_TIMEOUT_MS = parseInt(process.env.STREAMED_SU_FETCH_TIMEOUT_MS, 10) || 15000;
const STREAMED_SU_MAX_RETRY_COUNT = parseInt(process.env.STREAMED_SU_MAX_RETRY_COUNT, 10) || 3;
const STREAMED_SU_RETRY_DELAY_MS = parseInt(process.env.STREAMED_SU_RETRY_DELAY_MS, 10) || 1000;

const SPORT_TAB_SLUG = {
  football: 'main-live',
  basketball: 'main-live',
  tennis: 'main-live',
  cricket: 'main-live'
};

const normalizeMatch = (match) => {
  const title = match.title || `${match.home_team || match.home || 'Home'} vs ${match.away_team || match.away || 'Away'}`;
  return {
    title,
    home_team: match.home_team || match.home || null,
    away_team: match.away_team || match.away || null,
    home_logo: match.home_logo || match.home_logo_url || null,
    away_logo: match.away_logo || match.away_logo_url || null,
    status: match.status || match.state || 'scheduled',
    scheduled_at: match.scheduled_at ? new Date(match.scheduled_at).toISOString() : null,
    source_match_id: match.id || match.match_id || match.source_match_id || null,
    source_name: match.source_name || match.source || match.provider || null
  };
};

const getTabIdForSport = async (sport) => {
  const slug = SPORT_TAB_SLUG[sport] || SPORT_TAB_SLUG.football;
  const result = await db.query('SELECT id FROM tabs WHERE slug = $1 LIMIT 1', [slug]);
  return result.rows.length > 0 ? result.rows[0].id : null;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchWithTimeout = async (url, timeoutMs) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

const fetchWithRetry = async (url, attempt = 1) => {
  try {
    return await fetchWithTimeout(url, STREAMED_SU_FETCH_TIMEOUT_MS);
  } catch (err) {
    if (attempt < STREAMED_SU_MAX_RETRY_COUNT) {
      await sleep(STREAMED_SU_RETRY_DELAY_MS * attempt);
      return fetchWithRetry(url, attempt + 1);
    }
    throw err;
  }
};

const fetchMatches = async (sport) => {
  const apiUrl = `${STREAMED_SU_API_BASE_URL}/matches/${encodeURIComponent(sport)}`;
  let response;

  try {
    response = await fetchWithRetry(apiUrl);
  } catch (err) {
    throw new Error(`Unable to fetch matches for ${sport}: ${err.message}`);
  }

  if (!response.ok) {
    throw new Error(`Unable to fetch matches for ${sport}: ${response.statusText}`);
  }

  const payload = await response.json();
  const items = Array.isArray(payload) ? payload : payload.matches || payload.data || [];
  const tab_id = await getTabIdForSport(sport);

  return items.map((item) => ({
    ...normalizeMatch(item),
    tab_id,
    sport
  }));
};

const detectQuality = (url, label) => {
  if (/_uhd|_4k|_hd/i.test(label || url)) return 'HD';
  if (/_lsd|_sd/i.test(label || url)) return 'SD';
  return 'SD';
};

const extractStreamUrls = (items) => {
  const streams = [];
  const list = Array.isArray(items) ? items : [];

  for (const item of list) {
    const url = item.url || item.stream || item.link || item.playlist;
    if (!url || !url.includes('.m3u8')) continue;

    streams.push({
      url,
      quality: detectQuality(url, item.quality || item.label),
      source_name: item.source_name || item.source || item.provider || null,
      priority: item.priority || 1
    });
  }

  return streams;
};

const fetchStreamUrls = async (source, id) => {
  const apiUrl = `${STREAMED_SU_API_BASE_URL}/stream/${encodeURIComponent(source)}/${encodeURIComponent(id)}`;
  let response;

  try {
    response = await fetchWithRetry(apiUrl);
  } catch (err) {
    throw new Error(`Unable to fetch stream URLs for ${source}/${id}: ${err.message}`);
  }

  if (!response.ok) {
    throw new Error(`Unable to fetch stream URLs for ${source}/${id}: ${response.statusText}`);
  }

  const payload = await response.json();
  const items = Array.isArray(payload) ? payload : payload.streams || payload.data || [];
  return extractStreamUrls(items);
};

module.exports = {
  fetchMatches,
  fetchStreamUrls
};
