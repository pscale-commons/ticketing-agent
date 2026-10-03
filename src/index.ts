import { serve } from '@hono/node-server';
import { loadEnv } from './lib/env.js';
import { createLogger } from './lib/log.js';
import { loadConfig } from './lib/config.js';
import { openDb } from './lib/db.js';
import { createMcpClient } from './lib/pscale.js';
import { StripeDriver } from './drivers/stripe.js';
import { GiftDriver } from './drivers/gift.js';
import { ManualDriver } from './drivers/manual.js';
import { createApp } from './server.js';
import * as verifier from './lib/verifier.js';
import type { AppContext } from './types.js';
import type { PaymentDriver } from './drivers/types.js';

async function main() {
  const env = loadEnv();
  const log = createLogger(env.LOG_LEVEL);

  const config = loadConfig(env.TICKET_AGENT_CONFIG);
  log.info({ agent_id: config.agent.id, products: config.products.length }, 'config loaded');

  const db = openDb(env.PURCHASES_DB_PATH);
  log.info({ path: env.PURCHASES_DB_PATH }, 'db opened');

  const mcp = await createMcpClient(config.agent.pscale_mcp_url, {
    clientName: 'ticketing-agent',
    clientVersion: '0.1.0',
  });
  log.info({ url: config.agent.pscale_mcp_url }, 'mcp client connected');

  const stripeDriver: PaymentDriver | null =
    env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET
      ? new StripeDriver({ secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET })
      : null;
  if (stripeDriver) {
    log.info({}, 'stripe driver configured');
  } else {
    const stripeProducts = config.products.filter((p) => p.price.driver === 'stripe');
    if (stripeProducts.length > 0) {
      log.warn(
        { count: stripeProducts.length },
        'config has stripe products but STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET unset — purchases will 500',
      );
    }
  }

  const giftDriver = new GiftDriver();
  const manualDriver = new ManualDriver();

  const ctx: AppContext = { env, log, config, db, mcp, stripeDriver, giftDriver, manualDriver };
  const app = createApp(ctx);

  const verifierHandle = verifier.start(ctx);
  log.info(
    {
      watch:
        config.verifier?.watch ?? Array.from(new Set(config.products.map((p) => p.sed))),
      poll_interval_seconds: config.verifier?.poll_interval_seconds ?? 5,
    },
    'verifier started',
  );

  const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    log.info({ port: info.port, public_url: env.PUBLIC_URL }, 'ticketing-agent listening');
  });

  // A REDEPLOY IS NOT A CRASH (David, 2026-10-03): the platform stops the
  // outgoing deployment with SIGTERM. `npm start` execs node, so the signal
  // reaches this process rather than a shell that would die of it; and a
  // connection held open must not keep it waiting until it is killed — that
  // reads as a crash too — so it leaves with 0 within three seconds either way.
  const shutdown = (signal: string) => {
    log.info({ signal }, 'shutting down');
    verifierHandle.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
