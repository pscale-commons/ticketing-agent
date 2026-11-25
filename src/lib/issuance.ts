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
import { buildTicket, buildVerified } from './envelope.js';
import { establish } from './grain.js';
import { appendDecision, deriveCollectivePassphrase } from './audit.js';
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
  | { ok: true; pair_id: string; issuer_side: '1' | '2'; envelope: string; registered?: string; minted?: string }
  | { ok: false; reason: string };

// The credits a payment mints: every whole penny counts, rounded down, so £5
// at 1,000 a pound is 5,000. Nothing is minted without an amount.
export function creditsFor(product: Product, amount_cents: number | undefined | null): number {
  if (!product.credits || !amount_cents || amount_cents <= 0) return 0;
  return Math.floor((amount_cents * product.credits.per_pound) / 100);
}

// One grain stands per (issuer, buyer) pair, so a buyer's second top-up
// re-reaches the same ticket. Its credits= is therefore the WHOLE the grain
// backs — every earlier paid mint on it and this one — since a reader nets
// every gift citing the grain against that number (bsp-mcp verifyGrainMint).
function mintedBefore(ctx: AppContext, issuer: string, purchase: PurchaseRow): number {
  const rows = ctx.db
    .prepare("SELECT product_id, amount_cents FROM purchases WHERE buyer_agent_id = ? AND status = 'paid' AND id != ?")
    .all(purchase.buyer_agent_id, purchase.id) as Array<{ product_id: string; amount_cents: number | null }>;
  let n = 0;
  for (const r of rows) {
    const p = ctx.config.products.find((x) => x.id === r.product_id);
    if (p && p.credits && issuerOf(ctx, p) === issuer) n += creditsFor(p, r.amount_cents);
  }
  return n;
}

export async function issueGrain(input: IssueInput): Promise<IssueResult> {
  const { ctx, purchase, product } = input;
  const now = input.now ?? new Date();

  const issuer_bare = issuerOf(ctx, product);
  const buyer_bare = bareAgent(purchase.buyer_agent_id);
  const passphrase = derivePassphrase(ctx.env.TICKET_AGENT_SECRET, issuer_bare, buyer_bare);
  const minting = creditsFor(product, input.amount_cents ?? purchase.amount_cents);
  const envelope = buildTicket({
    face: product.face,
    scope: product.scope,
    expires: ticketExpiry(now, product.duration_days),
    ...(product.tier ? { tier: product.tier } : {}),
    nonce: purchase.id,
    ...(minting > 0 ? { credits: minting + mintedBefore(ctx, issuer_bare, purchase) } : {}),
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
      ? await registerBuyer(ctx, product, buyer_bare, input.line, now, purchase.id, input.amount_cents ?? purchase.amount_cents ?? undefined)
      : undefined;
    const minted = minting > 0
      ? await mintCredits(ctx, product, issuer_bare, buyer_bare, purchase.id, grain.pair_id, minting, now, input.amount_cents ?? purchase.amount_cents ?? 0)
      : undefined;
    return {
      ok: true, pair_id: grain.pair_id, issuer_side: grain.issuer_side, envelope,
      ...(registered ? { registered } : {}), ...(minted ? { minted } : {}),
    };
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
  amount_cents?: number,
): Promise<string | undefined> {
  if (product.sed.includes('{pscale}') && !(amount_cents && amount_cents >= 100)) {
    ctx.log.error({ purchase_id, product_id: product.id, buyer }, 'list chosen by amount, but no amount — write the entry by hand');
    return undefined;
  }
  const collective = product.sed.replace(/^sed:/, '').replace('{pscale}', String(pscaleOf(amount_cents ?? 0)));
  const date = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const declaration = `${buyer} — ${date}` + (line ? ` — \u201c${line}\u201d` : '');
  if (product.list_block) return appendToList(ctx, product, product.list_block, declaration, purchase_id, buyer);
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

// A LIST ONLY THIS MACHINE WRITES: an ordinary block at the beach, founded
// latched to a key derived from TICKET_AGENT_SECRET the first time it is
// needed, and appended to under that key ever after — so no one else can add a
// line that a keeper would count as a seat. The founding write carries no
// secret: over a list already latched it is refused and changes nothing, and
// only where nothing stands does it create the block.
async function appendToList(
  ctx: AppContext,
  product: Product,
  block: string,
  declaration: string,
  purchase_id: string,
  buyer: string,
): Promise<string | undefined> {
  const beach = ctx.config.agent.beach ?? 'https://beach.happyseaurchin.com';
  const key = deriveCollectivePassphrase(ctx.env.TICKET_AGENT_SECRET, block, 'entry');
  try {
    await ctx.mcp.callTool('bsp', {
      agent_id: beach, block, new_lock: key,
      content: { _: `${product.title ?? product.id} — each entry below is one, in the order they arrived: the name it was bought for, the date, and a line of the buyer's own if they left one; never the amount. Written by the ticket machine alone, under its own key.` },
    }).catch(() => '');
    const text = await ctx.mcp.callTool('bsp', { agent_id: beach, block, append: true, content: { _: declaration }, secret: key });
    const m = /→\s*([0-9.]+)/.exec(text);
    if (!m) throw new Error(text.slice(0, 200));
    ctx.log.info({ purchase_id, product_id: product.id, buyer, address: `${block}:${m[1]}` }, 'buyer written onto the list');
    return `${block}:${m[1]}`;
  } catch (err) {
    ctx.log.error({ purchase_id, product_id: product.id, buyer, err: (err as Error).message }, 'list entry FAILED — ticket stands; write it by hand');
    return undefined;
  }
}

// THE MINT (sand-v2 2, mint-as-gave): the credits a payment buys come into
// being as one gift on the issuer's own passport at 6.3 — {_ its voicing,
// 1 probe id, 2 n, 3 to, 4 topic, 5 stamp, 6 the grain, 7 its audit line} —
// the shape bsp-mcp's sand.ts reads. Three writes, in the order a reader
// checks them (verifyGrainMint): the ticket already carries credits=N; the
// audit log marks that grain verified; the gift names both. The passport is
// founded latched to a key derived from TICKET_AGENT_SECRET the first time,
// as the machine's lists are, so no other hand can give in the mint's name.
// A mint that cannot be written never undoes the ticket: the grain backs the
// credits, and the failure is logged for the operator to give them by hand.
// The voicing names what was paid into and the sum, never the payer.
async function mintCredits(
  ctx: AppContext,
  product: Product,
  issuer: string,
  buyer: string,
  purchase_id: string,
  pair_id: string,
  n: number,
  now: Date,
  amount_cents: number,
): Promise<string | undefined> {
  const beach = ctx.config.agent.beach ?? 'https://beach.happyseaurchin.com';
  const to = product.credits?.to ?? buyer;
  const topic = product.credits?.topic ?? '0.1';
  const grainRef = `grain:${pair_id}`;
  const at = now.toISOString().replace(/\.\d+Z$/, 'Z');
  const block = `passport:${issuer}`;
  const key = deriveCollectivePassphrase(ctx.env.TICKET_AGENT_SECRET, block, 'entry');
  try {
    const audit = await appendDecision({
      client: ctx.mcp,
      ticketAgentSecret: ctx.env.TICKET_AGENT_SECRET,
      verifier_bare_id: bareAgent(ctx.config.agent.id),
      envelope: buildVerified({ by: ctx.config.agent.id, at, grain: grainRef }),
      date: now,
    });
    const auditRef = `sed:${audit.audit_block}:${audit.audit_position}`;
    await ctx.mcp.callTool('bsp', {
      agent_id: beach, block, new_lock: key,
      content: {
        _: `${issuer} — a mint of the ticket machine: the one place money paid at it becomes credits (sand-v2 1.1). Every gift at 6.3 is backed by the ticket grain it names and the audit line that marks it verified, never by this ledger's balance, which reads as negative as the credits it has put into circulation. Written by the machine alone, under its own key.`,
        '6': { _: 'The SAND ledgers (sand-v2): 3, the mint’s gifts.', '3': { _: 'Every credit this mint has given, in the order given.' } },
      },
    }).catch(() => '');
    const pounds = `£${(amount_cents / 100).toFixed(2)}`;
    const address = await appendOnShelf(ctx, beach, block, key, {
      _: `minted ${n} to ${to} — ${product.title ?? product.id}, ${pounds} paid at the ticket machine; these credits stand on ${grainRef} and its audit line, not on this ledger's balance`,
      '1': `mint-${purchase_id}`,
      '2': n,
      '3': to,
      '4': topic,
      '5': at,
      '6': grainRef,
      '7': auditRef,
    });
    ctx.log.info({ purchase_id, product_id: product.id, n, to, address: `${block}:${address}`, audit: auditRef }, 'credits minted');
    return `${block}:${address}`;
  } catch (err) {
    ctx.log.error({ purchase_id, product_id: product.id, n, to, err: (err as Error).message }, 'mint FAILED — ticket stands and backs the credits; give them by hand');
    return undefined;
  }
}

// A GIFT ON A SHELF: a digit position holds nine and never grows (the beach
// refuses a tenth append beneath it, node_full), and a gift's own fields fill
// the digits beneath it, so gifts appended straight under 6.3 would stop at
// nine. They go on shelves instead — 6.31 holds the first nine, 6.32 the next
// — eighty-one in all, each shelf founded the first time it is needed. A
// shelf is no gift, so every reader walks through it (bsp-mcp collectGaves).
// The append only ALLOCATES the slot: the beach stamps an appended entry's
// field 3 with its arrival time unless 3 already holds a date (block-
// conventions 4.22), and a gift keeps its recipient at 3, so the gift is then
// written whole at the address it landed in, which is never stamped.
async function appendOnShelf(
  ctx: AppContext,
  beach: string,
  block: string,
  key: string,
  content: Record<string, unknown>,
): Promise<string> {
  const landed = (text: string) => /→\s*([0-9.]+)/.exec(text)?.[1];
  const settle = async (address: string) => {
    const text = await ctx.mcp.callTool('bsp', { agent_id: beach, block, spindle: address, secret: key, content });
    if (/rejected|refused/i.test(text)) throw new Error(`the gift at ${address} could not be written whole: ${text.slice(0, 160)}`);
    return address;
  };
  for (let k = 1; k <= 9; k++) {
    const spindle = `6.3${k}`;
    const put = () => ctx.mcp.callTool('bsp', { agent_id: beach, block, spindle, append: true, secret: key, content });
    let text = await put();
    let at = landed(text);
    if (at) return settle(at);
    if (/no node at|not_found/i.test(text)) {
      await ctx.mcp.callTool('bsp', {
        agent_id: beach, block, spindle, secret: key,
        content: { _: `Shelf ${k} of the mint's gifts: nine to a shelf, in the order given.` },
      });
      text = await put();
      at = landed(text);
      if (at) return settle(at);
    }
    if (!/node_full|is full/i.test(text)) throw new Error(text.slice(0, 200));
  }
  throw new Error(`${block} 6.3 is full: nine shelves of nine gifts`);
}

// The place-value of a sum's first digit, in whole pounds: £50 → 1, £500 → 2,
// £1,000 → 3. A sum is already a pscale number; this reads its scale.
export function pscaleOf(amount_cents: number): number {
  return String(Math.floor(amount_cents / 100)).length - 1;
}

