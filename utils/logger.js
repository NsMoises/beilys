const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss Z',
      ignore: 'pid,hostname',
    }
  } : undefined,
});

// Create child loggers for different modules
const createLogger = (name) => logger.child({ module: name });

module.exports = { logger, createLogger };