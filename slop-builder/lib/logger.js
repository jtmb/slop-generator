import pino from 'pino';

/**
 * Structured JSON logger for slop-builder.
 * Level from LOG_LEVEL env (default 'info').
 * Secrets (api_key, authorization, token) are automatically redacted.
 */
const logger = pino({
  name: 'slop-builder',
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ['api_key', 'API_KEY', 'authorization', 'token', 'apiKey'],
    censor: '[REDACTED]',
  },
  serializers: pino.stdSerializers,
});

export default logger;
