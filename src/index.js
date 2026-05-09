const fastify = require('fastify')({ logger: true });
const path = require('path');

// Register environment variables
fastify.register(require('@fastify/env'), {
  dotenv: true,
  schema: {
    type: 'object',
    required: ['DATABASE_URL', 'REDIS_URL', 'PORT'],
    properties: {
      DATABASE_URL: { type: 'string' },
      REDIS_URL: { type: 'string' },
      PORT: { type: 'number', default: 3000 }
    }
  }
});

// Register CORS
fastify.register(require('@fastify/cors'), {
  origin: true
});

// Routes
fastify.get('/', async (request, reply) => {
  return { message: 'Football Live Streaming Aggregator API' };
});

// Start server
const start = async () => {
  try {
    await fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' });
    fastify.log.info(`Server listening on ${fastify.server.address().port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();