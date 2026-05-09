const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const db = require('../config/database');
const redis = require('../config/redis');
const { fetchMatches } = require('../services/streamedSu');

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error('REDIS_URL is required for BullMQ');
}

const redisOptions = {
  maxRetriesPerRequest: null
};
if (process.env.REDIS_URL.startsWith('rediss://') || process.env.REDIS_TLS === 'true') {
  redisOptions.tls = { rejectUnauthorized: false };
}

const connection = new IORedis(redisUrl, redisOptions);
const queueName = 'syncMatches';

const queue = new Queue(queueName, {
  connection,
  defaultJobOptions: {
    removeOnComplete: true,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000
    }
  }
});

const syncMatchesHandler = async () => {
  const sports = ['football', 'basketball'];

  for (const sport of sports) {
    try {
      const matches = await fetchMatches(sport);

      for (const match of matches) {
        if (!match.source_match_id) continue;

        const existing = await db.query(
          'SELECT id FROM matches WHERE source_match_id = $1 LIMIT 1',
          [match.source_match_id]
        );

        if (existing.rows.length > 0) {
          await db.query(
            `UPDATE matches SET
              tab_id = $1,
              title = $2,
              home_team = $3,
              away_team = $4,
              home_logo = $5,
              away_logo = $6,
              status = $7,
              scheduled_at = $8,
              source_name = $9
             WHERE id = $10`,
            [
              match.tab_id,
              match.title,
              match.home_team,
              match.away_team,
              match.home_logo,
              match.away_logo,
              match.status,
              match.scheduled_at,
              match.source_name,
              existing.rows[0].id
            ]
          );
        } else {
          await db.query(
            `INSERT INTO matches (
              tab_id, title, home_team, away_team,
              home_logo, away_logo, status,
              scheduled_at, source_match_id, source_name, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
            [
              match.tab_id,
              match.title,
              match.home_team,
              match.away_team,
              match.home_logo,
              match.away_logo,
              match.status,
              match.scheduled_at,
              match.source_match_id,
              match.source_name
            ]
          );
        }
      }
    } catch (err) {
      console.error(`Failed to sync matches for ${sport}:`, err);
    }
  }

  try {
    const tabsKeys = await redis.keys('tabs:all');
    const matchKeys = await redis.keys('matches:*');
    const streamKeys = await redis.keys('streams:*');
    const allKeys = [...tabsKeys, ...matchKeys, ...streamKeys];
    if (allKeys.length > 0) {
      await redis.del(...allKeys);
    }
  } catch (err) {
    console.warn('Failed to invalidate Redis cache after sync', err);
  }

  console.log('syncMatches job completed');
};

new Worker(queueName, async () => {
  await syncMatchesHandler();
}, { connection });

const scheduleSync = async () => {
  await syncMatchesHandler();
  setInterval(async () => {
    try {
      await queue.add('sync-matches-job', {}, { removeOnComplete: true });
    } catch (err) {
      console.error('Failed to enqueue syncMatches job', err);
    }
  }, 5 * 60 * 1000);
};

scheduleSync().catch((err) => {
  console.error('Failed to start syncMatches scheduler', err);
});

module.exports = queue;
