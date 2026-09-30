// Grain issuance — one place to do the actual issuance work.
//
// Used by:
//   - routes/webhook.ts (Stripe payment success)
//   - routes/purchase.ts (gift redemption succeeds)
//   - routes/admin.ts   (manual mark-paid)
//
// All three flows do the same end-of-flow work: derive the per-grain
// passphrase, build the [ticket ...] envelope from the product config,
// call grain.establish, then mark the SQLite row paid. Anything that
// rolls back to "purchase failed" path needs the same UPDATE.

import { derivePassphrase } from './grain-passphrase.js';
import { buildTicket } from './envelope.js';
import { establish } from './grain.js';
import type { AppContext, Product } from '../types.js';
import type { PurchaseRow } from './db.js';

function bareAgent(id: string): string {
  return id.startsWith('agent:') ? id.slice('agent:'.length) : id;
}

// The handle a product's grains are reached from (product.issuer, else the agent).
export function issuerOf(ctx: AppContext, product: Product): string {
  return product.issuer ?? bareAgent(ctx.config.agent.id);
}

function ticketExpiry(now: Date, duration_days: number): string {
  const expiresAt = new Date(now.getTime() + duration_days * 24 * 60 * 60 * 1000);
  return expiresAt.toISOString().replace(/\.\d+Z$/, 'Z');
}

export type IssueInput = {
  ctx: AppContext;
  purchase: PurchaseRow;
  product: Product;
  amount_cents?: number; // optional — gift/manual may not have a price
  currency?: string;
  now?: Date;
};

export type IssueResult =
  | { ok: true; pair_id: string; issuer_side: '1' | '2'; envelope: string }
  | { ok: false; reason: string };

export async function issueGrain(input: IssueInput): Promise<IssueResult> {
  const { ctx, purchase, product } = input;
  const now = input.now ?? new Date();

  const issuer_bare = issuerOf(ctx, product);
  const buyer_bare = bareAgent(purchase.buyer_agent_id);
  const passphrase = derivePassphrase(ctx.env.TICKET_AGENT_SECRET, issuer_bare, buyer_bare);
  const envelope = buildTicket({
    face: product.face,
    scope: product.scope,
    expires: ticketExpiry(now, product.duration_days),
    ...(product.tier ? { tier: product.tier } : {}),
    nonce: purchase.id,
  });

  try {
    const grain = await establish({
      client: ctx.mcp,
      issuer_agent_id: issuer_bare,
      buyer_agent_id: buyer_bare,
      description: `Ticket: ${product.id} for ${buyer_bare}`,
      envelope,
      passphrase,
    });
    ctx.db
      .prepare(
        `UPDATE purchases
         SET status = 'paid',
             paid_at = ?,
             grain_pair_id = ?,
             amount_cents = COALESCE(?, amount_cents),
             currency = COALESCE(?, currency)
         WHERE id = ?`,
      )
      .run(
        now.toISOString(),
        grain.pair_id,
        input.amount_cents ?? null,
        input.currency ?? null,
        purchase.id,
      );
    ctx.log.info(
      {
        purchase_id: purchase.id,
        product_id: product.id,
        buyer_agent_id: purchase.buyer_agent_id,
        pair_id: grain.pair_id,
        issuer_side: grain.issuer_side,
        envelope,
      },
      'grain issued',
    );
    return { ok: true, pair_id: grain.pair_id, issuer_side: grain.issuer_side, envelope };
  } catch (err) {
    ctx.db
      .prepare("UPDATE purchases SET status = 'failed', notes = ? WHERE id = ?")
      .run(`grain establish failed: ${(err as Error).message}`, purchase.id);
    ctx.log.error(
      { purchase_id: purchase.id, product_id: product.id, err: (err as Error).message },
      'grain issuance FAILED',
    );
    return { ok: false, reason: (err as Error).message };
  }
}
