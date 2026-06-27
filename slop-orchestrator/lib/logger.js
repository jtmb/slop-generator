import pino from 'pino';

const logger = pino({
  name: 'slop-orchestrator',
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: {
    err: pino.stdSerializers.err,
  },
});

export default logger;
