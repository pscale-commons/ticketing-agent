// Admin routes — operator-only, gated by ADMIN_TOKEN bearer auth.
//
// M3 landed read + rate-limit endpoints.
// M5 lands /refund/:id — Stripe refund + grain revoke + row update.
// M6 will add gift/manual mark-paid endpoints.
//
// All admin routes require: `Authorization: Bearer <ADMIN_TOKEN>`.

import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../types.js';
import type { PurchaseRow } from '../lib/db.js';
import * as rateLimit from '../lib/rate-limit.js';
import { buildRevoked } from '../lib/envelope.js';
import { revoke, determineSide } from '../lib/grain.js';
import { derivePassphrase } from '../lib/grain-passphrase.js';
import { issueGrain, issuerOf } from '../lib/issuance.js';

function bareAgent(id: string): string {
  return id.startsWith('agent:') ? id.slice('agent:'.length) : id;
}

function nowIso(now: Date): string {
  return now.toISOString().replace(/\.\d+Z$/, 'Z');
}

export function adminRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const auth = c.req.header('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
    if (token !== ctx.env.ADMIN_TOKEN) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  });

  app.get('/purchases', (c) => {
    const status = c.req.query('status');
    const limit = Math.min(Number(c.req.query('limit') ?? '50'), 500);
    const rows = (
      status
        ? ctx.db
            .prepare('SELECT * FROM purchases WHERE status = ? ORDER BY created_at DESC LIMIT ?')
            .all(status, limit)
        : ctx.db.prepare('SELECT * FROM purchases ORDER BY created_at DESC LIMIT ?').all(limit)
    ) as PurchaseRow[];
    return c.json({ purchases: rows });
  });

  app.get('/purchases/:id', (c) => {
    const row = ctx.db
      .prepare('SELECT * FROM purchases WHERE id = ?')
      .get(c.req.param('id')) as PurchaseRow | undefined;
    if (!row) return c.json({ error: 'not_found' }, 404);
    return c.json(row);
  });

  app.get('/rate-limit/:product_id', (c) => {
    const product = ctx.config.products.find((p) => p.id === c.req.param('product_id'));
    if (!product) return c.json({ error: 'unknown_product' }, 404);
    const decision = rateLimit.check(ctx.db, product);
    return c.json({ product_id: product.id, rate_limit: product.rate_limit ?? null, decision });
  });

  // POST /admin/refund/:id — refund a paid or rate_limited purchase.
  //
  //   * `paid`         → Stripe refund + grain revoke ([ticket-revoked at=... reason=...])
  //                      The verifier picks up the revocation on its next tick and
  //                      writes a fresh [ticket-rejected reason=revoked] audit entry.
  //   * `rate_limited` → Stripe refund only (no grain was issued).
  //   * any other status → 400.
  //
  // Body (optional): { "reason": "<short>" } — appears in the [ticket-revoked] envelope.
  app.post('/refund/:id', async (c) => {
    const purchase_id = c.req.param('id');
    const row = ctx.db
      .prepare('SELECT * FROM purchases WHERE id = ?')
      .get(purchase_id) as PurchaseRow | undefined;
    if (!row) return c.json({ error: 'not_found' }, 404);
    if (row.status !== 'paid' && row.status !== 'rate_limited') {
      return c.json({ error: 'cannot_refund', status: row.status }, 400);
    }

    const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
    const reason = typeof body.reason === 'string' && body.reason.length > 0 ? body.reason : 'admin-refund';
    if (/\s/.test(reason)) {
      return c.json({ error: 'reason_must_not_contain_whitespace' }, 400);
    }

    // 1. Stripe refund (if applicable).
    let refund_id: string | null = null;
    if (row.driver === 'stripe') {
      if (!ctx.stripeDriver) {
        return c.json({ error: 'stripe_not_configured' }, 500);
      }
      if (!row.driver_ref) {
        return c.json({ error: 'no_driver_ref_on_purchase' }, 500);
      }
      try {
        const result = await ctx.stripeDriver.createRefund({ driver_ref: row.driver_ref, reason });
        refund_id = result.refund_id;
      } catch (err) {
        ctx.log.error(
          { purchase_id, err: (err as Error).message },
          'admin/refund: stripe refund failed',
        );
        return c.json({ error: 'stripe_refund_failed' }, 502);
      }
    }

    // 2. Grain revoke — only if a grain was actually issued (status === 'paid').
    let revoked = false;
    if (row.status === 'paid' && row.grain_pair_id) {
      const product = ctx.config.products.find((p) => p.id === row.product_id);
      const issuer_bare = product ? issuerOf(ctx, product) : bareAgent(ctx.config.agent.id);
      const buyer_bare = bareAgent(row.buyer_agent_id);
      const passphrase = derivePassphrase(ctx.env.TICKET_AGENT_SECRET, issuer_bare, buyer_bare);
      const issuer_side = determineSide(issuer_bare, buyer_bare);
      const revocation = buildRevoked({ at: nowIso(new Date()), reason });
      try {
        await revoke({
          client: ctx.mcp,
          pair_id: row.grain_pair_id,
          issuer_side,
          passphrase,
          revocation,
        });
        revoked = true;
      } catch (err) {
        ctx.log.error(
          { purchase_id, pair_id: row.grain_pair_id, err: (err as Error).message },
          'admin/refund: stripe refunded but grain revoke FAILED — operator must reconcile',
        );
        // Stripe refund already succeeded; we don't unwind it. Mark the row
        // refunded so we don't double-refund, and surface the inconsistency.
        ctx.db
          .prepare(
            "UPDATE purchases SET status = 'refunded', refunded_at = ?, notes = ? WHERE id = ?",
          )
          .run(
            new Date().toISOString(),
            `refunded but grain revoke failed: ${(err as Error).message}`,
            purchase_id,
          );
        return c.json({ error: 'grain_revoke_failed', stripe_refunded: true, refund_id }, 502);
      }
    }

    // 3. Update the purchase row.
    ctx.db
      .prepare(
        "UPDATE purchases SET status = 'refunded', refunded_at = ?, notes = ? WHERE id = ?",
      )
      .run(
        new Date().toISOString(),
        `refunded via /admin/refund: ${reason}` + (refund_id ? ` (stripe ${refund_id})` : ''),
        purchase_id,
      );

    ctx.log.info(
      {
        purchase_id,
        product_id: row.product_id,
        buyer_agent_id: row.buyer_agent_id,
        pair_id: row.grain_pair_id,
        refund_id,
        revoked,
        reason,
      },
      'admin/refund: complete',
    );

    return c.json({
      ok: true,
      purchase_id,
      refund_id,
      revoked,
      pair_id: row.grain_pair_id,
    });
  });

  // POST /admin/invoice — raise a Stripe invoice for an invoice-priced
  // product. Body: { product_id, buyer_agent_id, email, name?, amount_cents,
  // description, send? }. amount_cents is in the currency's minor unit
  // (pence for gbp). send=false (the default) leaves a draft to review and
  // send from the Stripe dashboard; send=true finalises and emails it. The
  // grain is issued when Stripe reports the invoice paid (invoice.paid).
  app.post('/invoice', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const product = ctx.config.products.find((p) => p.id === body.product_id);
    if (!product) return c.json({ error: 'unknown_product' }, 404);
    if (product.price.driver !== 'invoice') return c.json({ error: 'not_an_invoice_product' }, 400);
    const buyer_agent_id = body.buyer_agent_id;
    const email = body.email;
    const amount_cents = body.amount_cents;
    const description = body.description;
    if (typeof buyer_agent_id !== 'string' || !/^[a-zA-Z0-9_:.\-]{2,128}$/.test(buyer_agent_id)) {
      return c.json({ error: 'invalid_buyer_agent_id' }, 400);
    }
    if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(email)) return c.json({ error: 'invalid_email' }, 400);
    if (typeof amount_cents !== 'number' || !Number.isInteger(amount_cents) || amount_cents <= 0) {
      return c.json({ error: 'invalid_amount_cents' }, 400);
    }
    if (typeof description !== 'string' || description.length === 0) return c.json({ error: 'missing_description' }, 400);
    if (!ctx.stripeDriver?.createInvoice) return c.json({ error: 'stripe_not_configured' }, 500);

    const purchase_id = randomUUID();
    let result;
    try {
      result = await ctx.stripeDriver.createInvoice({
        purchase_id,
        product,
        buyer_agent_id,
        email,
        ...(typeof body.name === 'string' && body.name ? { name: body.name } : {}),
        amount_cents,
        description,
        send: body.send === true,
      });
    } catch (err) {
      ctx.log.error({ err: (err as Error).message, product_id: product.id }, 'admin/invoice: stripe invoice failed');
      return c.json({ error: 'invoice_creation_failed', reason: (err as Error).message }, 502);
    }
    ctx.db
      .prepare(
        `INSERT INTO purchases (id, product_id, buyer_agent_id, status, driver, driver_ref, created_at, amount_cents, currency, notes)
         VALUES (?, ?, ?, 'pending', 'stripe', ?, ?, ?, ?, ?)`,
      )
      .run(
        purchase_id,
        product.id,
        buyer_agent_id,
        result.driver_ref,
        new Date().toISOString(),
        amount_cents,
        product.price.currency,
        `invoice: ${description}`,
      );
    ctx.log.info({ purchase_id, product_id: product.id, buyer_agent_id, driver_ref: result.driver_ref }, 'admin/invoice: raised');
    return c.json({ ok: true, purchase_id, invoice: result.driver_ref, sent: body.send === true, hosted_url: result.hosted_url });
  });

  // POST /admin/mark-paid/:id — operator confirms a manual (bank transfer)
  // payment and the agent issues the grain. Body (optional): { "notes": "..." }.
  app.post('/mark-paid/:id', async (c) => {
    const purchase_id = c.req.param('id');
    const row = ctx.db
      .prepare('SELECT * FROM purchases WHERE id = ?')
      .get(purchase_id) as PurchaseRow | undefined;
    if (!row) return c.json({ error: 'not_found' }, 404);
    if (row.driver !== 'manual') return c.json({ error: 'not_a_manual_purchase', driver: row.driver }, 400);
    if (row.status === 'paid') return c.json({ ok: true, idempotent: true, purchase_id });
    if (row.status !== 'pending') return c.json({ error: 'cannot_mark_paid', status: row.status }, 400);

    const product = ctx.config.products.find((p) => p.id === row.product_id);
    if (!product) return c.json({ error: 'unknown_product' }, 500);

    const decision = rateLimit.check(ctx.db, product);
    if (!decision.allowed) {
      ctx.db
        .prepare("UPDATE purchases SET status = 'rate_limited', notes = ? WHERE id = ?")
        .run(
          `rate-limit cap-hit at mark-paid: ${decision.reason} (cap=${decision.cap}, hour=${decision.hour_count}, day=${decision.day_count})`,
          purchase_id,
        );
      ctx.log.error(
        { purchase_id, product_id: product.id, reason: decision.reason },
        'mark-paid: cap hit; payment received but no grain issued — operator must reconcile',
      );
      return c.json({ error: 'rate_limited', reason: decision.reason }, 429);
    }

    const body = (await c.req.json().catch(() => ({}))) as { notes?: unknown };
    if (typeof body.notes === 'string' && body.notes.length > 0) {
      ctx.db.prepare('UPDATE purchases SET notes = ? WHERE id = ?').run(body.notes, purchase_id);
    }
    const fresh = ctx.db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchase_id) as PurchaseRow;

    const result = await issueGrain({ ctx, purchase: fresh, product });
    if (!result.ok) {
      return c.json({ error: 'grain_issuance_failed', reason: result.reason }, 502);
    }
    return c.json({ ok: true, purchase_id, pair_id: result.pair_id, issuer_side: result.issuer_side });
  });

  return app;
}
