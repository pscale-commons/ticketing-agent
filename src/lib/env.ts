import { z } from 'zod';

const envSchema = z.object({
  TICKET_AGENT_SECRET: z.string().min(1, 'TICKET_AGENT_SECRET is required'),
  TICKET_AGENT_CONFIG: z.string().default('./config/agent.yaml'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  ADMIN_TOKEN: z.string().min(1, 'ADMIN_TOKEN is required'),
  RATE_LIMIT_WEBHOOK: z.string().url().optional(),
  PORT: z.coerce.number().int().positive().default(8080),
  PUBLIC_URL: z.string().url().default('http://localhost:8080'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  PURCHASES_DB_PATH: z.string().default('./data/purchases.sqlite'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}
