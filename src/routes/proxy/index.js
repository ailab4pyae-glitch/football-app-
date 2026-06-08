const china  = require('./china');
const stream = require('./stream');
const tv     = require('./tv');
const logo   = require('./logo');

module.exports = async (fastify) => {
  fastify.register(china);
  fastify.register(stream);
  fastify.register(tv);
  fastify.register(logo);
};
