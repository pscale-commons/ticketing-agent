import { Hono } from 'hono';
import type { Env, Logger, AppContext } from './types.js';
import { catalogueRoutes } from './routes/catalogue.js';
import { purchaseRoutes } from './routes/purchase.js';
import { webhookRoutes } from './routes/webhook.js';
import { adminRoutes } from './routes/admin.js';

export function createApp(ctx: AppContext): Hono {
  const app = new Hono();

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      agent_id: ctx.config.agent.id,
      products: ctx.config.products.length,
      version: '0.1.0',
    }),
  );

  app.route('/', catalogueRoutes(ctx));
  app.route('/', purchaseRoutes(ctx));
  app.route('/', webhookRoutes(ctx));
  app.route('/admin', adminRoutes(ctx));

  // Refund route — wired in M5.

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  app.onError((err, c) => {
    ctx.log.error({ err: err.message, stack: err.stack }, 'unhandled error');
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}

export type { Env, Logger, AppContext };
