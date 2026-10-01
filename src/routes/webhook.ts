// Stripe webhook → grain issuance.
//
// The flow:
//   1. Verify Stripe signature on the raw body (non-negotiable per CLAUDE.md).
//   2. If event isn't checkout.session.completed-with-paid, ack 200 and ignore.
//   3. Look up the purchase by purchase_id in metadata. Abort if it's not
//      pending — paid (idempotency, re-delivered webhook), rate_limited,
//      refunded all stop here with a 200 ack.
//   4. Re-check the rate-limit window (separate from the pre-checkout
//      check; concurrent checkouts could push us past the cap). If hit:
//      mark `rate_limited`, fire the operator webhook if configured, log
//      high-severity, ack 200. The buyer's payment is held; operator
//      decides via /admin/refund (M5).
//   5. Otherwise: derive the per-grain passphrase, build the [ticket]
//      envelope, call grain.establish() against the configured bsp-mcp,
//      mark the row `paid`. Ack 200.
//
// Stripe retries non-2xx responses for up to ~3 days, so we ack 200 even
// for terminal errors past the signature check — re-delivery wouldn't help
// and the operator handles it via admin tooling.

import { Hono } from 'hono';
import type { AppContext } from '../types.js';
import type { PurchaseRow } from '../lib/db.js';
import { WebhookSignatureError } from '../drivers/types.js';
import * as rateLimit from '../lib/rate-limit.js';
import { issueGrain, issueForPayment } from '../lib/issuance.js';

export function webhookRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.post('/webhook/stripe', async (c) => {
    if (!ctx.stripeDriver) {
      ctx.log.error({}, 'webhook fired but stripe driver not configured');
      return c.json({ error: 'stripe_not_configured' }, 500);
    }

    const rawBody = await c.req.text();
    const signature = c.req.header('stripe-signature') ?? null;

    let event;
    try {
      event = ctx.stripeDriver.verifyWebhook({ rawBody, signature });
    } catch (err) {
      if (err instanceof WebhookSignatureError) {
        ctx.log.warn({ err: err.message }, 'stripe webhook signature rejected');
        return c.json({ error: 'invalid_signature' }, 400);
      }
      throw err;
    }

    if (event.kind === 'ignored') {
      ctx.log.debug({ reason: event.reason }, 'stripe webhook ignored');
      return c.json({ ok: true, ignored: event.reason });
    }

    if (event.kind === 'renewal') {
      const r = await issueForPayment(ctx, { ...event, note: 'subscription renewal' });
      return c.json('issued' in r ? { ok: true, renewed: true, pair_id: r.pair_id } : r);
    }
    if (event.kind === 'dashboard-invoice') {
      return c.json(await issueForPayment(ctx, { ...event, note: 'dashboard invoice' }));
    }

    const { purchase_id, driver_ref, amount_cents, currency } = event;

    const row = ctx.db
      .prepare('SELECT * FROM purchases WHERE id = ?')
      .get(purchase_id) as PurchaseRow | undefined;

    if (!row) {
      // The pending row is gone (a lost database), but the session or invoice
      // says what it sold and to whom: Stripe is the record of the sale.
      if (event.product_id && event.buyer_agent_id) {
        ctx.log.warn({ purchase_id, driver_ref }, 'webhook for a purchase with no row — issuing from Stripe metadata');
        return c.json(await issueForPayment(ctx, {
          purchase_id,
          driver_ref,
          product_id: event.product_id,
          buyer_agent_id: event.buyer_agent_id,
          amount_cents,
          currency,
          note: 'no pending row — issued from Stripe metadata',
        }));
      }
      ctx.log.error({ purchase_id, driver_ref }, 'webhook for unknown purchase_id');
      return c.json({ ok: true, ignored: 'unknown-purchase' });
    }
    if (row.status === 'paid') {
      ctx.log.info({ purchase_id }, 'webhook re-delivery; purchase already paid (idempotent)');
      return c.json({ ok: true, idempotent: true });
    }
    if (row.status !== 'pending') {
      ctx.log.warn({ purchase_id, status: row.status }, 'webhook for non-pending purchase; ignoring');
      return c.json({ ok: true, ignored: `status:${row.status}` });
    }

    const product = ctx.config.products.find((p) => p.id === row.product_id);
    if (!product) {
      ctx.log.error({ purchase_id, product_id: row.product_id }, 'webhook references purchase with unknown product');
      ctx.db
        .prepare("UPDATE purchases SET status = 'failed', notes = ? WHERE id = ?")
        .run('webhook: product no longer in config', purchase_id);
      return c.json({ ok: true, ignored: 'unknown-product' });
    }

    // Authoritative rate-limit check immediately before issuance.
    const decision = rateLimit.check(ctx.db, product);
    if (!decision.allowed) {
      ctx.db
        .prepare("UPDATE purchases SET status = 'rate_limited', notes = ?, amount_cents = ?, currency = ? WHERE id = ?")
        .run(
          `rate-limit cap-hit at webhook: ${decision.reason} (cap=${decision.cap}, hour=${decision.hour_count}, day=${decision.day_count})`,
          amount_cents,
          currency,
          purchase_id,
        );
      ctx.log.error(
        {
          purchase_id,
          product_id: product.id,
          reason: decision.reason,
          cap: decision.cap,
          hour_count: decision.hour_count,
          day_count: decision.day_count,
        },
        'RATE LIMIT CAP HIT — purchase paid but no grain issued; operator must refund',
      );
      await rateLimit.notifyCapHit(ctx.env.RATE_LIMIT_WEBHOOK, {
        product_id: product.id,
        reason: decision.reason,
        cap: decision.cap,
        hour_count: decision.hour_count,
        day_count: decision.day_count,
        purchase_id,
      });
      return c.json({ ok: true, rate_limited: true });
    }

    const result = await issueGrain({ ctx, purchase: row, product, amount_cents, currency });
    if (!result.ok) {
      // issueGrain has already marked the row failed and logged.
      return c.json({ ok: true, error: 'grain_issuance_failed' });
    }
    return c.json({ ok: true, pair_id: result.pair_id, issuer_side: result.issuer_side });
  });

  return app;
}
