/**
 * Mobile API security helpers.
 *
 * X-App-Key  — shared secret the mobile app sends on every request.
 *              Stops random browsers/scrapers from using the API.
 *              Set MOBILE_API_KEY in .env (any long random string).
 *
 * Bearer token — reads device token from Authorization header or
 *               query param (backward-compat with web).
 */

const db    = require('./database');
const redis = require('./redis');

// ── Extract device token from request ─────────────────────────────────────────

const extractToken = (request) => {
  const auth = request.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return request.query.token || null;
};

// ── Resolve device token → subscription status (cached 2 min) ─────────────────

const resolveToken = async (token) => {
  if (!token) return null;

  const cacheKey = `auth:${token}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (_) {}

  const { rows } = await db.query(
    `SELECT u.id,
            s.status     AS sub_status,
            s.expires_at
     FROM tg_users u
     LEFT JOIN LATERAL (
       SELECT s.status, s.expires_at
       FROM subscriptions s
       WHERE s.user_id = u.id AND s.status = 'active'
       ORDER BY s.expires_at DESC LIMIT 1
     ) s ON true
     WHERE u.device_token = $1`,
    [token]
  );

  if (!rows.length) {
    try { await redis.set(cacheKey, JSON.stringify(null), 'EX', 30); } catch (_) {}
    return null;
  }

  const row      = rows[0];
  const isActive = row.sub_status === 'active' && new Date(row.expires_at) > new Date();
  const result   = { userId: row.id, is_premium: isActive, expires_at: row.expires_at };

  const ttl = isActive ? 120 : 30;
  try { await redis.set(cacheKey, JSON.stringify(result), 'EX', ttl); } catch (_) {}
  return result;
};

// ── Fastify hook: validate X-App-Key on mobile routes ────────────────────────
// Register this as an onRequest hook on the routes you want to protect.
//
// Usage in a route file:
//   fastify.addHook('onRequest', requireAppKey)
//
// Skip for admin routes (they use JWT instead).

const MOBILE_API_KEY = process.env.MOBILE_API_KEY || '';

const requireAppKey = async (request, reply) => {
  if (!MOBILE_API_KEY) return; // not configured → open (dev mode)

  const key = request.headers['x-app-key'] || '';
  if (key !== MOBILE_API_KEY) {
    reply.code(401).send({ error: 'Unauthorized' });
  }
};

// ── Fastify hook: require valid premium token ──────────────────────────────────
// Use on endpoints that should only be accessible to paying users.

const requirePremium = async (request, reply) => {
  const token = extractToken(request);
  const auth  = await resolveToken(token);
  if (!auth?.is_premium) {
    reply.code(403).send({ error: 'Premium subscription required' });
  }
  request.auth = auth; // available downstream if needed
};

module.exports = { extractToken, resolveToken, requireAppKey, requirePremium };
