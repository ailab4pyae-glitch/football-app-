// Shared in-memory state for all scrapers.
// Replaces Redis-based running locks — no TTL expiry risk.
// Admin route reads this directly instead of querying Redis.

const state = {};

const get = (slug) => state[slug] || {};

module.exports = {
  isRunning:  (slug) => !!state[slug]?.running,

  start: (slug) => {
    state[slug] = { ...get(slug), running: true, startedAt: Date.now() };
  },

  finish: (slug, status, message = null) => {
    state[slug] = {
      ...get(slug),
      running:    false,
      lastRunAt:  state[slug]?.startedAt ?? Date.now(),
      lastResult: { status, at: Date.now(), message },
    };
  },

  getAll: () => state,
  get,
};
