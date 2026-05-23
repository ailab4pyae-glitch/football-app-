// In-memory drop-in replacement for ioredis.
// Same API surface: get, set (with EX), del, keys.
// Used automatically when REDIS_URL is not set.
// LRU eviction kicks in when MAX_ENTRIES is reached.

const MAX_ENTRIES = 1000;

const store  = new Map(); // key → { value, expiresAt } (insertion order = LRU order)
const timers = new Map(); // key → timeout handle

const _del = (key) => {
  store.delete(key);
  if (timers.has(key)) { clearTimeout(timers.get(key)); timers.delete(key); }
};

// Move key to end (most-recently-used)
const _touch = (key, entry) => {
  store.delete(key);
  store.set(key, entry);
};

// Evict oldest entries until under MAX_ENTRIES
const _evict = () => {
  while (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    _del(oldest);
  }
};

const _globToRegex = (pattern) =>
  new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');

const memcache = {
  get: (key) => {
    const entry = store.get(key);
    if (!entry) return Promise.resolve(null);
    if (entry.expiresAt && Date.now() > entry.expiresAt) { _del(key); return Promise.resolve(null); }
    _touch(key, entry); // bump to MRU position
    return Promise.resolve(entry.value);
  },

  set: (key, value, exFlag, ttlSeconds) => {
    _del(key);
    _evict();
    const expiresAt = (exFlag === 'EX' && ttlSeconds) ? Date.now() + ttlSeconds * 1000 : null;
    store.set(key, { value: String(value), expiresAt });
    if (expiresAt) {
      const t = setTimeout(() => _del(key), ttlSeconds * 1000);
      if (t.unref) t.unref();
      timers.set(key, t);
    }
    return Promise.resolve('OK');
  },

  del: (...args) => {
    const keys = args.flat();
    let count = 0;
    for (const key of keys) { if (store.has(key)) { _del(key); count++; } }
    return Promise.resolve(count);
  },

  keys: (pattern) => {
    const re = _globToRegex(pattern);
    return Promise.resolve([...store.keys()].filter((k) => re.test(k)));
  },

  on: () => {},
};

module.exports = memcache;
