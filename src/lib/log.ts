import pino from 'pino';

const SECRET_KEYS = [
  'secret',
  'TICKET_AGENT_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'ADMIN_TOKEN',
  'authorization',
  'cookie',
];

export function createLogger(level = 'info') {
  return pino({
    level,
    redact: {
      paths: SECRET_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]),
      censor: '[redacted]',
    },
    transport:
      process.env.NODE_ENV === 'production'
        ? undefined
        : {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l' },
          },
  });
}

export type Logger = ReturnType<typeof createLogger>;
