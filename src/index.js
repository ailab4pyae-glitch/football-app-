require('dotenv').config();
require('./config/scraperLog'); // intercept console before any scraper runs

const fastify = require('fastify')({ logger: true, trustProxy: true });

fastify.register(require('@fastify/env'), {
  dotenv: false,
  schema: {
    type: 'object',
    required: ['DATABASE_URL', 'PORT', 'NODE_ENV'],
    properties: {
      DATABASE_URL: { type: 'string' },
      REDIS_URL:    { type: 'string', default: '' },
      PORT:         { type: 'number', default: 3050 },
      NODE_ENV:     { type: 'string', default: 'development' },
      ADMIN_API_KEY:   { type: 'string', default: '' },
      MOBILE_API_KEY:  { type: 'string', default: '' }
    }
  }
});

// Allow all origins (public API) — admin panel on Vercel calls /api/admin/* cross-origin
fastify.register(require('@fastify/static'), {
  root:   require('path').join(__dirname, '../public'),
  prefix: '/public/',
  decorateReply: false,
});

fastify.register(require('@fastify/cors'), {
  origin: true,
  credentials: true,
});

// Global rate limit — 200 req/min per IP
fastify.register(require('@fastify/rate-limit'), {
  max: 200,
  timeWindow: '1 minute',
  skipOnError: true,
  // Auth endpoints: tighter limit to slow brute-force token guessing
  keyGenerator: (request) => {
    const path = request.routerPath || request.url;
    if (path === '/api/auth/check' || path === '/api/auth/activate') {
      return `auth:${request.ip}`;
    }
    return request.ip;
  },
  errorResponseBuilder: () => ({ error: 'Too many requests — slow down' }),
});


fastify.register(require('./routes/config'));
fastify.register(require('./routes/tabs'));
fastify.register(require('./routes/matches'));
fastify.register(require('./routes/streams'));
fastify.register(require('./routes/admin'));
fastify.register(require('./routes/english'));
fastify.register(require('./routes/servers'));
fastify.register(require('./routes/proxy/index'));
fastify.register(require('./routes/tv'));
fastify.register(require('./routes/subscription'));
fastify.register(require('./routes/auth').routes);
fastify.register(require('./routes/sportsrc'));

require('./jobs/syncMatches');
require('./jobs/socoliveSyncJob');
require('./jobs/chinaliveSyncJob');
require('./jobs/sportSrcSyncJob');
require('./jobs/liveHdTvSyncJob');
// myanmarTvSyncJob disabled — streams are geo-restricted; URLs must be entered manually via Admin → TV & Radio
require('./jobs/hesgoalSyncJob');
require('./jobs/urlHealthJob');
require('./jobs/finishedMatchCleanupJob');

fastify.get('/health', async () => ({ status: 'ok' }));

fastify.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  reply.status(error.statusCode || 500).send({ error: 'Internal Server Error' });
});

const start = async () => {
  try {
    await fastify.listen({ port: process.env.PORT || 3050, host: '0.0.0.0' });
    fastify.log.info(`Server listening on ${fastify.server.address().port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();