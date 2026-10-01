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
import { deriveCollectivePassphrase } from './audit.js';
import { randomUUID } from 'node:crypto';
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
  line?: string; // the buyer's own line, for a register_buyer product's list
};

export type IssueResult =
  | { ok: true; pair_id: string; issuer_side: '1' | '2'; envelope: string; registered?: string }
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
    const registered = product.register_buyer
      ? await registerBuyer(ctx, product, buyer_bare, input.line, now, purchase.id)
      : undefined;
    return { ok: true, pair_id: grain.pair_id, issuer_side: grain.issuer_side, envelope, ...(registered ? { registered } : {}) };
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

// A payment the machine holds no pending row for: a subscription's later
// period (product and buyer ride the subscription's metadata), an invoice the
// operator made by hand in the Stripe dashboard (the buyer in its "Beach
// handle" field; the product its metadata names, else the machine's only
// invoice-priced product), or any sale whose row was lost — Stripe is the
// record of the sale, so its metadata is enough. Each becomes its own purchase
// row, keyed by the original purchase id when Stripe carries one, and is
// idempotent on driver_ref: a re-delivered webhook, or a repair run twice,
// writes nothing new. A renewal re-reaches the same grain with a new expiry.
const HANDLE_RE = /^[a-zA-Z0-9_:.\-]{2,128}$/; // the buy form's own rule

export type PaymentInput = {
  purchase_id?: string;
  driver_ref: string;
  product_id: string | null;
  buyer_agent_id: string;
  amount_cents: number;
  currency: string;
  note: string;
};

export type PaymentResult =
  | { ok: true; issued: true; purchase_id: string; pair_id: string }
  | { ok: true; idempotent: true; purchase_id: string; pair_id: string | null }
  | { ok: true; ignored: string }
  | { ok: true; error: 'grain_issuance_failed'; reason: string };

export async function issueForPayment(ctx: AppContext, p: PaymentInput): Promise<PaymentResult> {
  const seen = ctx.db
    .prepare("SELECT id, status, grain_pair_id FROM purchases WHERE driver = 'stripe' AND driver_ref = ?")
    .get(p.driver_ref) as { id: string; status: string; grain_pair_id: string | null } | undefined;
  if (seen && seen.status === 'paid') return { ok: true, idempotent: true, purchase_id: seen.id, pair_id: seen.grain_pair_id };
  const invoiceProducts = ctx.config.products.filter((x) => x.price.driver === 'invoice');
  const product = p.product_id
    ? ctx.config.products.find((x) => x.id === p.product_id)
    : invoiceProducts.length === 1 ? invoiceProducts[0] : undefined;
  if (!product) {
    const reason = p.product_id ? 'unknown-product' : 'no-single-invoice-product';
    ctx.log.error({ ...p, reason }, 'payment names no product this machine sells — no grain issued');
    return { ok: true, ignored: reason };
  }
  if (!HANDLE_RE.test(p.buyer_agent_id)) {
    ctx.log.error({ ...p }, 'payment names a handle the buy form would refuse — no grain issued');
    return { ok: true, ignored: 'invalid-beach-handle' };
  }
  let purchase_id = seen?.id;
  if (!purchase_id) {
    purchase_id = p.purchase_id && !ctx.db.prepare('SELECT 1 FROM purchases WHERE id = ?').get(p.purchase_id) ? p.purchase_id : randomUUID();
    ctx.db
      .prepare(
        `INSERT INTO purchases (id, product_id, buyer_agent_id, status, driver, driver_ref, created_at, amount_cents, currency, notes)
         VALUES (?, ?, ?, 'pending', 'stripe', ?, ?, ?, ?, ?)`,
      )
      .run(purchase_id, product.id, p.buyer_agent_id, p.driver_ref, new Date().toISOString(), p.amount_cents, p.currency, p.note);
  } else {
    ctx.db.prepare('UPDATE purchases SET notes = ? WHERE id = ?').run(p.note, purchase_id);
  }
  const row = ctx.db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchase_id) as PurchaseRow;
  const result = await issueGrain({ ctx, purchase: row, product, amount_cents: p.amount_cents, currency: p.currency });
  if (!result.ok) return { ok: true, error: 'grain_issuance_failed', reason: result.reason };
  return { ok: true, issued: true, purchase_id, pair_id: result.pair_id };
}

// The list a register_buyer product keeps is its sed: collective — one entry
// per paid buyer, settled in order of arrival: the handle, the date, and their
// line if they left one. Never the amount: the list is the tier's. The entry
// is written under a passphrase derived from TICKET_AGENT_SECRET, as the audit
// log's are. A list that cannot be written never undoes the ticket: the
// failure is logged for the operator, and the payment and grain stand.
async function registerBuyer(
  ctx: AppContext,
  product: Product,
  buyer: string,
  line: string | undefined,
  now: Date,
  purchase_id: string,
): Promise<string | undefined> {
  const collective = product.sed.replace(/^sed:/, '');
  const date = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const declaration = `${buyer} — ${date}` + (line ? ` — \u201c${line}\u201d` : '');
  try {
    const text = await ctx.mcp.callTool('pscale_settle', {
      collective,
      declaration,
      passphrase: deriveCollectivePassphrase(ctx.env.TICKET_AGENT_SECRET, collective, 'entry'),
    });
    const m = /sed:[^:\s]+:(\d+)\b/.exec(text);
    if (!m) throw new Error(text.slice(0, 200));
    ctx.log.info({ purchase_id, product_id: product.id, buyer, address: m[0] }, 'buyer written onto the list');
    return m[0];
  } catch (err) {
    ctx.log.error({ purchase_id, product_id: product.id, buyer, err: (err as Error).message }, 'list entry FAILED — ticket stands; write it by hand');
    return undefined;
  }
}

