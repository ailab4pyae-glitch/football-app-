/**
 * Device-token auth — no login required.
 *
 * Flow:
 *  1. Admin approves transaction → generateDeviceToken(userId) called
 *  2. Token stored in tg_users.device_token
 *  3. Bot sends activation URL to user:  https://yoursite.com?activate=TOKEN
 *  4. Web/mobile stores token in localStorage / SecureStore
 *  5. Every page load → GET /api/auth/check?token=TOKEN
 *  6. Returns { is_premium, expires_at, plan_name, full_name }
 *
 * Mobile: identical flow — store token in AsyncStorage/SecureStore,
 *         call the same /api/auth/check endpoint.
 */

const db     = require('../config/database');
const redis  = require('../config/redis');
const crypto = require('crypto');
const { requireAppKey, extractToken } = require('../config/mobileAuth');

const WEBSITE_URL = process.env.WEBSITE_URL || 'http://localhost:3000';
const BOT_TOKEN   = process.env.BOT_TOKEN   || '';

// ── Helpers ───────────────────────────────────────────────────────────────────

const genToken = () => crypto.randomBytes(32).toString('hex'); // 64-char hex

const bustCache = async (token) => {
  try { await redis.del(`auth:${token}`) } catch (_) {}
};

// Send Telegram message directly via Bot API (no library needed)
const sendTelegramMsg = async (chatId, text) => {
  if (!BOT_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
  } catch (_) {}
};

// Called by approval routes (admin panel + N8N) after subscription is activated
const generateDeviceToken = async (userId, planName, expiresAt) => {
  const token = genToken();
  await db.query(
    `UPDATE tg_users SET device_token=$1, token_generated_at=NOW() WHERE id=$2`,
    [token, userId]
  );

  // Notify user via Telegram with their activation link
  const uRes = await db.query('SELECT telegram_id, full_name FROM tg_users WHERE id=$1', [userId]);
  if (uRes.rows[0]) {
    const { telegram_id, full_name } = uRes.rows[0];
    const activateUrl = `${WEBSITE_URL}?activate=${token}`;
    const expDate     = new Date(expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    await sendTelegramMsg(telegram_id,
      `✅ *Premium အသက်ဝင်ပြီ!*\n\n` +
      `မင်္ဂလာပါ ${full_name || ''} 👋\n` +
      `Plan: *${planName}*\n` +
      `သက်တမ်းကုန်သည့်ရက်: *${expDate}*\n\n` +
      `အောက်ပါ link ကိုနှိပ်ပြီး premium unlock လုပ်ပါ:\n` +
      `👉 [Premium Activate လုပ်ရန်](${activateUrl})\n\n` +
      `_ဤ link သည် သင့် device တစ်ခုတည်းအတွက်သာ ဖြစ်သည်။_`
    );
  }

  return token;
};

module.exports = { generateDeviceToken };

// ── Routes ────────────────────────────────────────────────────────────────────

module.exports.routes = async function authRoutes(fastify) {

  // ── GET /api/auth/check ───────────────────────────────────────────────────
  // Web + Mobile: call this on every app launch / page load
  // Accepts token via:
  //   Authorization: Bearer <token>   ← mobile (preferred)
  //   ?token=<token>                  ← web (backward-compat)
  fastify.get('/api/auth/check', async (request, reply) => {
    const token = extractToken(request);
    if (!token) { reply.code(400); return { error: 'token required' }; }

    const cacheKey = `auth:${token}`;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (_) {}

    const { rows } = await db.query(
      `SELECT u.id, u.telegram_id, u.full_name, u.username,
              s.status AS sub_status, s.expires_at,
              p.name   AS plan_name
       FROM tg_users u
       LEFT JOIN LATERAL (
         SELECT s.status, s.expires_at, s.plan_id
         FROM subscriptions s
         WHERE s.user_id = u.id AND s.status = 'active'
         ORDER BY s.expires_at DESC LIMIT 1
       ) s ON true
       LEFT JOIN subscription_plans p ON p.id = s.plan_id
       WHERE u.device_token = $1`,
      [token]
    );

    if (!rows.length) {
      const r = { is_premium: false, reason: 'invalid_token' };
      try { await redis.set(cacheKey, JSON.stringify(r), 'EX', 30) } catch (_) {}
      return r;
    }

    const row        = rows[0];
    const isActive   = row.sub_status === 'active' && new Date(row.expires_at) > new Date();
    const isExpired  = row.sub_status === 'active' && !isActive;

    const result = {
      is_premium:  isActive,
      full_name:   row.full_name  || null,
      username:    row.username   || null,
      plan_name:   row.plan_name  || null,
      expires_at:  row.expires_at || null,
      expired:     isExpired,
      // reason helps frontend show the right message
      reason: isActive ? null : isExpired ? 'expired' : 'no_subscription',
    };

    // Cache shorter if premium so expiry is caught promptly
    const ttl = isActive ? 120 : 30;
    try { await redis.set(cacheKey, JSON.stringify(result), 'EX', ttl) } catch (_) {}

    return result;
  });

  // ── POST /api/auth/telegram ──────────────────────────────────────────────
  // Telegram Mini App: verify initData, return device_token for the user.
  // Client sends window.Telegram.WebApp.initData as body { initData }.
  fastify.post('/api/auth/telegram', async (request, reply) => {
    const { initData } = request.body || {};
    if (!initData) { reply.code(400); return { error: 'initData required' }; }

    // Verify HMAC signature from Telegram
    const secret  = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const params  = new URLSearchParams(initData);
    const hash    = params.get('hash');
    params.delete('hash');
    const checkStr = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
    const computed = crypto.createHmac('sha256', secret).update(checkStr).digest('hex');

    if (computed !== hash) { reply.code(401); return { error: 'Invalid Telegram signature' }; }

    // Parse user from initData
    let tgUser;
    try { tgUser = JSON.parse(params.get('user')); } catch (_) { reply.code(400); return { error: 'Invalid user payload' }; }

    const tgId    = String(tgUser.id);
    const name    = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ');
    const uname   = tgUser.username || null;

    // Upsert user in tg_users
    const upsert = await db.query(
      `INSERT INTO tg_users (telegram_id, full_name, username, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (telegram_id) DO UPDATE
         SET full_name = COALESCE(EXCLUDED.full_name, tg_users.full_name),
             username  = COALESCE(EXCLUDED.username,  tg_users.username)
       RETURNING id, device_token`,
      [tgId, name, uname]
    );
    const user = upsert.rows[0];

    // If no device_token yet, return empty — they'll get one after subscription approval
    if (!user.device_token) {
      return { token: null, is_premium: false, reason: 'no_subscription' };
    }

    // Return the existing token — frontend saves it, uses /auth/check normally
    const cacheKey = `auth:${user.device_token}`;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return { token: user.device_token, ...JSON.parse(cached) };
    } catch (_) {}

    const { rows } = await db.query(
      `SELECT s.status AS sub_status, s.expires_at, p.name AS plan_name
       FROM tg_users u
       LEFT JOIN LATERAL (
         SELECT s.status, s.expires_at, s.plan_id FROM subscriptions s
         WHERE s.user_id = u.id AND s.status = 'active'
         ORDER BY s.expires_at DESC LIMIT 1
       ) s ON true
       LEFT JOIN subscription_plans p ON p.id = s.plan_id
       WHERE u.id = $1`,
      [user.id]
    );
    const row      = rows[0] || {};
    const isActive = row.sub_status === 'active' && new Date(row.expires_at) > new Date();
    const result   = {
      token:       user.device_token,
      is_premium:  isActive,
      plan_name:   row.plan_name  || null,
      expires_at:  row.expires_at || null,
      reason: isActive ? null : 'no_subscription',
    };
    try { await redis.set(cacheKey, JSON.stringify({ ...result, token: undefined }), 'EX', isActive ? 120 : 30); } catch (_) {}
    return result;
  });

  // ── POST /api/auth/activate ───────────────────────────────────────────────
  // Mobile app calls this to register token on first launch.
  // Body: { token }  OR  Authorization: Bearer <token>
  // Returns same shape as /check — inlined (no self-HTTP-request overhead)
  fastify.post('/api/auth/activate', { preHandler: [requireAppKey] }, async (request, reply) => {
    const token = (request.body?.token) || extractToken(request);
    if (!token) { reply.code(400); return { error: 'token required' }; }

    const cacheKey = `auth:${token}`;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (_) {}

    const { rows } = await db.query(
      `SELECT u.id, u.full_name, u.username,
              s.status AS sub_status, s.expires_at,
              p.name   AS plan_name
       FROM tg_users u
       LEFT JOIN LATERAL (
         SELECT s.status, s.expires_at, s.plan_id
         FROM subscriptions s
         WHERE s.user_id = u.id AND s.status = 'active'
         ORDER BY s.expires_at DESC LIMIT 1
       ) s ON true
       LEFT JOIN subscription_plans p ON p.id = s.plan_id
       WHERE u.device_token = $1`,
      [token]
    );

    if (!rows.length) {
      const r = { is_premium: false, reason: 'invalid_token' };
      try { await redis.set(cacheKey, JSON.stringify(r), 'EX', 30); } catch (_) {}
      return r;
    }

    const row       = rows[0];
    const isActive  = row.sub_status === 'active' && new Date(row.expires_at) > new Date();
    const isExpired = row.sub_status === 'active' && !isActive;
    const result    = {
      is_premium: isActive,
      full_name:  row.full_name  || null,
      username:   row.username   || null,
      plan_name:  row.plan_name  || null,
      expires_at: row.expires_at || null,
      expired:    isExpired,
      reason: isActive ? null : isExpired ? 'expired' : 'no_subscription',
    };
    const ttl = isActive ? 120 : 30;
    try { await redis.set(cacheKey, JSON.stringify(result), 'EX', ttl); } catch (_) {}
    return result;
  });
};
