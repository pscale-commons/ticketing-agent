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
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../types.js';
import type { PurchaseRow } from '../lib/db.js';
import { WebhookSignatureError } from '../drivers/types.js';
import type { WebhookEvent } from '../drivers/types.js';
import * as rateLimit from '../lib/rate-limit.js';
import { issueGrain } from '../lib/issuance.js';

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

    if (event.kind === 'renewal' || event.kind === 'dashboard-invoice') {
      return c.json(await issueForPaidInvoice(ctx, event));
    }

    const { purchase_id, driver_ref, amount_cents, currency } = event;

    const row = ctx.db
      .prepare('SELECT * FROM purchases WHERE id = ?')
      .get(purchase_id) as PurchaseRow | undefined;

    if (!row) {
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

// A paid invoice the machine holds no pending row for: a subscription's later
// period (product and buyer ride the subscription's metadata), or an invoice
// the operator made by hand in the Stripe dashboard (the buyer in its "Beach
// handle" field; the product the one its metadata names, else the machine's
// only invoice-priced product). Each is its own purchase row, driver_ref the
// invoice, so a re-delivered webhook is a no-op. A renewal re-reaches the same
// grain: the issuer side's envelope is rewritten with the new expiry, and the
// buyer's registration keeps citing one grain.
const HANDLE_RE = /^[a-zA-Z0-9_:.\-]{2,128}$/; // the buy form's own rule

async function issueForPaidInvoice(
  ctx: AppContext,
  event: Extract<WebhookEvent, { kind: 'renewal' | 'dashboard-invoice' }>,
): Promise<Record<string, unknown>> {
  const seen = ctx.db
    .prepare("SELECT id FROM purchases WHERE driver = 'stripe' AND driver_ref = ?")
    .get(event.driver_ref) as { id: string } | undefined;
  if (seen) return { ok: true, idempotent: true };
  const invoiceProducts = ctx.config.products.filter((p) => p.price.driver === 'invoice');
  const product = event.product_id
    ? ctx.config.products.find((p) => p.id === event.product_id)
    : invoiceProducts.length === 1 ? invoiceProducts[0] : undefined;
  if (!product) {
    const reason = event.product_id ? 'unknown-product' : 'no-single-invoice-product';
    ctx.log.error({ ...event, reason }, 'paid invoice names no product this machine sells — no grain issued');
    return { ok: true, ignored: reason };
  }
  if (!HANDLE_RE.test(event.buyer_agent_id)) {
    ctx.log.error({ ...event }, 'paid invoice names a handle the buy form would refuse — no grain issued');
    return { ok: true, ignored: 'invalid-beach-handle' };
  }
  const purchase_id = randomUUID();
  ctx.db
    .prepare(
      `INSERT INTO purchases (id, product_id, buyer_agent_id, status, driver, driver_ref, created_at, notes)
       VALUES (?, ?, ?, 'pending', 'stripe', ?, ?, ?)`,
    )
    .run(
      purchase_id,
      product.id,
      event.buyer_agent_id,
      event.driver_ref,
      new Date().toISOString(),
      event.kind === 'renewal' ? 'subscription renewal' : 'dashboard invoice',
    );
  const row = ctx.db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchase_id) as PurchaseRow;
  const result = await issueGrain({ ctx, purchase: row, product, amount_cents: event.amount_cents, currency: event.currency });
  if (!result.ok) return { ok: true, error: 'grain_issuance_failed' };
  return { ok: true, ...(event.kind === 'renewal' ? { renewed: true } : { issued: true }), pair_id: result.pair_id };
}
