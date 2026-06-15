const BASE_URL = 'https://api.sportsrc.org/v2/';

const getKeys = () => [
  process.env.SPORTSRC_KEY_1,
  process.env.SPORTSRC_KEY_2,
  process.env.SPORTSRC_KEY_3,
].filter(Boolean);

let keyIdx = 0;

const apiFetch = async (params, attempt = 0) => {
  const keys = getKeys();
  if (!keys.length) throw new Error('[sportsrc] No API keys configured (SPORTSRC_KEY_1/2/3)');

  const key = keys[keyIdx % keys.length];
  const qs  = new URLSearchParams({ ...params, api_key: key }).toString();

  const res = await fetch(`${BASE_URL}?${qs}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(15000),
  });

  if (res.status === 429 && attempt < keys.length - 1) {
    keyIdx = (keyIdx + 1) % keys.length;
    console.warn(`[sportsrc] Rate limited — rotating to key index ${keyIdx}`);
    return apiFetch(params, attempt + 1);
  }

  if (!res.ok) throw new Error(`[sportsrc] HTTP ${res.status} for type=${params.type}`);

  const data = await res.json();
  if (!data.success) throw new Error(`[sportsrc] API returned success=false`);
  return data;
};

const todayStr    = () => new Date().toISOString().slice(0, 10);
const tomorrowStr = () => {
  const d = new Date(); d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
};

const getMatches = (date)    => apiFetch({ type: 'matches', sport: 'football', date: date || todayStr() });
const getDetail  = (matchId) => apiFetch({ type: 'detail',  id: matchId });

module.exports = { getMatches, getDetail, todayStr, tomorrowStr };
